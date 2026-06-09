import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue, PointCloudValue, PolygonValue } from '../core/resources.js';

// Subdivide each polygon edge into LOTS sized to a list of candidate
// widths. Each lot gets one slot along the edge wide enough for one
// building of that width; smaller widths fill the leftover at the end.
// Compared to `polygon-perimeter-points` (uniform spacing of identical
// instances), this emits per-lot widths so a downstream for-each-point
// can place a DIFFERENTLY-SIZED building at each lot — the Houdini-
// style "every lot on the block is its own thing" pattern.
//
// Outputs three clouds, all index-aligned (cloud[i] is lot i):
//   • points   — PointCloud (positions = lot centre on the edge,
//                normals = (0,1,0), tangents = inward direction)
//   • widths   — FloatCloud (each lot's edge-axis extent in metres)
//   • type_indices — FloatCloud (which entry in `widths_list` the lot
//                was picked from; downstream wires this into a
//                `core/scene-switch.index` so each lot picks the
//                matching building variant)
//
// Reproducibility: lot picks are deterministic from `seed` + per-edge
// vertex coordinates, so a re-eval of the same polygon yields the same
// lot layout. The eval cache batches identical-width buildings across
// lots and across polygons; widths_list should therefore be SHORT (~4
// entries) so cache hits are common and N*M lots collapse to ~N
// unique GPU geometries.

function len2(x: number, z: number): number {
  return Math.sqrt(x * x + z * z);
}

// Tiny deterministic hash → [0, 1). xorshift on a 32-bit state mixed
// from the seed and per-call counter. Not cryptographic — just enough
// scramble so a +1 in the seed reshuffles every lot's pick.
function hashedRand(seed: number, counter: number): number {
  let x = (seed * 2654435761 + counter * 1597334677) | 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  // Map to [0, 1) — divide by 2^32 with the unsigned conversion.
  return ((x >>> 0) % 1_000_003) / 1_000_003;
}

export const polygonEdgeLotsNode: NodeDef = {
  id: 'core/polygon-edge-lots',
  category: 'Polygon',
  inputs: [
    {
      name: 'polygon',
      type: 'Polygon',
      description: 'polygon whose outer ring is subdivided into lots',
    },
    {
      name: 'widths_list',
      type: 'Vec3',
      default: [12, 18, 24],
      description: 'candidate lot widths to choose from. As a Vec3, each component is one candidate width in metres (so up to 3 building footprints, matching the buildings you wire into the downstream scene-switch). Lots are picked at random from this list and trimmed to fit the remaining edge length',
    },
    {
      name: 'corner_clearance',
      type: 'Float',
      default: 0,
      min: 0,
      description: 'minimum gap from each polygon corner before the first lot can start. Set to `max_building_inward_extent` so a lot near a corner can\'t poke past the vertex into the adjacent edge',
    },
    {
      name: 'gap',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'separation between adjacent lots on the same edge, in metres. 1 m reads as a clean alley between buildings',
    },
    {
      name: 'seed',
      type: 'Int',
      default: 0,
      description: 'random seed mixed into the per-lot pick. Same seed + same polygon = same lot layout — eval cache shares geometry across re-evaluations',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'one point per lot. position = lot centre on the polygon edge, normal = (0,1,0), tangent = inward direction',
    },
    {
      name: 'widths',
      type: 'FloatCloud',
      description: 'per-lot edge-axis extent in metres (same index as `points`)',
    },
    {
      name: 'mask_0',
      type: 'FloatCloud',
      description: 'per-point 1/0 mask: 1 at lots picked from `widths_list.x`, 0 elsewhere. Wire into `core/instance-scene-on-points.per_point_active` for the variant-0 scatter',
    },
    {
      name: 'mask_1',
      type: 'FloatCloud',
      description: 'per-point 1/0 mask: 1 at lots picked from `widths_list.y`, 0 elsewhere',
    },
    {
      name: 'mask_2',
      type: 'FloatCloud',
      description: 'per-point 1/0 mask: 1 at lots picked from `widths_list.z`, 0 elsewhere',
    },
  ],
  doc: {
    summary: 'Subdivide a polygon\'s outer ring into per-lot building footprints.',
    description: `
For each edge, walks from one corner (offset by \`corner_clearance\`)
to the other, picking a random width from \`widths_list\` at each step
until the remaining space is smaller than the smallest candidate.
Each lot gets a position (centre of its slot), an inward-facing
tangent, and the index of the variant it was assigned to.

Pair with [core/for-each-point](../../core/for-each-point) and
[core/scene-switch](../../core/scene-switch) for the canonical
"different building per lot" composition: each lot drives a separate
body invocation, and the variant chosen matches the reserved width.
`,
    sampleGraph: () => {
      const g = createGraph();
      const aabb = addNode(g, 'core/polygon-aabb', {
        id: 'aabb',
        position: { x: 0, y: 0 },
        inputValues: { center: [0, 0], size: [80, 80] },
      });
      const lots = addNode(g, 'core/polygon-edge-lots', {
        id: 'lots',
        position: { x: 280, y: 0 },
        inputValues: { widths_list: [12, 18, 24], corner_clearance: 4, gap: 1, seed: 7 },
      });
      addEdge(g, { node: aabb.id, socket: 'polygon' }, { node: lots.id, socket: 'polygon' });
      return { graph: g, rootNodeId: 'lots' };
    },
  },
  evaluate(_ctx, inputs): {
    points: PointCloudValue;
    widths: FloatCloudValue;
    mask_0: FloatCloudValue;
    mask_1: FloatCloudValue;
    mask_2: FloatCloudValue;
  } {
    const emptyCloud = { count: 0, values: new Float32Array(0) };
    const empty = {
      points: {
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        tangents: new Float32Array(0),
        count: 0,
      },
      widths: emptyCloud,
      mask_0: emptyCloud,
      mask_1: emptyCloud,
      mask_2: emptyCloud,
    };
    const poly = inputs.polygon as PolygonValue | undefined;
    if (!poly || poly.outer.length < 6) return empty;
    // widths_list arrives as a Vec3 ([w0, w1, w2]); the index in the
    // ORIGINAL slot matters (mask_i emits 1 for lots that picked
    // slot i). A non-positive slot is treated as "disabled" — its
    // mask is always empty and it doesn't get picked for any lot.
    const widthsRaw = inputs.widths_list as unknown;
    const slots: number[] = [];
    if (Array.isArray(widthsRaw)) {
      slots[0] = Number(widthsRaw[0] ?? 0);
      slots[1] = Number(widthsRaw[1] ?? 0);
      slots[2] = Number(widthsRaw[2] ?? 0);
    } else if (typeof widthsRaw === 'number') {
      slots[0] = slots[1] = slots[2] = widthsRaw;
    } else {
      slots[0] = slots[1] = slots[2] = 0;
    }
    const enabledSlots = slots
      .map((w, i) => ({ width: w, slot: i }))
      .filter((s) => Number.isFinite(s.width) && s.width > 0);
    if (enabledSlots.length === 0) return empty;

    const cornerClearance = Math.max(0, (inputs.corner_clearance as number) ?? 0);
    const gap = Math.max(0, (inputs.gap as number) ?? 0);
    const seed = ((inputs.seed as number) | 0) || 1;

    const outer = poly.outer;
    const n = outer.length / 2;

    const positions: number[] = [];
    const tangents: number[] = [];
    const widths: number[] = [];
    // Per-lot slot index (0..2) — used after the walk to populate the
    // three mask outputs.
    const slotIndices: number[] = [];

    let counter = 0; // bumped per random pick so consecutive picks differ
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const startX = outer[i * 2]!;
      const startZ = outer[i * 2 + 1]!;
      const dx = outer[j * 2]! - startX;
      const dz = outer[j * 2 + 1]! - startZ;
      const edgeLen = len2(dx, dz);
      if (edgeLen < 1e-12) continue;
      const usable = edgeLen - 2 * cornerClearance;
      if (usable <= 0) continue;
      const dxN = dx / edgeLen;
      const dzN = dz / edgeLen;
      // Inward = +90° (CCW) of edge direction in XZ. Matches
      // polygon-perimeter-points' inward convention so building
      // bodies share a single "local +X aligns to inward" rule.
      const inwardX = -dzN;
      const inwardZ =  dxN;

      // Walk the usable span, accumulating lots until we'd run past
      // the end. `cursor` is the offset along the edge where the
      // NEXT lot's leading edge sits.
      let cursor = cornerClearance;
      const endOfUsable = cornerClearance + usable;
      while (cursor < endOfUsable - 1e-6) {
        const remaining = endOfUsable - cursor;
        const fits = enabledSlots.filter((s) => s.width <= remaining + 1e-6);
        if (fits.length === 0) break;
        const r = hashedRand(seed, counter++);
        const chosen = fits[Math.floor(r * fits.length)]!;
        const arcCentre = cursor + chosen.width * 0.5;
        positions.push(
          startX + dxN * arcCentre, 0,
          startZ + dzN * arcCentre,
        );
        tangents.push(inwardX, 0, inwardZ);
        widths.push(chosen.width);
        slotIndices.push(chosen.slot);
        cursor += chosen.width + gap;
      }
    }

    const count = widths.length;
    if (count === 0) return empty;

    const normals = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) normals[i * 3 + 1] = 1;
    const masks = [
      new Float32Array(count),
      new Float32Array(count),
      new Float32Array(count),
    ];
    for (let i = 0; i < count; i++) {
      const s = slotIndices[i]!;
      if (s >= 0 && s < 3) masks[s]![i] = 1;
    }
    return {
      points: {
        positions: new Float32Array(positions),
        normals,
        tangents: new Float32Array(tangents),
        count,
      },
      widths: { count, values: new Float32Array(widths) },
      mask_0: { count, values: masks[0]! },
      mask_1: { count, values: masks[1]! },
      mask_2: { count, values: masks[2]! },
    };
  },
};
