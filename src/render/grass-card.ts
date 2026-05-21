import type { CpuMesh } from './mesh.js';

// A grass "card" mesh: `quadCount` vertical quads intersecting at the
// origin, each rotated about +Y so the clump reads as 3D from any
// orbit angle (the classic cross-quad, vs a single camera-facing
// billboard that flattens/spins as you rotate around it).
//
// Local space, UNIT-sized — the grass vertex shader scales each
// instance by the field's `bladeSize`:
//   • base sits on y=0 (the ground anchor); tip at y=1.
//   • width spans x ∈ [-0.5, +0.5] before rotation.
//   • position.y doubles as the 0..1 "height fraction" the grass
//     shader uses for wind (only the tip sways) and the base→tip
//     colour gradient — no extra vertex attribute needed.
//
// Normals are pure +Y (sky-up), not the quad-facing direction. Grass
// lit by its facing normal goes dark on the side away from the sun and
// needs two-sided normal flipping; a sky-up normal gives the soft,
// even, stylised lighting grass usually wants and sidesteps that
// entirely. (Revisit if we want anisotropic blade shading later.)
//
// UV: V=0 at the tip (top), V=1 at the base — matching WebGPU's
// V=0-at-top sampling so a blade card authored tip-up maps the right
// way round. U spans the card width 0..1.
//
// Rendered two-sided (the grass pipeline disables back-face culling),
// so triangle winding is irrelevant here.
export function generateGrassCard(quadCount = 2): CpuMesh {
  const quads = Math.max(1, Math.floor(quadCount));
  const vertsPerQuad = 4;
  const numVerts = quads * vertsPerQuad;

  const positions = new Float32Array(numVerts * 3);
  const normals = new Float32Array(numVerts * 3);
  const uvs = new Float32Array(numVerts * 2);
  const indices = new Uint32Array(quads * 6);

  // Unit quad corners before Y-rotation, facing +Z:
  //   index 0 = base-left, 1 = base-right, 2 = tip-left, 3 = tip-right
  const baseCorners: Array<[number, number, number, number, number]> = [
    // x,    y, z, u, v
    [-0.5, 0, 0, 0, 1],
    [0.5, 0, 0, 1, 1],
    [-0.5, 1, 0, 0, 0],
    [0.5, 1, 0, 1, 0],
  ];

  let p = 0;
  let u = 0;
  let idx = 0;
  for (let q = 0; q < quads; q++) {
    // Spread quads over 180° (a two-sided quad covers both facing
    // directions, so 0..π is the full useful range).
    const angle = (q * Math.PI) / quads;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    const baseVert = q * vertsPerQuad;
    for (let c = 0; c < vertsPerQuad; c++) {
      const [x, y, z, uu, vv] = baseCorners[c]!;
      // Rotate (x, z) about +Y.
      positions[p] = x * ca + z * sa;
      positions[p + 1] = y;
      positions[p + 2] = -x * sa + z * ca;
      normals[p] = 0;
      normals[p + 1] = 1;
      normals[p + 2] = 0;
      uvs[u] = uu;
      uvs[u + 1] = vv;
      p += 3;
      u += 2;
    }
    // Two triangles: (base-left, base-right, tip-left), (tip-left,
    // base-right, tip-right).
    indices[idx++] = baseVert + 0;
    indices[idx++] = baseVert + 1;
    indices[idx++] = baseVert + 2;
    indices[idx++] = baseVert + 2;
    indices[idx++] = baseVert + 1;
    indices[idx++] = baseVert + 3;
  }

  return { positions, normals, uvs, indices };
}
