import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue, HeightfieldValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { getSampler } from '../render/gpu-cache.js';
import { heightfieldToMesh, readHeightTexture } from '../render/heightfield.js';
import { uploadMeshToGpu } from '../render/mesh.js';
import shader from './heightfield-to-mesh.wgsl';

// Heightfield → renderable mesh. Two paths:
//
//   Default (cpu_access = false): GPU-native. Two compute passes write
//     positions / normals / uvs / indices straight into VERTEX+STORAGE
//     buffers from the heightfield texture — no readback, no CPU
//     mesh build, no async wait. The mesh is renderable the same
//     submit tick it's produced. The returned `GeometryValue` has NO
//     `mesh` field, so downstream nodes that touch CPU data
//     (`core/distribute-on-faces`, `core/merge-scene-entities`) will
//     refuse it.
//
//   cpu_access = true: legacy readback path. Copies the heightfield to
//     CPU, builds the mesh on CPU, uploads, and ALSO populates
//     `geometry.mesh`. Use this when you need to feed the terrain into
//     a CPU-only node. Slower (a few hundred ms at 256² resolution)
//     and async.
//
// The buffer layout in the GPU path matches uploadMeshToGpu's layout
// exactly (3-component pos + 3-component normal + 2-component uv,
// u32 indices) so the renderer's vertex bind groups Just Work without
// per-path branching.
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

export const heightfieldToMeshNode: NodeDef = {
  id: 'core/heightfield-to-mesh',
  category: 'Heightfield/Convert',
  inputs: [
    { name: 'heightfield', type: 'Heightfield' },
    { name: 'divisions', type: 'Vec2i', default: [64, 64] },
    {
      name: 'cpu_access',
      type: 'Bool',
      default: false,
      description:
        'when true, also reads the heightfield back to CPU so the resulting geometry can be consumed by CPU-only nodes (distribute-on-faces, merge-scene-entities). Costs an async readback and a CPU mesh build — leave off for the pure-rendering path',
    },
  ],
  outputs: [{ name: 'geometry', type: 'Geometry' }],
  async evaluate(ctx, inputs) {
    const device = requireDevice(ctx);
    const field = inputs.heightfield as HeightfieldValue;
    const divisions = inputs.divisions as [number, number];
    const cpuAccess = inputs.cpu_access as boolean;
    const prev = ctx.previousOutput as PrevCache | undefined;

    const divX = Math.max(1, Math.round(divisions[0]));
    const divZ = Math.max(1, Math.round(divisions[1]));

    if (cpuAccess) {
      // Legacy path: CPU readback + CPU mesh build. Same code as before
      // the GPU rewrite landed.
      const { heights, width, height } = await readHeightTexture(device, field.texture);
      const mesh = heightfieldToMesh({
        heights,
        width,
        height,
        worldSize: field.worldSize,
        heightRange: field.heightRange,
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

    // Pack params (matches WGSL Params struct).
    const paramData = new ArrayBuffer(32);
    const pu32 = new Uint32Array(paramData);
    const pf32 = new Float32Array(paramData);
    pu32[0] = numX;
    pu32[1] = numZ;
    pf32[2] = field.worldSize[0];
    pf32[3] = field.worldSize[1];
    pf32[4] = field.heightRange[0];
    pf32[5] = field.heightRange[1];
    pf32[6] = 1 / divX;
    pf32[7] = 1 / divZ;

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
        { binding: 5, resource: field.texture.texture },
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
      // No `mesh` — that's the whole point: GPU-only output.
    };
    return {
      geometry,
      __uniformBuffer: uniformBuffer,
    };
  },
};
