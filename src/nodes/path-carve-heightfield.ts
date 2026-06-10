import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { InputDef, NodeDef } from '../core/node-def.js';
import type {
  PathValue,
  Texture2DValue,
} from '../core/resources.js';
import {
  requireDevice,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { getSampler } from '../render/gpu-cache.js';
import shader from './path-carve-heightfield.wgsl';

// Carve a Path into a heightfield Texture2D. Lowers the terrain along
// the path by `depth` world units, smoothly tapering back to the
// original surface across `falloff` extra extent outside the path's
// half-width. Output is a new texture with the same format and
// dimensions; the worldSize the texture represents is the same as the
// input (it's a parameter on this node so the carve knows world XZ
// for distance comparisons).
//
// The companion `path-carve-heightfield.wgsl` does the actual work:
// one compute thread per output texel computes its world XZ,
// distance-to-nearest-segment, then subtracts a smoothstep'd depth.

const WORKGROUP = 8;
// Storage buffer size for the path samples, sized to a sensible
// upper bound so re-evals of the same path-shape reuse the same
// allocation. ~1024 samples × 12 bytes = 12 KB.
const MAX_SAMPLES = 1024;

type SupportedFormat = 'rgba8unorm' | 'rgba16float';

interface PrevCache {
  texture?: Texture2DValue;
  __uniformBuffer?: GPUBuffer;
  __samplesBuffer?: GPUBuffer;
  __format?: SupportedFormat;
}

interface PipelineSet {
  layout: GPUBindGroupLayout;
  pipeline: GPUComputePipeline;
}

const pipelineCacheByDevice = new WeakMap<GPUDevice, Map<SupportedFormat, PipelineSet>>();

function pickFormat(srcFormat: GPUTextureFormat): SupportedFormat {
  return srcFormat === 'rgba16float' ? 'rgba16float' : 'rgba8unorm';
}

function getPipeline(device: GPUDevice, format: SupportedFormat): PipelineSet {
  let byFormat = pipelineCacheByDevice.get(device);
  if (!byFormat) {
    byFormat = new Map();
    pipelineCacheByDevice.set(device, byFormat);
  }
  const existing = byFormat.get(format);
  if (existing) return existing;
  const layout = device.createBindGroupLayout({
    label: 'path-carve-heightfield-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format, viewDimension: '2d' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  });
  const code = shader.replace(/\{\{STORAGE_FORMAT\}\}/g, format);
  const pipeline = device.createComputePipeline({
    label: 'path-carve-heightfield-pipeline',
    layout: device.createPipelineLayout({ label: 'path-carve-heightfield-pl', bindGroupLayouts: [layout] }),
    compute: {
      module: device.createShaderModule({ label: 'path-carve-heightfield-module', code }),
      entryPoint: 'carve',
    },
  });
  const set: PipelineSet = { layout, pipeline };
  byFormat.set(format, set);
  return set;
}

export const pathCarveHeightfieldNode: NodeDef = {
  id: 'path/carve-heightfield',
  category: 'Path',
  inputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'source heightfield texture (R = world Y in metres). Format is preserved in the output',
    },
    {
      name: 'worldSize',
      type: 'Vec2',
      default: [10, 10],
      description: 'terrain XZ footprint in metres — must match the worldSize the texture represents on the consumer node so the path lands in the right place',
    },
    {
      name: 'path',
      type: 'Path',
      description: 'centreline polyline from [path/spline](../../path/spline). The path\'s `width` field controls the inner flat section before falloff kicks in',
    },
    {
      name: 'depth',
      type: 'Float',
      default: 1.0,
      description: 'world units (metres) of vertical drop inside the path. Output height = input − depth × falloff(d)',
    },
    {
      name: 'falloff',
      type: 'Float',
      default: 2.0,
      description: 'extra world-unit extent outside the path\'s half-width over which the depth smoothly tapers to zero. Larger = wider, gentler banks',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'a new heightfield texture, same format and dimensions as the input, with the path lowered into it',
    },
  ],
  doc: {
    summary: 'Lower a heightfield texture along a Path — roads, riverbeds, paved trails.',
    description: `
For each output texel, computes the texel's world XZ, finds the
distance to the nearest segment of the input path's polyline, and
subtracts \`depth\` × a smoothstep falloff. Inside the path's half-width
the full depth is removed (flat-bottomed channel); outside it the depth
tapers smoothly to zero over an additional \`falloff\` world units.

The result keeps the same format and dimensions as the input texture —
only the R channel changes. Wire the output straight into
[geom/heightfield-from-texture](../../geom/heightfield-from-texture)
to render the terrain with the carved road; or feed it into another
filter stage first (a [terrain/hydraulic-erosion](../../terrain/hydraulic-erosion)
pass after carving will deposit sediment inside the road channel,
useful for dirt tracks).

The companion [path/mask](../../path/mask) is a sine-wave shortcut for
authoring a single procedural road without a Spline. Carve takes a real
Path from spline samples, so it follows any control-point layout.
`,
    sampleGraph: () => {
      const g = createGraph();
      const noise = addNode(g, 'tex/perlin', {
        id: 'noise',
        position: { x: 0, y: 0 },
        inputValues: { scale: [3, 3], octaves: 5, lacunarity: 2, gain: 0.5, seed: 0, resolution: 256 },
      });
      const toFloat = addNode(g, 'tex/convert', {
        id: 'toFloat',
        position: { x: 280, y: 0 },
        inputValues: { format: 1 },
      });
      const heightTex = addNode(g, 'tex/map-range', {
        id: 'heightTex',
        position: { x: 560, y: 0 },
        inputValues: { in_min: 0, in_max: 1, out_min: 0, out_max: 4, clamp: false },
      });
      const extras: InputDef[] = [
        { name: 'point_0', type: 'Vec3' },
        { name: 'point_1', type: 'Vec3' },
        { name: 'point_2', type: 'Vec3' },
      ];
      const spline = addNode(g, 'path/spline', {
        id: 'spline',
        position: { x: 560, y: 220 },
        extraInputs: extras,
        inputValues: {
          width: 3,
          samples_per_segment: 16,
          point_0: [-8, 0, -6],
          point_1: [0, 0, 2],
          point_2: [8, 0, -6],
        },
      });
      const carve = addNode(g, 'path/carve-heightfield', {
        id: 'carve',
        position: { x: 840, y: 110 },
        inputValues: { worldSize: [20, 20], depth: 1.2, falloff: 2 },
      });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: toFloat.id, socket: 'texture' });
      addEdge(g, { node: toFloat.id, socket: 'texture' }, { node: heightTex.id, socket: 'texture' });
      addEdge(g, { node: heightTex.id, socket: 'texture' }, { node: carve.id, socket: 'texture' });
      addEdge(g, { node: spline.id, socket: 'path' }, { node: carve.id, socket: 'path' });
      return { graph: g, rootNodeId: 'carve' };
    },
  },
  evaluate(ctx, inputs) {
    const device = requireDevice(ctx);
    const src = inputs.texture as Texture2DValue;
    const worldSize = inputs.worldSize as [number, number];
    const path = inputs.path as PathValue;
    const depth = inputs.depth as number;
    const falloff = inputs.falloff as number;
    const format = pickFormat(src.format);

    const width = src.width;
    const height = src.height;

    const prev = ctx.previousOutput as PrevCache | undefined;
    const reusableTexCandidate = prev?.__format === format ? prev?.texture : undefined;
    const out = reusableTexture(device, reusableTexCandidate, {
      label: 'path-carve-heightfield-output-tex',
      width,
      height,
      format,
      usage:
        GPUTextureUsage.STORAGE_BINDING
        | GPUTextureUsage.TEXTURE_BINDING
        | GPUTextureUsage.COPY_SRC,
    });

    // Uniforms: resolution (vec2u) | worldSize (vec2f) | sampleCount
    // (u32) | width (f32) | depth (f32) | falloff (f32) | _pad ×2.
    // Total 40 bytes; pad to 48 for std140-ish alignment safety.
    const uniformData = new ArrayBuffer(48);
    const uf32 = new Float32Array(uniformData);
    const uu32 = new Uint32Array(uniformData);
    uu32[0] = width;
    uu32[1] = height;
    uf32[2] = worldSize[0];
    uf32[3] = worldSize[1];
    uu32[4] = Math.min(path.count, MAX_SAMPLES);
    uf32[5] = path.width;
    uf32[6] = depth;
    uf32[7] = falloff;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer,
      uniformData,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // Path samples buffer. Always sized to MAX_SAMPLES so the same
    // allocation handles any path that fits — typical roads use ≤200
    // samples. The shader honours `sampleCount` so unused tail entries
    // never read.
    const samplesBytes = MAX_SAMPLES * 3 * 4;
    const sampleBytes = path.count * 3 * 4;
    let samplesBuffer = prev?.__samplesBuffer;
    if (!samplesBuffer || samplesBuffer.size !== samplesBytes) {
      samplesBuffer?.destroy();
      samplesBuffer = device.createBuffer({
        label: 'path-carve-heightfield-samples',
        size: samplesBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    if (sampleBytes > 0) {
      device.queue.writeBuffer(samplesBuffer, 0, path.samples.buffer, path.samples.byteOffset, sampleBytes);
    }

    const sampler = getSampler(device, {
      label: 'path-carve-heightfield-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const { layout, pipeline } = getPipeline(device, format);
    const bindGroup = device.createBindGroup({
      label: 'path-carve-heightfield-bg',
      layout,
      entries: [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: src.texture },
        { binding: 2, resource: sampler },
        { binding: 3, resource: out.texture.createView() },
        { binding: 4, resource: samplesBuffer },
      ],
    });

    const encoder = device.createCommandEncoder({ label: 'path-carve-heightfield-encoder' });
    const pass = encoder.beginComputePass({ label: 'path-carve-heightfield-pass' });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP), Math.ceil(height / WORKGROUP));
    pass.end();
    device.queue.submit([encoder.finish()]);

    return {
      texture: out,
      __uniformBuffer: uniformBuffer,
      __samplesBuffer: samplesBuffer,
      __format: format,
    };
  },
};
