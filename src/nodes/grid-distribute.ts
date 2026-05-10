import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';

// Mulberry32: deterministic 32-bit PRNG. Used here so jitter is reproducible
// from the (seed, point-index) pair.
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

// Distribute points on a regular grid in the XZ plane, centered at the origin
// (Y = 0). Optional jitter perturbs each point within +/- (jitter * spacing/2).
// Normals are world-up (so downstream "align to normal" places instances
// upright). For city-scale demos: cols=20, rows=20, spacing=2.
export const gridDistributeNode: NodeDef = {
  id: 'core/grid-distribute',
  category: 'Geometry/Distribution',
  inputs: [
    { name: 'cols', type: 'Int', default: 10, description: 'columns along X' },
    { name: 'rows', type: 'Int', default: 10, description: 'rows along Z' },
    { name: 'spacing', type: 'Float', default: 1, description: 'distance between adjacent grid cells' },
    {
      name: 'jitter',
      type: 'Float',
      default: 0,
      description: '0 = perfect grid, 1 = full ±half-cell random offset',
    },
    { name: 'seed', type: 'Float', default: 0 },
  ],
  outputs: [{ name: 'points', type: 'PointCloud' }],
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const cols = Math.max(1, Math.floor(inputs.cols as number));
    const rows = Math.max(1, Math.floor(inputs.rows as number));
    const spacing = inputs.spacing as number;
    const jitter = inputs.jitter as number;
    const seed = inputs.seed as number;
    const rand = mulberry32(Math.floor(seed * 1_000_000) || 1);

    const count = cols * rows;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);

    // Center the grid at origin: span = (n-1)*spacing. Half-span shifts.
    const halfX = ((cols - 1) * spacing) / 2;
    const halfZ = ((rows - 1) * spacing) / 2;
    const halfCell = spacing * 0.5 * jitter;

    let p = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const jx = (rand() * 2 - 1) * halfCell;
        const jz = (rand() * 2 - 1) * halfCell;
        positions[p] = c * spacing - halfX + jx;
        positions[p + 1] = 0;
        positions[p + 2] = r * spacing - halfZ + jz;
        normals[p] = 0;
        normals[p + 1] = 1;
        normals[p + 2] = 0;
        p += 3;
      }
    }

    return { points: { positions, normals, count } };
  },
};
