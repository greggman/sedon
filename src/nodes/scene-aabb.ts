import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { SceneEntity, SceneValue } from '../core/resources.js';

// Measure the WORLD-space axis-aligned bounding box of an entire
// Scene. Walks every entity, transforms its mesh vertices by the
// entity's 4×4 world transform, and accumulates the component-wise
// min and max across the entire scene.
//
// Cost: O(entities × vertices). Cached by the eval cache when the
// upstream scene's fingerprint is stable (which is the common case
// during interactive editing — you only pay it once after a real
// edit). Entities without CPU mesh data are silently skipped.
//
// World space because Scene is a renderable, post-transform value.
// For pre-transform geometry-local bounds use geom/aabb on the
// authored mesh instead.

export const sceneAabbNode: NodeDef = {
  id: 'scene/aabb',
  category: 'Scene',
  inputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'scene whose entities will be measured in world space',
    },
  ],
  outputs: [
    { name: 'min',    type: 'Vec3', description: 'component-wise minimum across every entity\'s transformed mesh' },
    { name: 'max',    type: 'Vec3', description: 'component-wise maximum across every entity\'s transformed mesh' },
    { name: 'centre', type: 'Vec3', description: '(min + max) / 2 — the world-space AABB centre' },
    { name: 'size',   type: 'Vec3', description: 'max − min — the world-space AABB extents per axis' },
  ],
  doc: {
    summary: 'World-space axis-aligned bounding box of a Scene.',
    description: `
For each entity in the scene, transforms every vertex of its mesh by
the entity's column-major 4×4 transform and accumulates the
component-wise min and max. Outputs the world-space \`min\`, \`max\`,
\`centre\`, and \`size\` of the whole scene.

Use \`centre\` to frame a camera target at the scene's middle; use
\`size\` (via [math/floats-from-vec3](../../math/floats-from-vec3))
to compute a fit-distance from the largest extent.

Entities without CPU-side mesh data are silently skipped — the
result is the AABB of whatever the renderer can read on the CPU.
Empty scene → all four outputs are the zero vector.
`,
    sampleGraph: () => {
      const g = createGraph();
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 0 },
        inputValues: { size: 1 },
      });
      const mat = addNode(g, 'material/pbr', {
        id: 'mat',
        position: { x: 0, y: 180 },
        inputValues: { roughness: 0.6 },
      });
      const ent = addNode(g, 'scene/entity', {
        id: 'ent',
        position: { x: 280, y: 90 },
      });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
      addEdge(g, { node: mat.id,  socket: 'material' }, { node: ent.id, socket: 'material' });
      const bb = addNode(g, 'scene/aabb', {
        id: 'bb',
        position: { x: 560, y: 90 },
      });
      addEdge(g, { node: ent.id, socket: 'scene' }, { node: bb.id, socket: 'scene' });
      return { graph: g, rootNodeId: 'bb' };
    },
  },
  evaluate(_ctx, inputs): {
    min: [number, number, number];
    max: [number, number, number];
    centre: [number, number, number];
    size: [number, number, number];
  } {
    const scene = inputs.scene as SceneValue | undefined;
    const entities = scene?.entities ?? [];
    let any = false;
    let minX = 0, minY = 0, minZ = 0, maxX = 0, maxY = 0, maxZ = 0;
    for (const e of entities) {
      const updated = accumulateEntity(e, any, minX, minY, minZ, maxX, maxY, maxZ);
      if (!updated) continue;
      any = true;
      [minX, minY, minZ, maxX, maxY, maxZ] = updated;
    }
    if (!any) {
      return { min: [0, 0, 0], max: [0, 0, 0], centre: [0, 0, 0], size: [0, 0, 0] };
    }
    return {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      centre: [(minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5],
      size: [maxX - minX, maxY - minY, maxZ - minZ],
    };
  },
};

// Apply entity.transform to every vertex of entity.geometry.mesh and
// fold into the running min/max. Returns the updated min/max tuple
// when the entity contributed at least one vertex, or null otherwise
// (no CPU mesh data, or empty positions). Inlined here rather than
// in render/mesh.ts because the transform isn't a full TRS-builder —
// just a 4×4 matrix multiply on each position.
function accumulateEntity(
  e: SceneEntity,
  any: boolean,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): [number, number, number, number, number, number] | null {
  const positions = e.geometry?.mesh?.positions;
  if (!positions || positions.length < 3) return null;
  const m = e.transform;
  // Column-major: M[col*4 + row].
  const m00 = m[0]!,  m10 = m[1]!,  m20 = m[2]!;
  const m01 = m[4]!,  m11 = m[5]!,  m21 = m[6]!;
  const m02 = m[8]!,  m12 = m[9]!,  m22 = m[10]!;
  const m03 = m[12]!, m13 = m[13]!, m23 = m[14]!;
  for (let i = 0; i < positions.length; i += 3) {
    const px = positions[i]!, py = positions[i + 1]!, pz = positions[i + 2]!;
    const wx = m00 * px + m01 * py + m02 * pz + m03;
    const wy = m10 * px + m11 * py + m12 * pz + m13;
    const wz = m20 * px + m21 * py + m22 * pz + m23;
    if (!any) {
      minX = wx; maxX = wx;
      minY = wy; maxY = wy;
      minZ = wz; maxZ = wz;
      any = true;
    } else {
      if (wx < minX) minX = wx; else if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy; else if (wy > maxY) maxY = wy;
      if (wz < minZ) minZ = wz; else if (wz > maxZ) maxZ = wz;
    }
  }
  return [minX, minY, minZ, maxX, maxY, maxZ];
}
