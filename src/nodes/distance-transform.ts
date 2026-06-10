import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { ShaderStage, getPipelineWithLayout, getSampler, getShaderModule } from '../render/gpu-cache.js';

const UNIFORM_TEX_SAMP_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'distance-transform-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};
import shader from './distance-transform.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// tex/distance-transform — for each pixel, the Euclidean distance to
// the nearest pixel above `threshold` in the input. Output is greyscale
// 0..1 normalized by `maxDistance` (in UV units).
//
// Uses the Jump Flood Algorithm: an init pass that marks seed pixels,
// then log2(resolution) ping-pong passes propagating seed UVs over
// halving distances, then a final pass that turns the per-pixel seed
// UV into a normalized distance value. Total passes ≈ 11 at 512² —
// fast enough to use freely.
//
// Useful for: leaf cell gradients (distance from nearest vein), soft
// dilations, antialiased mask refinement, glow ramps that scale by
// distance rather than Gaussian falloff.
export const distanceTransformNode: NodeDef = {
  id: 'tex/distance-transform',
  category: 'Texture/Filters',
  inputs: [
    { name: 'texture', type: 'Texture2D' },
    {
      name: 'threshold',
      type: 'Float',
      default: 0.5,
      description: 'pixels with R > threshold become seeds (distance 0)',
    },
    {
      name: 'maxDistance',
      type: 'Float',
      default: 0.15,
      description:
        'UV-space distance that maps to 1.0 in the output. Distances beyond clamp to 1.',
    },
    {
      name: 'invert',
      type: 'Bool',
      default: false,
      description:
        'false (default) outputs distance (0 at seed, 1 far away). true outputs proximity (1 at seed, 0 far) — useful when the next stage wants seeds to read as bright/highlights.',
    },
    {
      name: 'resolution',
      type: 'Int',
      default: 512,
      min: 1,
      description: 'output texture width and height in pixels',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'greyscale 0..1: each pixel\'s distance to the nearest seed pixel, normalised by maxDistance. With invert=false the seed is 0 (dark) and far pixels are 1 (bright); with invert=true the seed is bright',
    },
  ],
  doc: {
    summary: 'Per-pixel Euclidean distance to the nearest seed pixel (Jump Flood Algorithm).',
    description: `
For each pixel, finds the nearest input pixel whose red value exceeds
\`threshold\` and writes its Euclidean distance (in UV units, normalised by
\`maxDistance\`). Implemented with the Jump Flood Algorithm —
~log₂(resolution) ping-pong passes, fast enough to use freely in compositing
chains.

The killer use is "soft falloff from a feature". Pipe a vein texture
(sharp lines) into a DT with invert=true and you get bright cores fading to
dark cell-interiors over \`maxDistance\`. Pipe a city mask in and you get a
gradient that's strongest at the streets and fades over a few blocks. Run
it through a [tex/ramp](../../tex/ramp) +
[tex/colorize](../../tex/colorize) and you have a usable albedo gradient
from a binary mask.
`,
    sampleGraph: () => {
      const g = createGraph();
      const src = addNode(g, 'tex/grid', {
        id: 'src',
        position: { x: 0, y: 0 },
        inputValues: {
          fg: [1, 1, 1, 1],
          bg: [0, 0, 0, 1],
          divisions: [2, 2],
          line_width: 0.05,
          resolution: 512,
        },
      });
      const dt = addNode(g, 'tex/distance-transform', {
        id: 'dt',
        position: { x: 280, y: 0 },
        inputValues: { threshold: 0.5, maxDistance: 0.25, invert: false, resolution: 512 },
      });
      addEdge(g, { node: src.id, socket: 'texture' }, { node: dt.id, socket: 'texture' });
      return { graph: g, rootNodeId: 'dt' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __jfa?: [Texture2DValue, Texture2DValue];
    __uniformBuffer?: GPUBuffer;
    __initBg?: ReusableBindGroup;
    __jfaBgA?: ReusableBindGroup;
    __jfaBgB?: ReusableBindGroup;
    __finalBgA?: ReusableBindGroup;
    __finalBgB?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.texture as Texture2DValue;
    const threshold = inputs.threshold as number;
    const maxDistance = inputs.maxDistance as number;
    const invert = inputs.invert as boolean;
    const resolution = inputs.resolution as number;

    const usage =
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC;

    const prev = ctx.previousOutput as
      | {
          texture?: Texture2DValue;
          __jfa?: [Texture2DValue, Texture2DValue];
          __uniformBuffer?: GPUBuffer;
          __initBg?: ReusableBindGroup;
          __jfaBgA?: ReusableBindGroup;
          __jfaBgB?: ReusableBindGroup;
          __finalBgA?: ReusableBindGroup;
          __finalBgB?: ReusableBindGroup;
        }
      | undefined;
    const outTexture = reusableTexture(device, prev?.texture, {
      label: 'distance-transform-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage,
    });

    // Two intermediate textures for the JFA ping-pong. Reused via the
    // eval cache: stash both on the output under `__jfa` so the next
    // eval at the same resolution reuses them. Reusable textures are
    // also subject to sweep destruction when this node's outputs are
    // evicted.
    const a = reusableTexture(device, prev?.__jfa?.[0], {
      label: 'distance-transform-jfa-a',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage,
    });
    const b = reusableTexture(device, prev?.__jfa?.[1], {
      label: 'distance-transform-jfa-b',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage,
    });
    const aView = a.texture;
    const bView = b.texture;

    // One uniform buffer, rewritten between passes (only `step` changes
    // between JFA iterations; threshold + max_distance + invert are
    // constant for the entire eval).
    const uniformData = new Float32Array(8);
    uniformData[0] = 1 / resolution;
    uniformData[1] = 1 / resolution;
    uniformData[3] = threshold;
    uniformData[4] = maxDistance;
    uniformData[5] = invert ? 1 : 0;
    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const writeStep = (step: number) => {
      uniformData[2] = step;
      device.queue.writeBuffer(uniformBuffer, 0, uniformData as BufferSource);
    };

    const sampler = getSampler(device, {
      label: 'distance-transform-sampler',
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Three pipelines share the same shader module + bind group layout
    // (one uniform, one texture, one sampler at @group(0)). Only the
    // fragment entry point differs between them. The explicit BGL is
    // mandatory here — `layout: 'auto'` would produce three
    // structurally-identical-but-distinct layouts, defeating
    // reusableBindGroup across evaluations.
    const module = getShaderModule(device, shader);
    let bgl: GPUBindGroupLayout | undefined;
    const makePipeline = (entry: string): GPURenderPipeline => {
      const result = getPipelineWithLayout(
        device,
        UNIFORM_TEX_SAMP_BGL,
        (layout) => ({
          label: `distance-transform-pipeline-${entry}`,
          layout,
          vertex: { module, entryPoint: 'vs_main' },
          fragment: { module, entryPoint: entry, targets: [{ format: TEXTURE_FORMAT }] },
        }),
      );
      bgl = result.bindGroupLayout;
      return result.pipeline;
    };
    const initPipeline = makePipeline('fs_init');
    const jfaPipeline = makePipeline('fs_jfa');
    const finalPipeline = makePipeline('fs_final');
    // `bgl` is the cached BGL shared by all three pipelines.
    const sharedBgl = bgl!;

    const buildEntries = (srcView: GPUTexture) => () => [
      { binding: 0, resource: uniformBuffer },
      { binding: 1, resource: srcView },
      { binding: 2, resource: sampler },
    ];
    // Five long-lived bind groups, one per purpose. The JFA passes
    // need two because the loop swaps which texture is being READ
    // each iteration; same for the final pass since its read source
    // depends on the loop's parity. All five are stable across edits
    // because uniformBuffer / aView / bView / src.texture / sampler
    // are all reused via reusableBuffer / reusableTexture / getSampler.
    const initBg = reusableBindGroup(
      device,
      prev?.__initBg,
      sharedBgl,
      [uniformBuffer, src.texture, sampler],
      buildEntries(src.texture),
    );
    const jfaBgA = reusableBindGroup(
      device,
      prev?.__jfaBgA,
      sharedBgl,
      [uniformBuffer, aView, sampler],
      buildEntries(aView),
    );
    const jfaBgB = reusableBindGroup(
      device,
      prev?.__jfaBgB,
      sharedBgl,
      [uniformBuffer, bView, sampler],
      buildEntries(bView),
    );
    const finalBgA = reusableBindGroup(
      device,
      prev?.__finalBgA,
      sharedBgl,
      [uniformBuffer, aView, sampler],
      buildEntries(aView),
    );
    const finalBgB = reusableBindGroup(
      device,
      prev?.__finalBgB,
      sharedBgl,
      [uniformBuffer, bView, sampler],
      buildEntries(bView),
    );

    const fullScreen = (
      enc: GPUCommandEncoder,
      pipeline: GPURenderPipeline,
      view: GPUTextureView | GPUTexture,
      bg: GPUBindGroup,
      passLabel: string,
    ) => {
      const pass = enc.beginRenderPass({
        label: passLabel,
        colorAttachments: [
          {
            view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    };

    // Init: read original input → write seed UVs into texture A.
    {
      const enc = device.createCommandEncoder({ label: 'distance-transform-encoder-init' });
      writeStep(0);
      fullScreen(enc, initPipeline, aView, initBg.bindGroup, 'distance-transform-pass-init');
      device.queue.submit([enc.finish()]);
    }

    // JFA passes. Step halves each iteration; total ≈ log2(resolution).
    // We submit each pass separately so the read/write of the previous
    // pass is guaranteed visible — WebGPU's submission boundary is the
    // synchronization point.
    let readView = aView;
    let writeView = bView;
    let readBg = jfaBgA.bindGroup; // tracks which bind group goes with readView
    let writeBg = jfaBgB.bindGroup;
    const startStep = Math.floor(resolution / 2);
    for (let step = startStep; step >= 1; step = Math.floor(step / 2)) {
      const enc = device.createCommandEncoder({ label: `distance-transform-encoder-jfa-${step}` });
      writeStep(step);
      fullScreen(enc, jfaPipeline, writeView, readBg, `distance-transform-pass-jfa-${step}`);
      device.queue.submit([enc.finish()]);
      // Swap.
      const tmpView = readView;
      readView = writeView;
      writeView = tmpView;
      const tmpBg = readBg;
      readBg = writeBg;
      writeBg = tmpBg;
      // The integer-divide loop terminates when step reaches 0; do an
      // extra pass at step=1 already covered above, no special case
      // needed since the loop runs while step >= 1.
      if (step === 1) break;
    }

    // Final: turn the last JFA result's seed-UVs into normalized
    // distances and write to the output texture. Pick the bind group
    // matching whichever JFA texture ended up as `readView`.
    {
      const enc = device.createCommandEncoder({ label: 'distance-transform-encoder-final' });
      writeStep(0);
      const finalBg = readView === aView ? finalBgA.bindGroup : finalBgB.bindGroup;
      fullScreen(enc, finalPipeline, outTexture.texture, finalBg, 'distance-transform-pass-final');
      device.queue.submit([enc.finish()]);
    }

    // a, b stay alive in the returned outputs so the next eval can
    // reuse them. The cache sweep destroys them when this node's
    // outputs are finally evicted.
    return {
      texture: outTexture,
      __jfa: [a, b],
      __uniformBuffer: uniformBuffer,
      __initBg: initBg,
      __jfaBgA: jfaBgA,
      __jfaBgB: jfaBgB,
      __finalBgA: finalBgA,
      __finalBgB: finalBgB,
    };
  },
};
