import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { getSampler } from '../render/gpu-cache.js';
import shader from './hydraulic-erosion.wgsl';

// GPU hydraulic-erosion sim. Walks N drops in parallel across the input
// heightfield texture, atomic-accumulating deposits and erosions into a
// shared fixed-point buffer, then writes the result back to a fresh
// texture in the SAME format as the input. The output is a filter-style
// in→out texture; the worldSize the texture represents is owned by the
// downstream consumer node ([core/texture-to-heightfield-mesh](../../core/texture-to-heightfield-mesh)
// / [terrain/renderer](../../terrain/renderer)).
//
// Notable choices:
//   • Fixed-point i32 atomics (scale 2^20) — storage textures can't
//     atomic-store and float accumulation with race conditions visibly
//     drifts; fixed-point integer atomics are deterministic.
//   • Two shader variants by string substitution: one for rgba8unorm
//     output, one for rgba16float, so the filter preserves format.
//   • Brush radius spreads each erosion event across a small disc so
//     channels carve smoothly instead of pin-pricked.
//   • Defaults chosen to look like recognisable erosion at ~30k drops
//     on a 256² heightfield in <50 ms — feels live under slider scrub.
const WORKGROUP_SIM = 64;
const WORKGROUP_TEX = 8;

type SupportedFormat = 'rgba8unorm' | 'rgba16float';

interface CachedState {
  texture?: Texture2DValue;
  __uniformBuffer?: GPUBuffer;
  __heightBuffer?: GPUBuffer;
  __format?: SupportedFormat;
}

interface PipelineSet {
  initPipeline: GPUComputePipeline;
  simPipeline: GPUComputePipeline;
  writePipeline: GPUComputePipeline;
  layout: GPUBindGroupLayout;
}

const pipelineCacheByDevice = new WeakMap<GPUDevice, Map<SupportedFormat, PipelineSet>>();

function getPipelines(device: GPUDevice, format: SupportedFormat): PipelineSet {
  let byFormat = pipelineCacheByDevice.get(device);
  if (!byFormat) {
    byFormat = new Map();
    pipelineCacheByDevice.set(device, byFormat);
  }
  const existing = byFormat.get(format);
  if (existing) return existing;

  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        storageTexture: { access: 'write-only', format, viewDimension: '2d' },
      },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const code = shader.replace(/\{\{STORAGE_FORMAT\}\}/g, format);
  const module = device.createShaderModule({ code });
  const make = (entryPoint: string) =>
    device.createComputePipeline({
      layout: pipelineLayout,
      compute: { module, entryPoint },
    });
  const set: PipelineSet = {
    initPipeline: make('init'),
    simPipeline: make('simulate'),
    writePipeline: make('writeback'),
    layout,
  };
  byFormat.set(format, set);
  return set;
}

function pickFormat(srcFormat: GPUTextureFormat): SupportedFormat {
  return srcFormat === 'rgba16float' ? 'rgba16float' : 'rgba8unorm';
}

export const hydraulicErosionNode: NodeDef = {
  id: 'terrain/hydraulic-erosion',
  category: 'Terrain',
  inputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'source heightfield texture to erode. R channel is the height; format is preserved in the output (rgba8unorm or rgba16float). For real altitudes in metres use rgba16float — see [core/texture-convert](../../core/texture-convert)',
    },
    {
      name: 'drops',
      type: 'Int',
      default: 30000,
      description:
        'total number of water drops simulated in parallel. Higher = more pronounced erosion features and more compute. ~30k feels live at 256² resolution',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 1,
      description: 'stochastic-spawn seed; vary to get a different erosion pattern from the same heightfield',
    },
    {
      name: 'max_lifetime',
      type: 'Int',
      default: 30,
      description: 'maximum simulation steps per drop. Higher = longer streams, more pronounced channels',
    },
    {
      name: 'inertia',
      type: 'Float',
      default: 0.05,
      description: 'how much each drop\'s direction resists change. 0 = pure-downhill flow (jittery); 1 = momentum dominates (drops shoot off cliffs). ~0.05 looks right',
    },
    {
      name: 'capacity',
      type: 'Float',
      default: 0.5,
      description: 'sediment-carrying capacity multiplier. Higher = drops carry more before depositing — deeper channels. Default tuned for typical metres-scale heightfields (e.g. heights in [0, ~100 m]); for a heightfield in [0, 1] (legacy / normalised) you\'d want ~30× this value to get comparable carving',
    },
    {
      name: 'deposition',
      type: 'Float',
      default: 0.3,
      description: '0..1, fraction of excess sediment dropped per step where capacity is exceeded',
    },
    {
      name: 'erosion',
      type: 'Float',
      default: 0.3,
      description: '0..1, fraction of unused capacity removed from terrain per step',
    },
    {
      name: 'evaporation',
      type: 'Float',
      default: 0.01,
      description: 'fraction of water lost per step; controls how far drops travel before drying up',
    },
    {
      name: 'gravity',
      type: 'Float',
      default: 4,
      description: 'pull on downhill drops; higher = faster drops = more erosion per step',
    },
    {
      name: 'min_slope',
      type: 'Float',
      default: 0.01,
      description: 'capacity floor so drops on flat ground still carry sediment instead of immediately depositing',
    },
    {
      name: 'brush_radius',
      type: 'Int',
      default: 3,
      description: 'pixel radius for each erosion event; small brush = sharp channels, larger = broader valleys',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'eroded heightfield texture: same resolution and format as the input, but with rain-carved channels and deposited sediment',
    },
  ],
  doc: {
    summary: 'Simulate raindrops carving channels into a heightfield texture (Beyer/Marák style).',
    description: `
A GPU port of the parallel raindrop-erosion algorithm: spawn \`drops\`
water drops at random positions, let each one flow downhill along the
height gradient, pick up sediment from steep sections, deposit it
where the terrain flattens, and stop when the drop runs out of water
(evaporation) or lifetime. The cumulative effect is realistic-looking
erosion patterns — dendritic river networks, alluvial fans where the
terrain levels off, sharpened ridges.

All drops simulate in parallel via compute shaders, so even tens of
thousands of drops on a 256² heightfield runs in a single frame and
the result re-evaluates live as you tune the parameters.

Tuning notes:
- More \`drops\` and \`max_lifetime\` → more pronounced channels but
  diminishing returns past about 30k drops × 30 steps.
- Higher \`erosion\` cuts deeper but can blow out the silhouette;
  balance with \`deposition\` to keep the volume conserved.
- Small \`brush_radius\` (1–3) gives knife-thin channels; larger
  values (6–10) give broad meandering valleys.
- For erosion that looks like wind shaping a desert instead of
  rivers carving mountains, drop \`gravity\` and crank \`evaporation\`.

Output format matches the input format. Wire the result into
[core/texture-to-heightfield-mesh](../../core/texture-to-heightfield-mesh)
or [terrain/renderer](../../terrain/renderer).
`,
    sampleGraph: () => {
      const g = createGraph();
      const noise = addNode(g, 'core/ridged-noise', {
        id: 'noise',
        position: { x: 0, y: 0 },
        inputValues: { scale: [3, 3], octaves: 5, lacunarity: 2, gain: 0.5, seed: 0, resolution: 256 },
      });
      const toFloat = addNode(g, 'core/texture-convert', {
        id: 'toFloat',
        position: { x: 280, y: 0 },
        inputValues: { format: 1 },
      });
      const remap = addNode(g, 'core/texture-map-range', {
        id: 'remap',
        position: { x: 560, y: 0 },
        inputValues: { in_min: 0, in_max: 1, out_min: 0, out_max: 2, clamp: false },
      });
      const ero = addNode(g, 'terrain/hydraulic-erosion', {
        id: 'erosion',
        position: { x: 840, y: 0 },
        inputValues: {
          drops: 30000, seed: 1, max_lifetime: 30, inertia: 0.05,
          capacity: 4, deposition: 0.3, erosion: 0.3, evaporation: 0.01,
          gravity: 4, min_slope: 0.01, brush_radius: 3,
        },
      });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: toFloat.id, socket: 'texture' });
      addEdge(g, { node: toFloat.id, socket: 'texture' }, { node: remap.id, socket: 'texture' });
      addEdge(g, { node: remap.id, socket: 'texture' }, { node: ero.id, socket: 'texture' });
      return { graph: g, rootNodeId: 'erosion' };
    },
  },
  evaluate(ctx, inputs) {
    const device = requireDevice(ctx);
    const srcTex = inputs.texture as Texture2DValue;
    const width = srcTex.width;
    const height = srcTex.height;
    const format = pickFormat(srcTex.format);

    const prev = ctx.previousOutput as CachedState | undefined;
    // If the output format changed (because the input format changed),
    // we have to abandon the cached texture — it has the wrong format.
    const reusableTexCandidate = prev?.__format === format ? prev?.texture : undefined;
    const out = reusableTexture(device, reusableTexCandidate, {
      width,
      height,
      format,
      usage:
        GPUTextureUsage.STORAGE_BINDING |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Pack params for the compute shaders.
    const buf = new ArrayBuffer(64);
    const u32 = new Uint32Array(buf);
    const f32 = new Float32Array(buf);
    u32[0] = width;
    u32[1] = height;
    u32[2] = Math.max(0, Math.round(inputs.drops as number));
    // Convert float seed → u32 so the WGSL hash gets distinct values per
    // (drop, seed). Multiply by a prime so similar fractional seeds
    // produce visibly different patterns.
    u32[3] = Math.floor(((inputs.seed as number) * 1009) >>> 0) || 1;
    f32[4] = inputs.inertia as number;
    f32[5] = inputs.capacity as number;
    f32[6] = inputs.deposition as number;
    f32[7] = inputs.erosion as number;
    f32[8] = inputs.evaporation as number;
    f32[9] = inputs.gravity as number;
    f32[10] = inputs.min_slope as number;
    u32[11] = Math.max(1, Math.round(inputs.max_lifetime as number));
    u32[12] = Math.max(0, Math.round(inputs.brush_radius as number));

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer,
      buf,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Atomic<i32> storage buffer for the eroded heights. 4 bytes per
    // texel. Reused across re-evals when dims are unchanged — re-init
    // each eval, so contents from a previous run don't leak in.
    const heightBufBytes = width * height * 4;
    let heightBuffer = prev?.__heightBuffer;
    if (!heightBuffer || heightBuffer.size !== heightBufBytes) {
      heightBuffer?.destroy();
      heightBuffer = device.createBuffer({
        size: heightBufBytes,
        usage: GPUBufferUsage.STORAGE,
      });
    }

    const { initPipeline, simPipeline, writePipeline, layout } = getPipelines(device, format);
    const sampler = getSampler(device, {
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: heightBuffer },
        { binding: 2, resource: srcTex.texture },
        { binding: 3, resource: sampler },
        { binding: 4, resource: out.texture.createView() },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setBindGroup(0, bindGroup);
    // 1. Init the fixed-point buffer from the source texture.
    pass.setPipeline(initPipeline);
    pass.dispatchWorkgroups(
      Math.ceil(width / WORKGROUP_TEX),
      Math.ceil(height / WORKGROUP_TEX),
    );
    // 2. Simulate drops. One workgroup of 64 threads per chunk; total
    // threads ≥ drops (excess threads early-return).
    const drops = u32[2];
    if (drops > 0) {
      pass.setPipeline(simPipeline);
      pass.dispatchWorkgroups(Math.ceil(drops / WORKGROUP_SIM));
    }
    // 3. Write the eroded buffer into the output texture.
    pass.setPipeline(writePipeline);
    pass.dispatchWorkgroups(
      Math.ceil(width / WORKGROUP_TEX),
      Math.ceil(height / WORKGROUP_TEX),
    );
    pass.end();
    device.queue.submit([encoder.finish()]);

    return {
      texture: out,
      __uniformBuffer: uniformBuffer,
      __heightBuffer: heightBuffer,
      __format: format,
    };
  },
};
