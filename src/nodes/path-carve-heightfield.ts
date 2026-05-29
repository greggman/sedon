import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { InputDef, NodeDef } from '../core/node-def.js';
import type {
  HeightfieldValue,
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

// Carve a Path into a Heightfield. Lowers the terrain along the path
// by `depth` world units, smoothly tapering back to the original
// surface across `falloff` extra extent outside the path's half-
// width. Output is a new Heightfield with the same worldSize /
// heightRange (only the texture's R channel changes).
//
// The companion `path-carve-heightfield.wgsl` does the actual work:
// one compute thread per output texel computes its world XZ,
// distance-to-nearest-segment, then subtracts a smoothstep'd depth.

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';
const WORKGROUP = 8;
// Storage buffer size for the path samples, sized to a sensible
// upper bound so re-evals of the same path-shape reuse the same
// allocation. ~1024 samples × 12 bytes = 12 KB.
const MAX_SAMPLES = 1024;

interface PrevCache {
  texture?: Texture2DValue;
  __uniformBuffer?: GPUBuffer;
  __samplesBuffer?: GPUBuffer;
}

let pipelineCache: { device: GPUDevice; layout: GPUBindGroupLayout; pipeline: GPUComputePipeline } | null = null;
function getPipeline(device: GPUDevice) {
  if (pipelineCache && pipelineCache.device === device) return pipelineCache;
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: TEXTURE_FORMAT, viewDimension: '2d' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    compute: {
      module: device.createShaderModule({ code: shader }),
      entryPoint: 'carve',
    },
  });
  pipelineCache = { device, layout, pipeline };
  return pipelineCache;
}

export const pathCarveHeightfieldNode: NodeDef = {
  id: 'path/carve-heightfield',
  category: 'Path',
  inputs: [
    {
      name: 'heightfield',
      type: 'Heightfield',
      description: 'source terrain to carve into',
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
      description: 'world units of vertical drop inside the path. Output height = clamp(input − depth × falloff(d), 0, 1)',
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
      name: 'heightfield',
      type: 'Heightfield',
      description: 'a new heightfield, same world size and height range as the input, with the path lowered into it',
    },
  ],
  doc: {
    summary: 'Lower a Heightfield along a Path — roads, riverbeds, paved trails.',
    description: `
For each output texel, computes the texel's world XZ, finds the
distance to the nearest segment of the input path's polyline, and
subtracts \`depth\` × a smoothstep falloff. Inside the path's half-width
the full depth is removed (flat-bottomed channel); outside it the depth
tapers smoothly to zero over an additional \`falloff\` world units.

The result keeps the same world size and height range as the input
heightfield — only the texture's R channel changes. Wire the output
straight into [core/heightfield-to-mesh](../../core/heightfield-to-mesh)
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
      const noise = addNode(g, 'core/perlin', {
        id: 'noise',
        position: { x: 0, y: 0 },
        inputValues: { scale: [3, 3], octaves: 5, lacunarity: 2, gain: 0.5, seed: 0, resolution: 256 },
      });
      const hf = addNode(g, 'core/heightfield', {
        id: 'hf',
        position: { x: 280, y: 0 },
        inputValues: { worldSize: [20, 20], heightRange: [0, 4] },
      });
      const extras: InputDef[] = [
        { name: 'point_0', type: 'Vec3' },
        { name: 'point_1', type: 'Vec3' },
        { name: 'point_2', type: 'Vec3' },
      ];
      const spline = addNode(g, 'path/spline', {
        id: 'spline',
        position: { x: 280, y: 220 },
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
        position: { x: 560, y: 110 },
        inputValues: { depth: 1.2, falloff: 2 },
      });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: hf.id, socket: 'texture' });
      addEdge(g, { node: hf.id, socket: 'heightfield' }, { node: carve.id, socket: 'heightfield' });
      addEdge(g, { node: spline.id, socket: 'path' }, { node: carve.id, socket: 'path' });
      return { graph: g, rootNodeId: 'carve' };
    },
  },
  evaluate(ctx, inputs) {
    const device = requireDevice(ctx);
    const inField = inputs.heightfield as HeightfieldValue;
    const path = inputs.path as PathValue;
    const depth = inputs.depth as number;
    const falloff = inputs.falloff as number;

    const src = inField.texture;
    const width = src.width;
    const height = src.height;

    const prev = ctx.previousOutput as PrevCache | undefined;
    const out = reusableTexture(device, prev?.texture, {
      width,
      height,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.STORAGE_BINDING
        | GPUTextureUsage.TEXTURE_BINDING
        | GPUTextureUsage.COPY_SRC,
    });

    // Uniforms: resolution (vec2u) | worldSize (vec2f) | heightRange
    // (vec2f) | sampleCount (u32) | width (f32) | depth (f32) |
    // falloff (f32). Total 40 bytes — pad to 48 for std140-ish
    // alignment safety.
    const uniformData = new ArrayBuffer(48);
    const uf32 = new Float32Array(uniformData);
    const uu32 = new Uint32Array(uniformData);
    uu32[0] = width;
    uu32[1] = height;
    uf32[2] = inField.worldSize[0];
    uf32[3] = inField.worldSize[1];
    uf32[4] = inField.heightRange[0];
    uf32[5] = inField.heightRange[1];
    uu32[6] = Math.min(path.count, MAX_SAMPLES);
    uf32[7] = path.width;
    uf32[8] = depth;
    uf32[9] = falloff;

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
        size: samplesBytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    if (sampleBytes > 0) {
      device.queue.writeBuffer(samplesBuffer, 0, path.samples.buffer, path.samples.byteOffset, sampleBytes);
    }

    const sampler = getSampler(device, {
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const { layout, pipeline } = getPipeline(device);
    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: src.texture },
        { binding: 2, resource: sampler },
        { binding: 3, resource: out.texture.createView() },
        { binding: 4, resource: samplesBuffer },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP), Math.ceil(height / WORKGROUP));
    pass.end();
    device.queue.submit([encoder.finish()]);

    return {
      heightfield: {
        texture: out,
        worldSize: inField.worldSize,
        heightRange: inField.heightRange,
      },
      texture: out,
      __uniformBuffer: uniformBuffer,
      __samplesBuffer: samplesBuffer,
    };
  },
};
