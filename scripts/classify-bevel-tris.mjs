// Classify the 116 triangles in the bevel output by what they should be:
//   - face tris   = all 3 vertices on the same cube face plane (±0.5 in one axis)
//   - strip tris  = 4-vertex chamfer quad face, 45° between two cube faces
//   - cap tris    = 3 vertices at distance `width` from a cube corner
// Then we can see directly whether the 12 edge chamfers (24 tris) exist.
import { readFileSync } from 'node:fs';

const m = JSON.parse(readFileSync('/tmp/bevel-mesh.json', 'utf8'));
const { positions, indices, triangleCount } = m;

const counts = { face: 0, strip: 0, cap: 0, other: 0 };
const samples = { face: [], strip: [], cap: [], other: [] };

function onPlane(p, axis, val) {
  return Math.abs(p[axis] - val) < 1e-4;
}

for (let t = 0; t < triangleCount; t++) {
  const i0 = indices[t*3], i1 = indices[t*3+1], i2 = indices[t*3+2];
  const p = [
    [positions[i0*3], positions[i0*3+1], positions[i0*3+2]],
    [positions[i1*3], positions[i1*3+1], positions[i1*3+2]],
    [positions[i2*3], positions[i2*3+1], positions[i2*3+2]],
  ];
  // Face tri: all 3 verts on one cube face plane (one coord = ±0.5).
  let isFace = false;
  for (const axis of [0,1,2]) {
    for (const val of [-0.5, 0.5]) {
      if (onPlane(p[0], axis, val) && onPlane(p[1], axis, val) && onPlane(p[2], axis, val)) {
        isFace = true;
      }
    }
  }
  if (isFace) {
    counts.face++;
    if (samples.face.length < 2) samples.face.push({ t, p });
    continue;
  }
  // Cap tri: all 3 vertices at distance `width`=0.12 from a SINGLE cube
  // corner (one of the 8 corners).
  const corners = [];
  for (const cx of [-0.5, 0.5]) for (const cy of [-0.5, 0.5]) for (const cz of [-0.5, 0.5]) corners.push([cx,cy,cz]);
  let isCap = false;
  for (const c of corners) {
    let all = true;
    for (const v of p) {
      const d = Math.hypot(v[0]-c[0], v[1]-c[1], v[2]-c[2]);
      if (Math.abs(d - 0.12) > 1e-3) { all = false; break; }
    }
    if (all) { isCap = true; break; }
  }
  if (isCap) {
    counts.cap++;
    if (samples.cap.length < 2) samples.cap.push({ t, p });
    continue;
  }
  // Strip tri: 4-corner chamfer quad, two verts on one cube face plane
  // and the third on the adjacent cube face plane (or all three on a
  // 45° tilted plane between two cube faces). Check: at least one axis
  // has TWO of the three at ±0.5 in that axis (the strip's chamfer
  // line touches the cube face).
  let isStrip = false;
  for (const axis of [0,1,2]) {
    for (const val of [-0.5, 0.5]) {
      let count = 0;
      for (const v of p) if (onPlane(v, axis, val)) count++;
      if (count >= 2) { isStrip = true; break; }
    }
    if (isStrip) break;
  }
  if (isStrip) {
    counts.strip++;
    if (samples.strip.length < 2) samples.strip.push({ t, p });
    continue;
  }
  counts.other++;
  if (samples.other.length < 4) samples.other.push({ t, p });
}

console.log('triangle classification:', counts);
console.log('\nsample face tris:'); for (const s of samples.face) console.log(`  t${s.t}:`, JSON.stringify(s.p));
console.log('\nsample strip tris:'); for (const s of samples.strip) console.log(`  t${s.t}:`, JSON.stringify(s.p));
console.log('\nsample cap tris:'); for (const s of samples.cap) console.log(`  t${s.t}:`, JSON.stringify(s.p));
if (samples.other.length) {
  console.log('\nsample "other" tris (degenerate? unexpected?):');
  for (const s of samples.other) console.log(`  t${s.t}:`, JSON.stringify(s.p));
}
