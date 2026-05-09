import type { GeometryValue } from '../core/resources.js';

export interface CpuMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

export function uploadMeshToGpu(device: GPUDevice, mesh: CpuMesh): GeometryValue {
  const positionBuffer = device.createBuffer({
    size: mesh.positions.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(positionBuffer, 0, mesh.positions as BufferSource);

  const normalBuffer = device.createBuffer({
    size: mesh.normals.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(normalBuffer, 0, mesh.normals as BufferSource);

  const uvBuffer = device.createBuffer({
    size: mesh.uvs.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uvBuffer, 0, mesh.uvs as BufferSource);

  const indexBuffer = device.createBuffer({
    size: mesh.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(indexBuffer, 0, mesh.indices as BufferSource);

  return {
    positionBuffer,
    normalBuffer,
    uvBuffer,
    indexBuffer,
    indexCount: mesh.indices.length,
    indexFormat: 'uint32',
  };
}

export function destroyGeometry(geometry: GeometryValue) {
  geometry.positionBuffer.destroy();
  geometry.normalBuffer.destroy();
  geometry.uvBuffer.destroy();
  geometry.indexBuffer.destroy();
}
