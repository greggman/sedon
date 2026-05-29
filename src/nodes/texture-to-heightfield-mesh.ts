import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue, Texture2DValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { getSampler } from '../render/gpu-cache.js';
import { heightfieldToMesh, readHeightTexture } from '../render/heightfield.js';
import { uploadMeshToGpu } from '../render/mesh.js';
import shader from './texture-to-heightfield-mesh.wgsl';

// Texture (heightfield) → renderable mesh. Two paths:
//
//   Default (cpu_access = false): GPU-native. Two compute passes write
//     positions / normals / uvs / indices straight into VERTEX+STORAGE
//     buffers from the texture's R channel (= world Y in metres) —
//     no readback, no CPU mesh build, no async wait. The mesh is
//     renderable the same submit tick it's produced. The returned
//     `GeometryValue` has NO `mesh` field, so downstream nodes that
//     touch CPU data (`core/distribute-on-faces`,
//     `core/merge-scene-entities`) will refuse it.
//
//   cpu_access = true: legacy readback path. Copies the texture to
//     CPU, builds the mesh on CPU, uploads, and ALSO populates
//     `geometry.mesh`. Use this when you need to feed the terrain into
//     a CPU-only node. Slower (a few hundred ms at 256² resolution)
//     and async.
interface PrevCache {
  geometry?: GeometryValue;
  __uniformBuffer?: GPUBuffer;
}

let pipelineCache: {
  device: GPUDevice;
  layout: GPUBindGroupLayout;
  vertPipeline: GPUComputePipeline;
  indexPipeline: GPUComputePipeline;
} | null = null;
function getPipelines(device: GPUDevice) {
  if (pipelineCache && pipelineCache.device === device) return pipelineCache;
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
    ],
  });
  const pl = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const module = device.createShaderModule({ code: shader });
  const cache = {
    device,
    layout,
    vertPipeline: device.createComputePipeline({
      layout: pl,
      compute: { module, entryPoint: 'write_vertices' },
    }),
    indexPipeline: device.createComputePipeline({
      layout: pl,
      compute: { module, entryPoint: 'write_indices' },
    }),
  };
  pipelineCache = cache;
  return cache;
}

function allocOrReuseBuffer(
  device: GPUDevice,
  prev: GPUBuffer | undefined,
  size: number,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  if (prev && prev.size === size) return prev;
  prev?.destroy();
  return device.createBuffer({ size, usage });
}

export const textureToHeightfieldMeshNode: NodeDef = {
  id: 'core/texture-to-heightfield-mesh',
  category: 'Texture/Convert',
  inputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: "height texture; R channel is read as world Y in metres directly. Typically rgba16float — chain [core/texture-convert](../../core/texture-convert) + [core/texture-map-range](../../core/texture-map-range) ahead of this to scale [0,1] noise into real altitudes",
    },
    {
      name: 'worldSize',
      type: 'Vec2',
      default: [10, 10],
      description: 'terrain XZ footprint in metres (centred on origin)',
    },
    {
      name: 'divisions',
      type: 'Vec2i',
      default: [64, 64],
      description: 'mesh resolution in quads along each axis. 64×64 is the sweet spot for medium terrains; bump to 256+ for close-up detail at the cost of triangle count',
    },
    {
      name: 'cpu_access',
      type: 'Bool',
      default: false,
      description: 'when true, also reads the texture back to CPU so the resulting geometry can be consumed by CPU-only nodes (distribute-on-faces, merge-scene-entities). Costs an async readback and a CPU mesh build — leave off for the pure-rendering path',
    },
  ],
  outputs: [
    {
      name: 'geometry',
      type: 'Geometry',
      description: 'a triangulated terrain mesh whose per-vertex Y comes from sampling the texture. UVs span [0, 1] across the world footprint',
    },
  ],
  doc: {
    summary: 'Triangulate a height texture into a terrain mesh — R channel = world Y in metres.',
    description: `
GPU-native by default: two compute passes write positions, normals, UVs,
and indices straight into vertex buffers from the texture — no readback,
no CPU build, no async wait. The mesh is renderable the same submit tick.

The result is a regular grid of quads (subdivided to two triangles each)
with vertices snapped to the per-pixel texture value, so the mesh follows
every bump in the source up to the \`divisions\` resolution. UVs span
[0, 1] across the whole terrain — for fine surface detail (grass
close-up), follow with [core/uv-transform](../../core/uv-transform) to
repeat the texture more densely.

The R channel is treated as **world Y in metres directly**. Typical
terrain-authoring chain:

  [core/perlin](../../core/perlin) → [core/texture-convert](../../core/texture-convert)(rgba16float) → [core/texture-map-range](../../core/texture-map-range)(0,1 → 0,50) → here

so the noise's [0, 1] values land at altitudes in metres before the
texture is read as a heightfield.

Set \`cpu_access = true\` only when a downstream node needs CPU-side
vertex data ([core/distribute-on-faces](../../core/distribute-on-faces),
[core/merge-scene-entities](../../core/merge-scene-entities)); the
readback is a few hundred ms and async.
`,
    sampleGraph: () => {
      const g = createGraph();
      const noise = addNode(g, 'core/perlin', {
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
      const mesh = addNode(g, 'core/texture-to-heightfield-mesh', {
        id: 'mesh',
        position: { x: 840, y: 0 },
        inputValues: { worldSize: [10, 10], divisions: [64, 64], cpu_access: true },
      });
      addEdge(g, { node: noise.id, socket: 'texture' }, { node: toFloat.id, socket: 'texture' });
      addEdge(g, { node: toFloat.id, socket: 'texture' }, { node: remap.id, socket: 'texture' });
      addEdge(g, { node: remap.id, socket: 'texture' }, { node: mesh.id, socket: 'texture' });
      return { graph: g, rootNodeId: 'mesh' };
    },
  },
  async evaluate(ctx, inputs) {
    const device = requireDevice(ctx);
    const tex = inputs.texture as Texture2DValue;
    const worldSize = inputs.worldSize as [number, number];
    const divisions = inputs.divisions as [number, number];
    const cpuAccess = inputs.cpu_access as boolean;
    const prev = ctx.previousOutput as PrevCache | undefined;

    const divX = Math.max(1, Math.round(divisions[0]));
    const divZ = Math.max(1, Math.round(divisions[1]));

    if (cpuAccess) {
      // Legacy path: CPU readback + CPU mesh build. R channel of the
      // texture is read as world Y in metres directly.
      const { heights, width, height } = await readHeightTexture(device, tex);
      const mesh = heightfieldToMesh({
        heights,
        width,
        height,
        worldSize,
        divX,
        divZ,
      });
      return {
        geometry: uploadMeshToGpu(device, mesh, prev?.geometry),
      };
    }

    // GPU path. Build the four buffers, dispatch two compute passes.
    const numX = divX + 1;
    const numZ = divZ + 1;
    const numVerts = numX * numZ;
    const numIndices = divX * divZ * 6;

    const posBytes = numVerts * 3 * 4;
    const normBytes = numVerts * 3 * 4;
    const uvBytes = numVerts * 2 * 4;
    const idxBytes = numIndices * 4;

    const vertexUsage = GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
    const indexUsage = GPUBufferUsage.INDEX | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;

    const positionBuffer = allocOrReuseBuffer(device, prev?.geometry?.positionBuffer, posBytes, vertexUsage);
    const normalBuffer = allocOrReuseBuffer(device, prev?.geometry?.normalBuffer, normBytes, vertexUsage);
    const uvBuffer = allocOrReuseBuffer(device, prev?.geometry?.uvBuffer, uvBytes, vertexUsage);
    const indexBuffer = allocOrReuseBuffer(device, prev?.geometry?.indexBuffer, idxBytes, indexUsage);

    // Pack params (matches WGSL Params struct: 8 × 4 bytes).
    const paramData = new ArrayBuffer(32);
    const pu32 = new Uint32Array(paramData);
    const pf32 = new Float32Array(paramData);
    pu32[0] = numX;
    pu32[1] = numZ;
    pf32[2] = worldSize[0];
    pf32[3] = worldSize[1];
    pf32[4] = 1 / divX;
    pf32[5] = 1 / divZ;

    let uniformBuffer = prev?.__uniformBuffer;
    if (!uniformBuffer || uniformBuffer.size !== paramData.byteLength) {
      uniformBuffer?.destroy();
      uniformBuffer = device.createBuffer({
        size: paramData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    device.queue.writeBuffer(uniformBuffer, 0, paramData);

    const sampler = getSampler(device, {
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const { layout, vertPipeline, indexPipeline } = getPipelines(device);
    const bindGroup = device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: positionBuffer },
        { binding: 2, resource: normalBuffer },
        { binding: 3, resource: uvBuffer },
        { binding: 4, resource: indexBuffer },
        { binding: 5, resource: tex.texture },
        { binding: 6, resource: sampler },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setBindGroup(0, bindGroup);
    pass.setPipeline(vertPipeline);
    pass.dispatchWorkgroups(Math.ceil(numX / 8), Math.ceil(numZ / 8));
    pass.setPipeline(indexPipeline);
    pass.dispatchWorkgroups(Math.ceil(divX / 8), Math.ceil(divZ / 8));
    pass.end();
    device.queue.submit([encoder.finish()]);

    const geometry: GeometryValue = {
      positionBuffer,
      normalBuffer,
      uvBuffer,
      indexBuffer,
      indexCount: numIndices,
      indexFormat: 'uint32',
    };
    return {
      geometry,
      __uniformBuffer: uniformBuffer,
    };
  },
};
