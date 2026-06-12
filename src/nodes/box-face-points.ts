import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { PointCloudValue } from '../core/resources.js';

// Grid of points across ONE face of an axis-aligned box, with
// orientation data so a downstream `scene/instance-on-points`
// places facade modules (windows, AC units, signs, fire-escape
// brackets, etc.) flush with the wall and facing outward.
//
// One face per node call. For "windows on all 4 vertical walls" the
// user instantiates four box-face-points (one per ±X, ±Z face) and
// scene-merges the resulting scatters. This is the deliberate
// primitive — flexible enough that ALL building details (top vents,
// roof billboards, sidewalk-level signs on the -Y face, etc.)
// compose from the same building block.
//
// Orientation convention (matches `points/polygon-perimeter`
// and `points/from-polyline` so downstream `instance-scene-on-points`
// with `align: true` Just Works):
//
//   • position — grid cell centre in WORLD space, optionally pushed
//                outward along the face normal by `offset` so the
//                placed module sits flush against the wall rather
//                than half-buried inside it.
//   • normal   — the face's OUTWARD direction. Instances' local +Y
//                ends up aligned with this, so a window authored
//                with "local +Y = facing the viewer" reads as facing
//                outward when placed.
//   • tangent  — a HORIZONTAL direction on the face plane. For
//                vertical walls (±X, ±Z) this is chosen so the
//                bitangent (cross(T,N)) points world-up, so a
//                window authored with "local +Z = up" stays upright.
//                For horizontal faces (±Y) world-up isn't a useful
//                hint; tangent falls back to +X.

interface Face {
  // Outward normal in world coords.
  normal: [number, number, number];
  // World-space tangent direction (one of the face's in-plane axes).
  tangent: [number, number, number];
  // Box-local half-extents that span the face plane along (T, B).
  // T = tangent, B = bitangent = cross(T, N). These determine the
  // grid's u/v extents.
  uHalf: number; // half-extent along T
  vHalf: number; // half-extent along B
  // Box-local centre of the face (= halfExtent of `normal`'s axis,
  // signed by face direction).
  center: [number, number, number];
}

// Map an axis-vector input to one of the 6 box faces. `axis` is
// expected near-unit and near-axis-aligned; we snap to the largest
// component to be tolerant of user-authored values like (1, 0.01, 0).
function resolveFace(axis: [number, number, number], width: number, height: number, depth: number): Face | null {
  const ax = Math.abs(axis[0]);
  const ay = Math.abs(axis[1]);
  const az = Math.abs(axis[2]);
  const hx = width  * 0.5;
  const hy = height * 0.5;
  const hz = depth  * 0.5;
  if (ax >= ay && ax >= az) {
    const sign = axis[0] >= 0 ? 1 : -1;
    return {
      normal:  [sign, 0, 0],
      tangent: [0, 0, sign], // chosen so B = cross(T, N) = +Y
      uHalf: hz, vHalf: hy,
      center: [sign * hx, 0, 0],
    };
  }
  if (az >= ax && az >= ay) {
    const sign = axis[2] >= 0 ? 1 : -1;
    return {
      normal:  [0, 0, sign],
      tangent: [-sign, 0, 0], // B = cross(T, N) = +Y
      uHalf: hx, vHalf: hy,
      center: [0, 0, sign * hz],
    };
  }
  if (ay >= ax && ay >= az) {
    const sign = axis[1] >= 0 ? 1 : -1;
    return {
      normal:  [0, sign, 0],
      tangent: [1, 0, 0], // horizontal face — world-up isn't useful, just pick +X
      uHalf: hx, vHalf: hz,
      center: [0, sign * hy, 0],
    };
  }
  return null;
}

export const boxFacePointsNode: NodeDef = {
  id: 'points/box-face',
  category: 'Geometry/Distribution',
  inputs: [
    {
      name: 'width',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'X-extent of the implicit box (the box itself isn\'t produced — this node just lays out points as if it existed). Centred on the origin like `geom/box`',
    },
    {
      name: 'height',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'Y-extent of the implicit box',
    },
    {
      name: 'depth',
      type: 'Float',
      default: 1,
      min: 0,
      description: 'Z-extent of the implicit box',
    },
    {
      name: 'axis',
      type: 'Vec3',
      default: [0, 0, 1],
      description: 'face to lay points on, named by its outward normal. Use any axis-aligned vector — (1,0,0)=+X, (-1,0,0)=-X, (0,1,0)=+Y (top), (0,-1,0)=-Y (bottom), (0,0,1)=+Z (front), (0,0,-1)=-Z (back). The largest-magnitude component snaps to one of the 6 faces, so (0.7, 0.1, 0) reads as +X',
    },
    {
      name: 'cols',
      type: 'Int',
      default: 5,
      min: 1,
      description: 'number of grid columns. The axis cols distribute along depends on the face:\n• ±X face (vertical wall): cols → world Z (horizontal along wall)\n• ±Z face (vertical wall): cols → world X (horizontal along wall)\n• ±Y face (roof / floor): cols → world X',
    },
    {
      name: 'rows',
      type: 'Int',
      default: 3,
      min: 1,
      description: 'number of grid rows. The axis rows distribute along depends on the face:\n• ±X face (vertical wall): rows → world Y (vertical UP the wall)\n• ±Z face (vertical wall): rows → world Y (vertical UP the wall)\n• ±Y face (roof / floor): rows → world Z',
    },
    {
      name: 'inset',
      type: 'Float',
      default: 0,
      min: 0,
      description: 'margin from the face\'s rectangular border. The grid is laid out inside (face_extent - 2*inset), so a small inset keeps placed modules off the corners',
    },
    {
      name: 'offset',
      type: 'Float',
      default: 0,
      description: 'distance to push every point OUTWARD along the face normal, in world units. Use a small positive value (a few cm) when the scattered module has visible depth so it sits flush rather than half-embedded in the wall',
    },
  ],
  outputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: '`rows × cols` evenly-spaced grid points on the chosen face, in WORLD coords. `normals` = face outward direction; `tangents` = horizontal direction on the face. For vertical walls the bitangent (cross(tangent, normal)) points world-up, so downstream `instance-scene-on-points(align: true)` keeps modules upright',
    },
  ],
  doc: {
    summary: 'Grid of placement points on one face of an implicit axis-aligned box.',
    description: `
The atom for facade composition. Compose a building's wall details
(windows, AC units, signs, fire-escape brackets) by:
  1. Decide the building's bulk dimensions (width × height × depth).
  2. Per wall (±X, ±Z), call \`points/box-face\` with that wall's
     \`axis\` and a (cols, rows) grid sized to your facade language.
  3. Scatter a window / AC / sign module with \`scene/instance-on-points\`,
     using \`align: true\` so each instance faces outward and stays upright.

**Picking cols/rows for a face**

The cols / rows axes vary by face. The rule: cols runs along the
face's tangent, rows along its bitangent (= cross(tangent, normal)).
Resolved per face:

  | axis        | normal | cols (tangent)  | rows (bitangent) |
  |-------------|--------|-----------------|------------------|
  | ±X (wall)   | ±X     | world Z         | world Y (up)     |
  | ±Z (wall)   | ±Z     | world X         | world Y (up)     |
  | ±Y (floor)  | ±Y     | world X         | world Z          |

So for "windows across a wall and N rows up the wall" use a vertical
face (±X or ±Z) with cols = horizontal count, rows = floor count.
For "a vertical stack of N points inside a composition graph" use
the +Y face and rows = N (the bitangent there is world Z = up).

The implicit box matches \`geom/box\`'s ±half-extent convention so the
same width/height/depth values that build the wall geometry build
the points for its facade. Combine with \`poly/edge-lots\`
(picks per-block building footprints) for a lot → building →
facade composition path.
`,
    sampleGraph: () => {
      const g = createGraph();
      // A 4 m wide × 3 m tall × 1 m deep wall, with windows in a 4 × 2
      // grid on its +Z face.
      const pts = addNode(g, 'points/box-face', {
        id: 'pts',
        position: { x: 0, y: 0 },
        inputValues: {
          width: 4, height: 3, depth: 1,
          axis: [0, 0, 1],
          cols: 4, rows: 2,
          inset: 0.4,
          offset: 0.02,
        },
      });
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 180 },
        inputValues: { size: 0.4 },
      });
      const inst = addNode(g, 'geom/instance-on-points', {
        id: 'inst',
        position: { x: 280, y: 0 },
        inputValues: { scale: 1, align: true },
      });
      addEdge(g, { node: pts.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: inst.id, socket: 'instance' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(_ctx, inputs): { points: PointCloudValue } {
    const empty: PointCloudValue = {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      tangents: new Float32Array(0),
      count: 0,
    };
    const width = Math.max(0, (inputs.width as number) ?? 0);
    const height = Math.max(0, (inputs.height as number) ?? 0);
    const depth = Math.max(0, (inputs.depth as number) ?? 0);
    if (width <= 0 || height <= 0 || depth <= 0) return { points: empty };
    const rawAxis = inputs.axis as unknown;
    let axis: [number, number, number] = [0, 0, 1];
    if (Array.isArray(rawAxis) && rawAxis.length >= 3) {
      axis = [Number(rawAxis[0]), Number(rawAxis[1]), Number(rawAxis[2])];
    }
    const face = resolveFace(axis, width, height, depth);
    if (!face) return { points: empty };

    const cols = Math.max(1, Math.floor((inputs.cols as number) ?? 1));
    const rows = Math.max(1, Math.floor((inputs.rows as number) ?? 1));
    const inset = Math.max(0, (inputs.inset as number) ?? 0);
    const offset = (inputs.offset as number) ?? 0;

    // Usable extents inside the inset border. If the inset eats the
    // whole face, the grid collapses to a single column / row at the
    // face centre — better than emitting zero points (which would
    // hide upstream auth errors).
    const uExtent = Math.max(1e-6, face.uHalf - inset) * 2;
    const vExtent = Math.max(1e-6, face.vHalf - inset) * 2;
    const uStep = cols > 1 ? uExtent / cols : 0;
    const vStep = rows > 1 ? vExtent / rows : 0;
    const uStart = -uExtent * 0.5 + uStep * 0.5;
    const vStart = -vExtent * 0.5 + vStep * 0.5;

    // Bitangent = cross(T, N).
    const tx = face.tangent[0], ty = face.tangent[1], tz = face.tangent[2];
    const nx = face.normal[0],  ny = face.normal[1],  nz = face.normal[2];
    const bx = ty * nz - tz * ny;
    const by = tz * nx - tx * nz;
    const bz = tx * ny - ty * nx;

    const total = rows * cols;
    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    const tangents = new Float32Array(total * 3);
    let p = 0;
    for (let r = 0; r < rows; r++) {
      const v = vStart + r * vStep;
      for (let c = 0; c < cols; c++) {
        const u = uStart + c * uStep;
        // position = faceCentre + u*T + v*B + offset*N
        positions[p * 3]     = face.center[0] + u * tx + v * bx + offset * nx;
        positions[p * 3 + 1] = face.center[1] + u * ty + v * by + offset * ny;
        positions[p * 3 + 2] = face.center[2] + u * tz + v * bz + offset * nz;
        normals[p * 3]     = nx;
        normals[p * 3 + 1] = ny;
        normals[p * 3 + 2] = nz;
        tangents[p * 3]     = tx;
        tangents[p * 3 + 1] = ty;
        tangents[p * 3 + 2] = tz;
        p++;
      }
    }
    return { points: { positions, normals, tangents, count: total } };
  },
};
