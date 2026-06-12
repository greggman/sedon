import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type {
  FloatCloudValue,
  PlacementEntry,
  PointCloudValue,
  SceneEntity,
  SceneEntityProvenance,
  SceneValue,
  Vec3CloudValue,
} from '../core/resources.js';
import { multiply, type Mat4 } from '../render/mat4.js';

// Hash producing two values per point — one for yaw and one as a placeholder
// kept in case we need a second per-point random later.
function pointHash(i: number, seed: number): [number, number] {
  const a = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453123;
  const b = Math.sin(i * 91.523 + seed * 23.917) * 12345.6789;
  return [a - Math.floor(a), b - Math.floor(b)];
}

// Build the per-point world transform: translate to point.position, rotate by
// the TBN basis (when aligning), spin yaw around local Y, then per-axis
// scale. Composed as M = T * R_TBN * R_yaw * S.
//
// Storage is column-major mat4: m[col*4 + row].
function buildPointMatrix(
  px: number,
  py: number,
  pz: number,
  tx: number, ty: number, tz: number,
  nx: number, ny: number, nz: number,
  bx: number, by: number, bz: number,
  cy: number, syaw: number,
  sx: number, syA: number, sz: number,
): Mat4 {
  // R = R_TBN * R_yaw
  // R_TBN columns: T, N, B   (instance X→T, Y→N, Z→B)
  // R_yaw columns: (cy, 0, -syaw), (0, 1, 0), (syaw, 0, cy)
  // R col0 = R_TBN * (cy, 0, -syaw) = T*cy - B*syaw
  // R col1 = R_TBN * (0, 1, 0)      = N
  // R col2 = R_TBN * (syaw, 0, cy)  = T*syaw + B*cy
  const rTx = tx * cy - bx * syaw;
  const rTy = ty * cy - by * syaw;
  const rTz = tz * cy - bz * syaw;
  const rBx = tx * syaw + bx * cy;
  const rBy = ty * syaw + by * cy;
  const rBz = tz * syaw + bz * cy;

  const m = new Float32Array(16);
  // col 0: R col0 * sx
  m[0] = rTx * sx;
  m[1] = rTy * sx;
  m[2] = rTz * sx;
  m[3] = 0;
  // col 1: R col1 * sy
  m[4] = nx * syA;
  m[5] = ny * syA;
  m[6] = nz * syA;
  m[7] = 0;
  // col 2: R col2 * sz
  m[8] = rBx * sz;
  m[9] = rBy * sz;
  m[10] = rBz * sz;
  m[11] = 0;
  // col 3: translation
  m[12] = px;
  m[13] = py;
  m[14] = pz;
  m[15] = 1;
  return m;
}

// Given a point's normal, compute the TBN tangent. Prefers the cloud's
// per-point tangent when present (rotates equivariantly with the source mesh
// under upstream Transform); falls back to world-up cross-product otherwise.
function pointBasis(
  nx: number, ny: number, nz: number,
  cloudTx: number | null, cloudTy: number | null, cloudTz: number | null,
): { tx: number; ty: number; tz: number; bx: number; by: number; bz: number } {
  let tx: number, ty: number, tz: number;
  if (cloudTx !== null) {
    tx = cloudTx;
    ty = cloudTy as number;
    tz = cloudTz as number;
  } else {
    let upx: number, upy: number, upz: number;
    if (Math.abs(ny) > 0.999) {
      upx = 1; upy = 0; upz = 0;
    } else {
      upx = 0; upy = 1; upz = 0;
    }
    let rx = upy * nz - upz * ny;
    let ry = upz * nx - upx * nz;
    let rz = upx * ny - upy * nx;
    const tlen = Math.hypot(rx, ry, rz) || 1;
    tx = rx / tlen; ty = ry / tlen; tz = rz / tlen;
  }
  // B = cross(T, N), so {T, N, B} is right-handed (det = +1, no reflection).
  const bx = ty * nz - tz * ny;
  const by = tz * nx - tx * nz;
  const bz = tx * ny - ty * nx;
  return { tx, ty, tz, bx, by, bz };
}

// Scatter a Scene at every point in a PointCloud, preserving entity boundaries
// so the renderer can batch trees-of-the-same-species into one instanced
// draw. Per-point scale/yaw/active clouds modulate transforms; entities that
// share (geometry, material) refs across points get drawn together.
export const instanceSceneOnPointsNode: NodeDef = {
  id: 'scene/instance-on-points',
  category: 'Scene',
  // Stamps placement provenance referencing this distribute's nodeId
  // and ctx.subgraphPath — output is context-dependent.
  provenanceDependent: true,
  inputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'where to place copies of the scene. Each point\'s position drives the placement; its normal drives orientation when `align` is on',
    },
    {
      name: 'instance',
      type: 'Scene',
      description: 'source scene from [scene/entity](../../scene/entity) (or any other Scene). Every entity in the source is scattered to every point — entities that share refs across points batch into one instanced draw',
    },
    {
      name: 'scale',
      type: 'Float',
      default: 1,
      description: 'uniform scale applied to every placed copy',
    },
    {
      name: 'align',
      type: 'Bool',
      default: true,
      description: 'rotate each instance to align local +Y with the point normal',
    },
    {
      name: 'per_point_scale',
      type: 'Vec3Cloud',
      optional: true,
      description: 'optional per-point per-axis scale, multiplies base scale',
    },
    {
      name: 'per_point_yaw',
      type: 'FloatCloud',
      optional: true,
      description: 'optional per-point rotation around local +Y, in radians',
    },
    {
      name: 'per_point_active',
      type: 'FloatCloud',
      optional: true,
      description: 'optional per-point activation mask; only values >= 0.5 are realized',
    },
    {
      name: 'per_point_tint',
      type: 'Vec3Cloud',
      optional: true,
      description: 'optional per-point RGB tint, multiplied into each entity tint',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'PRNG seed for built-in per-point yaw jitter when no per_point_yaw cloud is wired',
    },
  ],
  outputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'a new Scene with one entity per (input entity × point) pair. Entities sharing refs across points draw as instanced batches; per-entity provenance is preserved so GPU picking still routes clicks back to the right source node',
    },
  ],
  doc: {
    summary: 'Scatter a Scene at every point — preserves entity boundaries for instanced rendering.',
    description: `
For each point, transforms every entity in the source scene by (scale,
align-to-normal, translate-to-point) and emits one entity per (source
entity × point) pair. Crucially, entities that share (geometry,
material) refs across the resulting points get drawn together as one
instanced batch — that's what makes scattering 5,000 trees tractable
even though each tree is a multi-entity scene with trunk + foliage.

This is the right scattering node for INDEPENDENT OBJECTS — forests,
debris fields, scattered rocks, crowd characters. Each instance is its
own entity, so:

- GPU picking routes clicks back to the right source node (provenance
  stamps the placement chain).
- Per-instance tint via \`per_point_tint\` works without baking colours
  into vertex data.
- The renderer batches per (geometry, material), not per vertex blob.

For a single MERGED MESH instead (track of railroad ties, ridge of
spires that should bend as one), reach for
[geom/instance-on-points](../../geom/instance-on-points)
— that one CPU-merges into one Geometry.

Per-point variation comes from optional Cloud inputs:
- \`per_point_scale\`: Vec3, per-axis scale multiplier
- \`per_point_yaw\`: Float, rotation around local +Y in radians. When
  unwired, the node generates its own deterministic yaw jitter from \`seed\`
  so a forest doesn't look like every tree faces the same direction.
- \`per_point_active\`: Float, mask. Values ≥ 0.5 are realised.
  Pair with [cloud/step](../../cloud/step) to mask scatter by
  altitude/slope/density.
- \`per_point_tint\`: Vec3, RGB tint multiplied into the entity's tint.
  Pair with [cloud/random-vec3](../../cloud/random-vec3) for
  natural species colour variation.
`,
    sampleGraph: () => {
      const g = createGraph();
      // Grid of 64 points → 64 scenes (each a coloured cube
      // scene-entity) via the instancer. Live scene preview shows the
      // resulting batched draws.
      const points = addNode(g, 'points/grid', {
        id: 'points',
        position: { x: 0, y: 0 },
        inputValues: { cols: 6, rows: 6, spacing: 0.8, jitter: 0.4, seed: 0 },
      });
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 200 },
        inputValues: { size: 1 },
      });
      const basecolor = addNode(g, 'tex/solid-color', {
        id: 'basecolor',
        position: { x: 0, y: 380 },
        inputValues: { color: [0.55, 0.62, 0.42, 1], resolution: 32 },
      });
      const material = addNode(g, 'material/pbr', {
        id: 'material',
        position: { x: 280, y: 380 },
        inputValues: { roughness: 0.6, metallic: 0 },
      });
      const entity = addNode(g, 'scene/entity', {
        id: 'entity',
        position: { x: 560, y: 200 },
        inputValues: {},
      });
      const inst = addNode(g, 'scene/instance-on-points', {
        id: 'inst',
        position: { x: 840, y: 100 },
        inputValues: { scale: 0.18, align: true, seed: 0 },
      });
      addEdge(g, { node: basecolor.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
      addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
      addEdge(g, { node: points.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: entity.id, socket: 'scene' }, { node: inst.id, socket: 'instance' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(ctx, inputs): { scene: SceneValue } {
    const points = inputs.points as PointCloudValue;
    const instance = inputs.instance as SceneValue;
    const baseScale = inputs.scale as number;
    const align = inputs.align as boolean;
    const perPointScale = inputs.per_point_scale as Vec3CloudValue | undefined;
    const perPointYaw = inputs.per_point_yaw as FloatCloudValue | undefined;
    const perPointActive = inputs.per_point_active as FloatCloudValue | undefined;
    const perPointTint = inputs.per_point_tint as Vec3CloudValue | undefined;
    const seed = inputs.seed as number;

    if (perPointScale && perPointScale.count !== points.count) {
      throw new Error(
        `per_point_scale count (${perPointScale.count}) does not match points count (${points.count})`,
      );
    }
    if (perPointYaw && perPointYaw.count !== points.count) {
      throw new Error(
        `per_point_yaw count (${perPointYaw.count}) does not match points count (${points.count})`,
      );
    }
    if (perPointActive && perPointActive.count !== points.count) {
      throw new Error(
        `per_point_active count (${perPointActive.count}) does not match points count (${points.count})`,
      );
    }
    if (perPointTint && perPointTint.count !== points.count) {
      throw new Error(
        `per_point_tint count (${perPointTint.count}) does not match points count (${points.count})`,
      );
    }

    const useAlign = align && points.normals !== undefined;
    const pp = points.positions;
    const pn = points.normals;
    const pt = points.tangents;

    const out: SceneEntity[] = [];

    for (let p = 0; p < points.count; p++) {
      if (perPointActive && perPointActive.values[p]! < 0.5) continue;

      const px = pp[p * 3]!;
      const py = pp[p * 3 + 1]!;
      const pz = pp[p * 3 + 2]!;

      // Defaults: identity rotation, base-scale, no yaw.
      let tx = 1, ty = 0, tz = 0;
      let nx = 0, ny = 1, nz = 0;
      let bx = 0, by = 0, bz = 1;
      if (useAlign && pn) {
        nx = pn[p * 3]!;
        ny = pn[p * 3 + 1]!;
        nz = pn[p * 3 + 2]!;
        const basis = pointBasis(
          nx, ny, nz,
          pt ? pt[p * 3]! : null,
          pt ? pt[p * 3 + 1]! : null,
          pt ? pt[p * 3 + 2]! : null,
        );
        tx = basis.tx; ty = basis.ty; tz = basis.tz;
        bx = basis.bx; by = basis.by; bz = basis.bz;
      }

      const sx = baseScale * (perPointScale ? perPointScale.values[p * 3]!     : 1);
      const sy = baseScale * (perPointScale ? perPointScale.values[p * 3 + 1]! : 1);
      const sz = baseScale * (perPointScale ? perPointScale.values[p * 3 + 2]! : 1);

      let yawAngle = 0;
      if (perPointYaw) {
        yawAngle = perPointYaw.values[p]!;
      } else if (seed !== 0) {
        // No explicit yaw cloud but a non-zero seed is a hint to shake yaws
        // up. Keep deterministic from seed+index.
        const [hashY] = pointHash(p, seed);
        yawAngle = hashY * Math.PI * 2;
      }
      const cy = Math.cos(yawAngle);
      const syaw = Math.sin(yawAngle);

      const pointMat = buildPointMatrix(
        px, py, pz,
        tx, ty, tz,
        nx, ny, nz,
        bx, by, bz,
        cy, syaw,
        sx, sy, sz,
      );

      // Per-point tint multiplies each source entity's tint (RGB only;
      // alpha passes through unchanged from the source entity).
      let ptR = 1, ptG = 1, ptB = 1;
      if (perPointTint) {
        ptR = perPointTint.values[p * 3]!;
        ptG = perPointTint.values[p * 3 + 1]!;
        ptB = perPointTint.values[p * 3 + 2]!;
      }

      // Record this distribute's placement so GPU picking can frame the
      // specific instance ("tree #47") rather than the leaf-mesh-as-type.
      // The pointTransform stored is the per-point world matrix BEFORE
      // composition with the source's transform — that's the per-tree
      // pivot the framing math wants, independent of any trunk/leaf
      // offsets the source subgraph baked in.
      const placement: PlacementEntry = {
        distributeNodeId: ctx.nodeId ?? '<unknown>',
        pointIndex: p,
        pointTransform: pointMat,
      };

      for (const sourceEntity of instance.entities) {
        // Output transform = pointMat * sourceEntity.transform, so a tree
        // subgraph that positions trunk vs leaves at different local Y still
        // composes correctly when scattered.
        const finalT = multiply(pointMat, sourceEntity.transform);
        const st = sourceEntity.tint;
        const finalTint = perPointTint
          ? new Float32Array([st[0]! * ptR, st[1]! * ptG, st[2]! * ptB, st[3]!])
          : st;
        // Preserve the source's chain (it already encodes which subgraph
        // built the trunk/leaf) and append this placement. originNodeId
        // stays as the source's producer so "frame leaf" would still
        // route to the leaf node — but the deepest placement is what
        // P2's framing UI uses by default.
        const srcProv = sourceEntity.provenance;
        const provenance: SceneEntityProvenance | undefined = srcProv
          ? {
              originNodeId: srcProv.originNodeId,
              subgraphPath: srcProv.subgraphPath,
              placements: [...srcProv.placements, placement],
            }
          : {
              originNodeId: ctx.nodeId ?? '<unknown>',
              subgraphPath: (ctx.subgraphPath ?? []).slice(),
              placements: [placement],
            };
        out.push({
          geometry: sourceEntity.geometry,
          material: sourceEntity.material,
          transform: finalT,
          tint: finalTint,
          provenance,
        });
      }
    }

    return { scene: { entities: out } };
  },
};
