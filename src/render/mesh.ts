import type { CpuMeshRef, GeometryValue, PointCloudValue } from '../core/resources.js';
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

// Mulberry32 PRNG. Deterministic for a given 32-bit seed; cheap; good enough
// for "scatter points reproducibly" use cases. Not crypto-grade.
function mulberry32(seed: number): () => number {
  let state = (seed | 0) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Distribute points across the surface of a mesh, weighted by triangle area.
// `density` is points per unit of surface area; the per-triangle count is
// stochastically rounded so small triangles still have a chance of getting a
// point.
export function distributeOnFaces(
  mesh: CpuMesh,
  density: number,
  seed: number,
): PointCloudValue {
  const rand = mulberry32(Math.floor(seed * 1_000_000) || 1);

  const outPositions: number[] = [];
  const outNormals: number[] = [];

  const p = mesh.positions;
  const n = mesh.normals;
  const ix = mesh.indices;

  for (let t = 0; t < ix.length; t += 3) {
    const i0 = ix[t]! * 3;
    const i1 = ix[t + 1]! * 3;
    const i2 = ix[t + 2]! * 3;

    const p0x = p[i0]!,    p0y = p[i0 + 1]!,    p0z = p[i0 + 2]!;
    const p1x = p[i1]!,    p1y = p[i1 + 1]!,    p1z = p[i1 + 2]!;
    const p2x = p[i2]!,    p2y = p[i2 + 1]!,    p2z = p[i2 + 2]!;

    const ax = p1x - p0x, ay = p1y - p0y, az = p1z - p0z;
    const bx = p2x - p0x, by = p2y - p0y, bz = p2z - p0z;
    const cx = ay * bz - az * by;
    const cy = az * bx - ax * bz;
    const cz = ax * by - ay * bx;
    const area = 0.5 * Math.hypot(cx, cy, cz);

    const exact = area * density;
    let count = Math.floor(exact);
    if (rand() < exact - count) count++;
    if (count === 0) continue;

    const n0x = n[i0]!,     n0y = n[i0 + 1]!,     n0z = n[i0 + 2]!;
    const n1x = n[i1]!,     n1y = n[i1 + 1]!,     n1z = n[i1 + 2]!;
    const n2x = n[i2]!,     n2y = n[i2 + 1]!,     n2z = n[i2 + 2]!;

    for (let k = 0; k < count; k++) {
      let u = rand();
      let v = rand();
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      const w = 1 - u - v;

      outPositions.push(
        w * p0x + u * p1x + v * p2x,
        w * p0y + u * p1y + v * p2y,
        w * p0z + u * p1z + v * p2z,
      );

      const nx = w * n0x + u * n1x + v * n2x;
      const ny = w * n0y + u * n1y + v * n2y;
      const nz = w * n0z + u * n1z + v * n2z;
      const len = Math.hypot(nx, ny, nz) || 1;
      outNormals.push(nx / len, ny / len, nz / len);
    }
  }

  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    count: outPositions.length / 3,
  };
}

// Realize a point cloud by copying the instance mesh at every point. Returns
// one big merged mesh; the standard renderer can draw it without any
// instancing infrastructure. For thousands of points this gets memory-heavy,
// at which point we'd switch to true instanced draws.
export function instanceOnPoints(
  instance: CpuMesh,
  points: PointCloudValue,
  scale: number,
): CpuMesh {
  const vpi = instance.positions.length / 3; // vertices per instance
  const ipi = instance.indices.length;       // indices per instance
  const totalV = vpi * points.count;
  const totalI = ipi * points.count;

  const positions = new Float32Array(totalV * 3);
  const normals = new Float32Array(totalV * 3);
  const uvs = new Float32Array(totalV * 2);
  const indices = new Uint32Array(totalI);

  const ip = instance.positions;
  const in_ = instance.normals;
  const iu = instance.uvs;
  const ii = instance.indices;
  const pp = points.positions;

  for (let p = 0; p < points.count; p++) {
    const px = pp[p * 3]!;
    const py = pp[p * 3 + 1]!;
    const pz = pp[p * 3 + 2]!;
    const baseV = p * vpi;

    for (let v = 0; v < vpi; v++) {
      const dst = (baseV + v) * 3;
      const src = v * 3;
      positions[dst] = ip[src]! * scale + px;
      positions[dst + 1] = ip[src + 1]! * scale + py;
      positions[dst + 2] = ip[src + 2]! * scale + pz;
      normals[dst] = in_[src]!;
      normals[dst + 1] = in_[src + 1]!;
      normals[dst + 2] = in_[src + 2]!;

      const dstUv = (baseV + v) * 2;
      const srcUv = v * 2;
      uvs[dstUv] = iu[srcUv]!;
      uvs[dstUv + 1] = iu[srcUv + 1]!;
    }

    const baseI = p * ipi;
    for (let k = 0; k < ipi; k++) {
      indices[baseI + k] = ii[k]! + baseV;
    }
  }

  return { positions, normals, uvs, indices };
}
