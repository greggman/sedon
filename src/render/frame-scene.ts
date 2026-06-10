import type { SceneValue } from '../core/resources.js';

// Compute a world-space axis-aligned bounding box for a scene's entities,
// then derive camera (target, distance) that frames the whole box for a
// given vertical FOV.
//
// Used by node thumbnails and asset thumbnails so each gets a useful
// auto-framed view instead of a hardcoded distance — without auto-fit,
// a 100-unit tree and a 0.1-unit gear look identical (a blob in space).
//
// We deliberately use the geometry's CPU-side `mesh.positions` copy when
// present. Compute-shader-generated geometry has no CPU copy; for those
// entities we fall back to a unit-radius sphere around the transform's
// translation. That's good enough to keep the camera from flying out to
// infinity, while still being a meaningful contribution to the AABB.

export interface FramingResult {
  /** World-space center of the framed bounding box. */
  target: [number, number, number];
  /** Camera distance that fits the bounding sphere into `fovYRadians`. */
  distance: number;
}

const EMPTY: FramingResult = { target: [0, 0, 0], distance: 5 };

export function frameScene(
  scene: SceneValue,
  fovYRadians: number,
  margin = 1,
): FramingResult {
  // Empty entities + empty terrain + empty grass = nothing to frame.
  // Render-time recipes (terrain, grass) carry a heightfield with the
  // world-space bounds we need, so scenes that have ONLY those still
  // frame correctly.
  if (
    scene.entities.length === 0
    && (scene.terrain ?? []).length === 0
    && (scene.grass ?? []).length === 0
  ) {
    return EMPTY;
  }

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let any = false;

  // Terrain fields: use the heightfield's full world XZ bounds. The
  // texture is conventionally centred on the origin so the XZ extent
  // is ±worldSize/2. We don't know the Y extent without reading the
  // texture back, so we estimate it as a fraction of the horizontal
  // footprint — this matches typical "mountain ~25% of width" terrain
  // and gives a good preview framing without an async readback.
  for (const field of scene.terrain ?? []) {
    const halfX = field.worldSize[0] * 0.5;
    const halfZ = field.worldSize[1] * 0.5;
    const estMaxY = 0.25 * Math.max(field.worldSize[0], field.worldSize[1]);
    if (-halfX < minX) minX = -halfX;
    if (halfX > maxX) maxX = halfX;
    if (0 < minY) minY = 0;
    if (estMaxY > maxY) maxY = estMaxY;
    if (-halfZ < minZ) minZ = -halfZ;
    if (halfZ > maxZ) maxZ = halfZ;
    any = true;
  }

  // Grass fields: grass renders only within `field.maxDistance` of the
  // camera, so framing to the underlying heightfield's full extent
  // would put the camera too far away — outside the visible grass
  // disc — and no blades would render at all (which is what showed up
  // when [geom/grass] was framed against the full 40-unit heightfield).
  //
  // For grass-only scenes, contribute a much smaller XZ extent so the
  // autofit places the camera INSIDE the visible-grass region. The
  // factor `/8` is empirically tuned: it gives an autofit distance
  // around `maxDistance / 4` for a square grass disc, so the camera
  // sits well inside the draw range with room for foreground blades.
  // When terrain is also in the scene, the terrain loop above will
  // already have set bounds that exceed these, so this is a no-op for
  // mixed grass+terrain — exactly the right behavior (frame the
  // visible terrain; grass renders in front of the camera anyway).
  for (const field of scene.grass ?? []) {
    const halfXZ = field.maxDistance / 8;
    const estMaxY = 0.25 * Math.max(field.worldSize[0], field.worldSize[1]);
    if (-halfXZ < minX) minX = -halfXZ;
    if (halfXZ > maxX) maxX = halfXZ;
    if (0 < minY) minY = 0;
    if (estMaxY > maxY) maxY = estMaxY;
    if (-halfXZ < minZ) minZ = -halfXZ;
    if (halfXZ > maxZ) maxZ = halfXZ;
    any = true;
  }

  for (const ent of scene.entities) {
    const m = ent.transform;
    const mesh = ent.geometry.mesh;
    if (mesh && mesh.positions.length >= 3) {
      // Local AABB → world AABB via the 8-corner transform trick. Cheaper
      // than transforming every vertex and tight enough for camera framing.
      let lminX = Infinity, lminY = Infinity, lminZ = Infinity;
      let lmaxX = -Infinity, lmaxY = -Infinity, lmaxZ = -Infinity;
      const p = mesh.positions;
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
        if (x < lminX) lminX = x; if (x > lmaxX) lmaxX = x;
        if (y < lminY) lminY = y; if (y > lmaxY) lmaxY = y;
        if (z < lminZ) lminZ = z; if (z > lmaxZ) lmaxZ = z;
      }
      for (let cx = 0; cx < 2; cx++)
        for (let cy = 0; cy < 2; cy++)
          for (let cz = 0; cz < 2; cz++) {
            const x = cx ? lmaxX : lminX;
            const y = cy ? lmaxY : lminY;
            const z = cz ? lmaxZ : lminZ;
            const wx = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
            const wy = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
            const wz = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
            if (wx < minX) minX = wx; if (wx > maxX) maxX = wx;
            if (wy < minY) minY = wy; if (wy > maxY) maxY = wy;
            if (wz < minZ) minZ = wz; if (wz > maxZ) maxZ = wz;
            any = true;
          }
    } else {
      // No CPU mesh available — treat the entity as a unit ball around its
      // translation. Keeps the AABB sane for compute-only geometry.
      const tx = m[12]!, ty = m[13]!, tz = m[14]!;
      if (tx - 0.5 < minX) minX = tx - 0.5;
      if (ty - 0.5 < minY) minY = ty - 0.5;
      if (tz - 0.5 < minZ) minZ = tz - 0.5;
      if (tx + 0.5 > maxX) maxX = tx + 0.5;
      if (ty + 0.5 > maxY) maxY = ty + 0.5;
      if (tz + 0.5 > maxZ) maxZ = tz + 0.5;
      any = true;
    }
  }

  if (!any) return EMPTY;

  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
  // Bounding-sphere radius around the AABB center. Half-diagonal so the
  // sphere actually contains the box.
  const radius = Math.max(0.5, 0.5 * Math.hypot(dx, dy, dz));
  // distance such that the sphere of `radius` fits the vertical FOV.
  const distance = (radius / Math.sin(fovYRadians * 0.5)) * margin;
  return { target: [cx, cy, cz], distance };
}
