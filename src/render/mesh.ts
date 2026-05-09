import type { CpuMeshRef, GeometryValue } from '../core/resources.js';
import {
  multiply,
  rotationX,
  rotationY,
  rotationZ,
  translation,
  type Mat4,
} from './mat4.js';

export type CpuMesh = CpuMeshRef;

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
    mesh,
  };
}

export function destroyGeometry(geometry: GeometryValue) {
  geometry.positionBuffer.destroy();
  geometry.normalBuffer.destroy();
  geometry.uvBuffer.destroy();
  geometry.indexBuffer.destroy();
}

// Apply a TRS transform to a CpuMesh: returns a new mesh with positions and
// normals in world space; uvs and indices are reused (unchanged). Normals are
// scale-divided then rotated, so non-uniform scale stays correct without
// inverting a matrix. Order: scale, then rotate (XYZ Euler), then translate.
export function transformMesh(
  mesh: CpuMesh,
  translate: readonly [number, number, number],
  rotate: readonly [number, number, number],
  scale: readonly [number, number, number],
): CpuMesh {
  const T = translation(translate[0], translate[1], translate[2]);
  const Rx = rotationX(rotate[0]);
  const Ry = rotationY(rotate[1]);
  const Rz = rotationZ(rotate[2]);
  const M: Mat4 = multiply(multiply(multiply(T, Rx), Ry), Rz);

  // Guard against zero-scale-divides for normals.
  const sx = scale[0] !== 0 ? scale[0] : 1e-9;
  const sy = scale[1] !== 0 ? scale[1] : 1e-9;
  const sz = scale[2] !== 0 ? scale[2] : 1e-9;

  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);

  // Column-major: M[col*4 + row].
  const m00 = M[0]!, m10 = M[1]!, m20 = M[2]!;
  const m01 = M[4]!, m11 = M[5]!, m21 = M[6]!;
  const m02 = M[8]!, m12 = M[9]!, m22 = M[10]!;
  const m03 = M[12]!, m13 = M[13]!, m23 = M[14]!;

  for (let i = 0; i < mesh.positions.length; i += 3) {
    const px = mesh.positions[i]! * scale[0];
    const py = mesh.positions[i + 1]! * scale[1];
    const pz = mesh.positions[i + 2]! * scale[2];
    positions[i] = m00 * px + m01 * py + m02 * pz + m03;
    positions[i + 1] = m10 * px + m11 * py + m12 * pz + m13;
    positions[i + 2] = m20 * px + m21 * py + m22 * pz + m23;

    const nx = mesh.normals[i]! / sx;
    const ny = mesh.normals[i + 1]! / sy;
    const nz = mesh.normals[i + 2]! / sz;
    const rx = m00 * nx + m01 * ny + m02 * nz;
    const ry = m10 * nx + m11 * ny + m12 * nz;
    const rz = m20 * nx + m21 * ny + m22 * nz;
    const len = Math.hypot(rx, ry, rz) || 1;
    normals[i] = rx / len;
    normals[i + 1] = ry / len;
    normals[i + 2] = rz / len;
  }

  return {
    positions,
    normals,
    uvs: mesh.uvs,
    indices: mesh.indices,
  };
}
