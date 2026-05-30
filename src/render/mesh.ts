import { reusableBuffer, type CpuMeshRef, type GeometryValue, type PointCloudValue } from '../core/resources.js';
import {
  multiply,
  rotationX,
  rotationY,
  rotationZ,
  translation,
  type Mat4,
} from './mat4.js';

export type CpuMesh = CpuMeshRef;

/**
 * Upload a CPU mesh as a renderable GeometryValue. If `previous` is
 * supplied (typically the node's `ctx.previousOutput?.geometry`), each
 * vertex/index buffer is reused when its byte size matches — we just
 * writeBuffer new contents in place. This makes nodes whose
 * "topology" stays put (sphere with the same segments + rings;
 * heightfield-to-mesh with the same divisions) cheap to re-evaluate
 * across drag-edits of any non-shape parameter.
 *
 * Per-buffer matching: if e.g. only the index buffer would change size
 * (rare — usually all four scale together), the matching buffers are
 * reused and the others reallocated. So callers don't need to gate the
 * whole call on a shape check.
 */
export function uploadMeshToGpu(
  device: GPUDevice,
  mesh: CpuMesh,
  previous?: GeometryValue,
): GeometryValue {
  // GPUBufferUsage isn't a runtime-resolvable name in the Node test
  // environment (no WebGPU at import time), so we look up the flags
  // inside the function rather than at module scope.
  const vertexUsage = GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST;
  const indexUsage = GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST;
  const positionBuffer = reusableBuffer(
    device,
    previous?.positionBuffer,
    mesh.positions as BufferSource,
    vertexUsage,
  );
  const normalBuffer = reusableBuffer(
    device,
    previous?.normalBuffer,
    mesh.normals as BufferSource,
    vertexUsage,
  );
  const uvBuffer = reusableBuffer(
    device,
    previous?.uvBuffer,
    mesh.uvs as BufferSource,
    vertexUsage,
  );
  const indexBuffer = reusableBuffer(
    device,
    previous?.indexBuffer,
    mesh.indices as BufferSource,
    indexUsage,
  );

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

// Concatenate two meshes into one. b's indices are offset by a's vertex count
// so they remain valid in the merged buffer. UVs/normals are concatenated as
// is; the merged mesh sits in a single index space with one shared material
// downstream — region-specific materials need a future multi-material path.
export function mergeMeshes(a: CpuMesh, b: CpuMesh): CpuMesh {
  const aVerts = a.positions.length / 3;
  const bVerts = b.positions.length / 3;
  const totalVerts = aVerts + bVerts;
  const totalIndices = a.indices.length + b.indices.length;

  const positions = new Float32Array(totalVerts * 3);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.positions.length);

  const normals = new Float32Array(totalVerts * 3);
  normals.set(a.normals, 0);
  normals.set(b.normals, a.normals.length);

  const uvs = new Float32Array(totalVerts * 2);
  uvs.set(a.uvs, 0);
  uvs.set(b.uvs, a.uvs.length);

  const indices = new Uint32Array(totalIndices);
  indices.set(a.indices, 0);
  for (let i = 0; i < b.indices.length; i++) {
    indices[a.indices.length + i] = b.indices[i]! + aVerts;
  }

  return { positions, normals, uvs, indices };
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
//
// Each point also gets a tangent computed from the source triangle's UV
// gradient (the direction of increasing U on the surface), then orthogonalized
// against the per-point interpolated normal. Computed in the same space as
// positions/normals, so the tangent transforms equivariantly with any
// upstream Transform — instances aligned via these tangents stay glued to the
// surface as the source mesh rotates.
export function distributeOnFaces(
  mesh: CpuMesh,
  density: number,
  seed: number,
): PointCloudValue {
  const rand = mulberry32(Math.floor(seed * 1_000_000) || 1);

  const outPositions: number[] = [];
  const outNormals: number[] = [];
  const outTangents: number[] = [];

  const p = mesh.positions;
  const n = mesh.normals;
  const uv = mesh.uvs;
  const ix = mesh.indices;

  for (let t = 0; t < ix.length; t += 3) {
    const i0 = ix[t]!;
    const i1 = ix[t + 1]!;
    const i2 = ix[t + 2]!;
    const p0i = i0 * 3, p1i = i1 * 3, p2i = i2 * 3;
    const uv0i = i0 * 2, uv1i = i1 * 2, uv2i = i2 * 2;

    const p0x = p[p0i]!,    p0y = p[p0i + 1]!,    p0z = p[p0i + 2]!;
    const p1x = p[p1i]!,    p1y = p[p1i + 1]!,    p1z = p[p1i + 2]!;
    const p2x = p[p2i]!,    p2y = p[p2i + 1]!,    p2z = p[p2i + 2]!;

    const ex = p1x - p0x, ey = p1y - p0y, ez = p1z - p0z;
    const fx = p2x - p0x, fy = p2y - p0y, fz = p2z - p0z;
    const cx = ey * fz - ez * fy;
    const cy = ez * fx - ex * fz;
    const cz = ex * fy - ey * fx;
    const area = 0.5 * Math.hypot(cx, cy, cz);

    const exact = area * density;
    let count = Math.floor(exact);
    if (rand() < exact - count) count++;
    if (count === 0) continue;

    const n0x = n[p0i]!,    n0y = n[p0i + 1]!,    n0z = n[p0i + 2]!;
    const n1x = n[p1i]!,    n1y = n[p1i + 1]!,    n1z = n[p1i + 2]!;
    const n2x = n[p2i]!,    n2y = n[p2i + 1]!,    n2z = n[p2i + 2]!;

    // Face tangent in the direction of +U on the surface, derived from the
    // UV gradient. Falls back to edge `e` when the UV parameterization is
    // degenerate on this face.
    const du1u = uv[uv1i]! - uv[uv0i]!;
    const du1v = uv[uv1i + 1]! - uv[uv0i + 1]!;
    const du2u = uv[uv2i]! - uv[uv0i]!;
    const du2v = uv[uv2i + 1]! - uv[uv0i + 1]!;
    const det = du1u * du2v - du2u * du1v;

    let ftx: number, fty: number, ftz: number;
    if (Math.abs(det) < 1e-9) {
      ftx = ex; fty = ey; ftz = ez;
    } else {
      const inv = 1 / det;
      ftx = inv * (du2v * ex - du1v * fx);
      fty = inv * (du2v * ey - du1v * fy);
      ftz = inv * (du2v * ez - du1v * fz);
    }

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
      const nlen = Math.hypot(nx, ny, nz) || 1;
      const nnx = nx / nlen, nny = ny / nlen, nnz = nz / nlen;
      outNormals.push(nnx, nny, nnz);

      // Per-point tangent: project the face tangent perpendicular to this
      // point's interpolated normal, then normalize.
      const ndt = ftx * nnx + fty * nny + ftz * nnz;
      let tpx = ftx - ndt * nnx;
      let tpy = fty - ndt * nny;
      let tpz = ftz - ndt * nnz;
      const tlen = Math.hypot(tpx, tpy, tpz);
      if (tlen < 1e-6) {
        // Degenerate (face tangent parallel to normal). Pick *any* perp
        // direction so the basis stays well-defined.
        if (Math.abs(nnx) < 0.9) {
          tpx = 1 - nnx * nnx;
          tpy = -nnx * nny;
          tpz = -nnx * nnz;
        } else {
          tpx = -nny * nnx;
          tpy = 1 - nny * nny;
          tpz = -nny * nnz;
        }
        const fb = Math.hypot(tpx, tpy, tpz) || 1;
        tpx /= fb; tpy /= fb; tpz /= fb;
      } else {
        tpx /= tlen; tpy /= tlen; tpz /= tlen;
      }
      outTangents.push(tpx, tpy, tpz);
    }
  }

  return {
    positions: new Float32Array(outPositions),
    normals: new Float32Array(outNormals),
    tangents: new Float32Array(outTangents),
    count: outPositions.length / 3,
  };
}

// Scatter points uniformly through the INTERIOR of a closed triangle
// mesh. The pattern is AABB-rejection-sampling: generate `density ×
// AABB_volume` candidate points uniformly in the mesh's bounding box,
// then keep only the ones that test as inside via a +X-ray-cast parity
// test (Möller–Trumbore against every triangle, odd crossings = inside).
// Expected output ≈ density × mesh_interior_volume.
//
// Use cases: volume-filling attractor clouds for `branch/space-colonization`
// (a sphere of points pulls branches into the interior of a canopy
// shape, vs. surface-only attractors which pin growth to a shell);
// generic volumetric scattering for instance-on-points (rocks
// distributed inside a quarry box, fish inside a swim volume).
//
// Requirements on the input mesh:
//   • Closed, manifold, consistent winding. Holes or flipped triangles
//     produce wrong parity → false negatives or false positives.
//   • CPU-side mesh data present (`geom.mesh` not undefined).
// Cost is O(candidates × triangles). For the canonical sphere @ ~140
// triangles + density ~10 / unit³, this runs in single-digit ms.
export function distributeInVolume(
  mesh: CpuMesh,
  density: number,
  seed: number,
): PointCloudValue {
  const rand = mulberry32(Math.floor(seed * 1_000_000) || 1);

  // AABB of the mesh.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const spanZ = maxZ - minZ;
  const aabbVolume = Math.max(spanX * spanY * spanZ, 1e-12);

  // Generate ~density × aabb candidates; after rejection ~density ×
  // mesh-interior-volume make it out. Round half-up via `rand` so
  // fractional densities (e.g. 0.5 / unit³) still produce a sensible
  // count without biasing toward zero on small AABBs.
  const exact = density * aabbVolume;
  let candidateCount = Math.floor(exact);
  if (rand() < exact - candidateCount) candidateCount++;
  if (candidateCount === 0) {
    return { count: 0, positions: new Float32Array(0) };
  }

  const ix = mesh.indices;
  const outPositions: number[] = [];

  // +X ray, Möller–Trumbore parity test. Ray-direction is (1, 0, 0)
  // so pvec = ray_dir × e2 = (0, -e2z, e2y) — many terms vanish, the
  // inner loop is ~10 multiplies per triangle.
  function isInside(px: number, py: number, pz: number): boolean {
    let crossings = 0;
    for (let t = 0; t < ix.length; t += 3) {
      const i0 = ix[t]!, i1 = ix[t + 1]!, i2 = ix[t + 2]!;
      const ax = p[i0 * 3]!, ay = p[i0 * 3 + 1]!, az = p[i0 * 3 + 2]!;
      const bx = p[i1 * 3]!, by = p[i1 * 3 + 1]!, bz = p[i1 * 3 + 2]!;
      const cx = p[i2 * 3]!, cy = p[i2 * 3 + 1]!, cz = p[i2 * 3 + 2]!;
      const e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      // det = e1 · (ray_dir × e2) where ray_dir=(1,0,0)
      //     = e1.y * (-e2z) + e1.z * e2y
      const det = -e1y * e2z + e1z * e2y;
      if (Math.abs(det) < 1e-9) continue; // ray parallel to triangle plane
      const invDet = 1 / det;
      const tvx = px - ax, tvy = py - ay, tvz = pz - az;
      const u = (-tvy * e2z + tvz * e2y) * invDet;
      if (u < 0 || u > 1) continue;
      const e1x = bx - ax;
      // qvec = tv × e1
      const qx = tvy * e1z - tvz * e1y;
      const qy = tvz * e1x - tvx * e1z;
      const qz = tvx * e1y - tvy * e1x;
      const v = qx * invDet; // ray_dir · q = qx
      if (v < 0 || u + v > 1) continue;
      const tHit = (e2x * qx + e2y * qy + e2z * qz) * invDet;
      if (tHit > 0) crossings++;
    }
    return (crossings & 1) === 1;
  }

  for (let k = 0; k < candidateCount; k++) {
    const px = minX + rand() * spanX;
    const py = minY + rand() * spanY;
    const pz = minZ + rand() * spanZ;
    if (isInside(px, py, pz)) {
      outPositions.push(px, py, pz);
    }
  }

  return {
    count: outPositions.length / 3,
    positions: new Float32Array(outPositions),
  };
}

export interface InstanceOnPointsOptions {
  /** Base scale applied to every instance, multiplied by per-point scale if provided. */
  scale: number;
  /** Rotate each instance to align local +Y with the point normal. */
  align: boolean;
  /**
   * Optional per-point per-axis scale (length = count * 3). If absent, every
   * instance uses just the base scale uniformly. The values multiply the base
   * scale: `final[axis] = base * perPointScale[i*3 + axis]`.
   */
  perPointScale?: Float32Array;
  /**
   * Optional per-point yaw rotation in radians (length = count). If absent,
   * no spin around the local Y axis.
   */
  perPointYaw?: Float32Array;
  /**
   * Optional per-point activation mask (length = count). When present, only
   * points with `value >= 0.5` are realized — others are skipped entirely.
   * Lets upstream filter nodes (cloud-step on slope/altitude) gate scattering
   * without having to reshape every parallel cloud's count.
   */
  perPointActive?: Float32Array;
}

// Realize a point cloud by copying the instance mesh at every point. Returns
// one big merged mesh; the standard renderer can draw it without any
// instancing infrastructure. For thousands of points this gets memory-heavy,
// at which point we'd switch to true instanced draws.
//
// When `align` is true and the cloud carries surface normals, each instance is
// rotated so its local +Y axis points along the surface normal at that point.
// Per-instance random scale and yaw rotation give variety without breaking
// determinism — same `seed` produces the same arrangement every eval.
export function instanceOnPoints(
  instance: CpuMesh,
  points: PointCloudValue,
  opts: InstanceOnPointsOptions,
): CpuMesh {
  const { scale, align, perPointScale, perPointYaw, perPointActive } = opts;
  const vpi = instance.positions.length / 3; // vertices per instance
  const ipi = instance.indices.length;       // indices per instance

  // If a per-point active mask is provided, count active points first so we
  // can size the output mesh exactly. Without a mask, all points are active.
  let activeCount = points.count;
  if (perPointActive) {
    activeCount = 0;
    for (let i = 0; i < points.count; i++) {
      if (perPointActive[i]! >= 0.5) activeCount++;
    }
  }

  const totalV = vpi * activeCount;
  const totalI = ipi * activeCount;

  const positions = new Float32Array(totalV * 3);
  const normals = new Float32Array(totalV * 3);
  const uvs = new Float32Array(totalV * 2);
  const indices = new Uint32Array(totalI);

  const ip = instance.positions;
  const in_ = instance.normals;
  const iu = instance.uvs;
  const ii = instance.indices;
  const pp = points.positions;
  const pn = points.normals;
  const pt = points.tangents;
  const useAlign = align && pn !== undefined;

  // `dst` walks the OUTPUT slot index (only advances for active points), while
  // `p` walks the source point index (so we still read the right per-point
  // attribute values for the active subset).
  let dstSlot = 0;
  for (let p = 0; p < points.count; p++) {
    if (perPointActive && perPointActive[p]! < 0.5) continue;

    const px = pp[p * 3]!;
    const py = pp[p * 3 + 1]!;
    const pz = pp[p * 3 + 2]!;

    // Default identity rotation; replaced below when aligning.
    let r00 = 1, r01 = 0, r02 = 0;
    let r10 = 0, r11 = 1, r12 = 0;
    let r20 = 0, r21 = 0, r22 = 1;

    if (useAlign) {
      const nx = pn[p * 3]!;
      const ny = pn[p * 3 + 1]!;
      const nz = pn[p * 3 + 2]!;

      let tx: number, ty: number, tz: number;
      if (pt) {
        // Use the source-mesh-derived tangent: it's perpendicular to N and
        // rotates with the mesh, so the cube basis stays glued to the surface
        // as the upstream geometry rotates.
        tx = pt[p * 3]!;
        ty = pt[p * 3 + 1]!;
        tz = pt[p * 3 + 2]!;
      } else {
        // Fallback: pick a tangent perpendicular to N using world-up. Stable
        // per-frame but anchored to world axes (cubes spin relative to the
        // sphere when the sphere rotates).
        let upx: number, upy: number, upz: number;
        if (Math.abs(ny) > 0.999) {
          upx = 1; upy = 0; upz = 0;
        } else {
          upx = 0; upy = 1; upz = 0;
        }
        tx = upy * nz - upz * ny;
        ty = upz * nx - upx * nz;
        tz = upx * ny - upy * nx;
        const tlen = Math.hypot(tx, ty, tz) || 1;
        tx /= tlen; ty /= tlen; tz /= tlen;
      }

      // B = cross(T, N), so the basis {T, N, B} is right-handed and the
      // rotation matrix has det = +1. With cross(N, T) it would be left-
      // handed (det = -1), which mirrors the instance mesh and inverts the
      // winding — making cubes inside-out and the back faces visible after
      // back-face culling.
      const bx = ty * nz - tz * ny;
      const by = tz * nx - tx * nz;
      const bz = tx * ny - ty * nx;

      // R columns: T (X image), N (Y image), B (Z image).
      r00 = tx; r10 = ty; r20 = tz;
      r01 = nx; r11 = ny; r21 = nz;
      r02 = bx; r12 = by; r22 = bz;
    }

    // Per-point variation comes from optional cloud attributes; absent → no
    // variation, just the base scale.
    const sx = scale * (perPointScale ? perPointScale[p * 3]!     : 1);
    const syA = scale * (perPointScale ? perPointScale[p * 3 + 1]! : 1);
    const sz = scale * (perPointScale ? perPointScale[p * 3 + 2]! : 1);
    const yaw = perPointYaw ? perPointYaw[p]! : 0;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);

    // Inverse per-axis scale for normals; guard against zero scale to avoid NaN.
    const isx = sx !== 0 ? 1 / sx : 0;
    const isy = syA !== 0 ? 1 / syA : 0;
    const isz = sz !== 0 ? 1 / sz : 0;

    const baseV = dstSlot * vpi;
    for (let v = 0; v < vpi; v++) {
      // Spin in local XZ around Y, then per-axis scale.
      const ix0 = ip[v * 3]!;
      const iy0 = ip[v * 3 + 1]!;
      const iz0 = ip[v * 3 + 2]!;
      const ix = (cy * ix0 + sy * iz0) * sx;
      const iy = iy0 * syA;
      const iz = (-sy * ix0 + cy * iz0) * sz;
      const dst = (baseV + v) * 3;
      positions[dst]     = r00 * ix + r01 * iy + r02 * iz + px;
      positions[dst + 1] = r10 * ix + r11 * iy + r12 * iz + py;
      positions[dst + 2] = r20 * ix + r21 * iy + r22 * iz + pz;

      // Yaw normals, then apply inverse-scale and renormalize so non-uniform
      // scale produces correct surface normals (squashing the Y axis tilts the
      // sides of a cube outward; the normal must follow).
      const inx0 = in_[v * 3]!;
      const iny0 = in_[v * 3 + 1]!;
      const inz0 = in_[v * 3 + 2]!;
      const inxYaw = cy * inx0 + sy * inz0;
      const inyYaw = iny0;
      const inzYaw = -sy * inx0 + cy * inz0;
      let nx = inxYaw * isx;
      let ny = inyYaw * isy;
      let nz = inzYaw * isz;
      const nlen = Math.hypot(nx, ny, nz) || 1;
      nx /= nlen; ny /= nlen; nz /= nlen;
      normals[dst]     = r00 * nx + r01 * ny + r02 * nz;
      normals[dst + 1] = r10 * nx + r11 * ny + r12 * nz;
      normals[dst + 2] = r20 * nx + r21 * ny + r22 * nz;

      const dstUv = (baseV + v) * 2;
      const srcUv = v * 2;
      uvs[dstUv]     = iu[srcUv]!;
      uvs[dstUv + 1] = iu[srcUv + 1]!;
    }

    const baseI = dstSlot * ipi;
    for (let k = 0; k < ipi; k++) {
      indices[baseI + k] = ii[k]! + baseV;
    }

    dstSlot++;
  }

  return { positions, normals, uvs, indices };
}
