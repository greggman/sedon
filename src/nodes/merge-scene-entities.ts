import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type {
  GeometryValue,
  MaterialValue,
  SceneEntity,
  SceneValue,
} from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { identity } from '../render/mat4.js';
import { mergeMeshes, transformMesh, uploadMeshToGpu, type CpuMesh } from '../render/mesh.js';

// Apply a 4x4 column-major transform to a CpuMesh, baking it into vertex
// positions and normals. Used by merge-scene-entities to flatten per-entity
// transforms into the merged mesh's vertex data.
function applyTransformToMesh(mesh: CpuMesh, m: Float32Array): CpuMesh {
  // Decompose into translate + rotate + scale ish — actually cheaper to apply
  // the matrix directly. For positions: m * (x, y, z, 1). For normals: rotate
  // by the matrix's 3x3 (assumes uniform scale; non-uniform scale would need
  // inverse-transpose).
  const positions = new Float32Array(mesh.positions.length);
  const normals = new Float32Array(mesh.normals.length);

  const m00 = m[0]!, m10 = m[1]!, m20 = m[2]!;
  const m01 = m[4]!, m11 = m[5]!, m21 = m[6]!;
  const m02 = m[8]!, m12 = m[9]!, m22 = m[10]!;
  const m03 = m[12]!, m13 = m[13]!, m23 = m[14]!;

  for (let i = 0; i < mesh.positions.length; i += 3) {
    const px = mesh.positions[i]!;
    const py = mesh.positions[i + 1]!;
    const pz = mesh.positions[i + 2]!;
    positions[i]     = m00 * px + m01 * py + m02 * pz + m03;
    positions[i + 1] = m10 * px + m11 * py + m12 * pz + m13;
    positions[i + 2] = m20 * px + m21 * py + m22 * pz + m23;

    const nx = mesh.normals[i]!;
    const ny = mesh.normals[i + 1]!;
    const nz = mesh.normals[i + 2]!;
    let rx = m00 * nx + m01 * ny + m02 * nz;
    let ry = m10 * nx + m11 * ny + m12 * nz;
    let rz = m20 * nx + m21 * ny + m22 * nz;
    const len = Math.hypot(rx, ry, rz) || 1;
    normals[i]     = rx / len;
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

// Group entities by (material, tint) and merge each group's geometries (with
// their per-entity transforms baked into the vertices) into one mesh. Output
// is a Scene with one entity per unique (material, tint) — useful when you
// have many scattered things sharing materials and want them as a single
// mesh per material for downstream operations or fewer draw calls.
//
// Tint participates in the group key because it can't be baked into vertex
// data (no per-vertex color attribute today). Two entities with same material
// but different tints stay as separate output entities.
export const mergeSceneEntitiesNode: NodeDef = {
  id: 'scene/merge-entities',
  category: 'Scene',
  // Re-stamps provenance to this merge node + ctx.subgraphPath, so the
  // cached output depends on context.
  provenanceDependent: true,
  inputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'input scene whose entities will be grouped + flattened. Every entity must have CPU-side mesh data — feed [geom/heightfield-from-texture](../../geom/heightfield-from-texture) outputs through with `cpu_access: true`, primitive geometries have it by default',
    },
  ],
  outputs: [
    {
      name: 'scene',
      type: 'Scene',
      description: 'a new scene with one entity per unique (material, tint) pair. Each output entity holds a single merged mesh with every input entity\'s transform baked into its vertices',
    },
  ],
  doc: {
    summary: 'Flatten a Scene into one merged mesh per (material, tint) group.',
    description: `
Takes a Scene with many entities, groups them by their (material, tint)
pair, bakes each entity's per-entity transform into the vertices, and
merges every group's meshes into one. Output is a new Scene with one
entity per unique group — same visual result as the input, but fewer
draw calls.

The classic use: a [scene/instance-on-points](../../scene/instance-on-points)
that scatters 5,000 trees produces 5,000 entities, all sharing the same
material. Run the result through this node and you get a single mesh
covering all 5,000 trunks — one draw call instead of 5,000.

Tint participates in the group key because it can't be baked into
vertex data (no per-vertex colour attribute today). Two entities with
the same material but different tints stay as separate output entities.

Caveats:
- Every input entity needs CPU-side mesh data (\`geometry.mesh\` must
  be populated). Primitives have it by default; GPU-native sources
  like [geom/heightfield-from-texture](../../geom/heightfield-from-texture) need
  \`cpu_access: true\`.
- The merge throws away per-source identity. Picking a merged entity
  routes back to THIS merge node, not the original scene-entity that
  contributed the geometry.
- For a non-flattening combine, use
  [scene/merge](../../scene/merge) instead — it just
  concatenates entity lists without re-meshing.
`,
    sampleGraph: () => {
      const g = createGraph();
      const sphere = addNode(g, 'geom/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 0.4, segments: 24, rings: 12 },
      });
      const cube = addNode(g, 'geom/cube', {
        id: 'cube',
        position: { x: 0, y: 200 },
        inputValues: { size: 0.6 },
      });
      // Two entities sharing the same material — that's the case the
      // merge actually collapses into one mesh. material/pbr needs a
      // basecolor texture, not optional.
      const basecolor = addNode(g, 'tex/solid-color', {
        id: 'basecolor',
        position: { x: 0, y: 400 },
        inputValues: { color: [0.55, 0.62, 0.45, 1], resolution: 32 },
      });
      const mat = addNode(g, 'material/pbr', {
        id: 'mat',
        position: { x: 280, y: 400 },
        inputValues: { roughness: 0.6, metallic: 0 },
      });
      const entA = addNode(g, 'scene/entity', {
        id: 'entA',
        position: { x: 560, y: 0 },
        inputValues: {},
      });
      const entB = addNode(g, 'scene/entity', {
        id: 'entB',
        position: { x: 560, y: 220 },
        inputValues: {},
      });
      const sceneMerge = addNode(g, 'scene/merge', {
        id: 'scenes',
        position: { x: 840, y: 110 },
        inputValues: {},
      });
      const flatten = addNode(g, 'scene/merge-entities', {
        id: 'flatten',
        position: { x: 1120, y: 110 },
        inputValues: {},
      });
      addEdge(g, { node: basecolor.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: entA.id, socket: 'geometry' });
      addEdge(g, { node: mat.id, socket: 'material' }, { node: entA.id, socket: 'material' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: entB.id, socket: 'geometry' });
      addEdge(g, { node: mat.id, socket: 'material' }, { node: entB.id, socket: 'material' });
      addEdge(g, { node: entA.id, socket: 'scene' }, { node: sceneMerge.id, socket: 'scenes' });
      addEdge(g, { node: entB.id, socket: 'scene' }, { node: sceneMerge.id, socket: 'scenes' });
      addEdge(g, { node: sceneMerge.id, socket: 'scene' }, { node: flatten.id, socket: 'scene' });
      return { graph: g, rootNodeId: 'flatten' };
    },
  },
  evaluate(ctx, inputs): { scene: SceneValue } {
    const device = requireDevice(ctx);
    const scene = inputs.scene as SceneValue;

    interface Group {
      material: MaterialValue;
      tint: Float32Array;
      meshes: CpuMesh[];
    }
    const groups = new Map<string, Group>();
    for (const entity of scene.entities) {
      if (!entity.geometry.mesh) {
        throw new Error(
          'scene/merge-entities requires CPU-side meshes on every ' +
            'entity; one of the upstream geometries is GPU-only.',
        );
      }
      const baked = applyTransformToMesh(entity.geometry.mesh, entity.transform);
      // Compose the key from material identity + tint values. Material is by
      // reference (not interned), so we lean on a side table to map MaterialValue
      // identity to a stable token.
      const key = `${materialKey(entity.material)}|${tintKey(entity.tint)}`;
      let group = groups.get(key);
      if (!group) {
        group = { material: entity.material, tint: entity.tint, meshes: [] };
        groups.set(key, group);
      }
      group.meshes.push(baked);
    }

    const out: SceneEntity[] = [];
    for (const group of groups.values()) {
      let merged = group.meshes[0]!;
      for (let i = 1; i < group.meshes.length; i++) {
        merged = mergeMeshes(merged, group.meshes[i]!);
      }
      const geometry: GeometryValue = uploadMeshToGpu(device, merged);
      // Merge throws away per-source identity — the output is one mesh
      // per (material, tint), so picking it routes to this merge node
      // rather than any of the originals. Placements are dropped for
      // the same reason: a single merged mesh has no per-instance
      // discriminator.
      out.push({
        geometry,
        material: group.material,
        transform: identity(),
        tint: group.tint,
        provenance: {
          originNodeId: ctx.nodeId ?? '<unknown>',
          subgraphPath: (ctx.subgraphPath ?? []).slice(),
          placements: [],
        },
      });
    }

    return { scene: { entities: out } };
  },
};

const materialIds = new WeakMap<MaterialValue, number>();
let nextMaterialId = 0;
function materialKey(m: MaterialValue): string {
  let id = materialIds.get(m);
  if (id === undefined) {
    id = nextMaterialId++;
    materialIds.set(m, id);
  }
  return `m${id}`;
}

function tintKey(t: Float32Array): string {
  return `${t[0]},${t[1]},${t[2]},${t[3]}`;
}

// Suppress unused import warnings for transformMesh — kept for symmetry with
// the imports list but currently bake-via-applyTransformToMesh handles the
// per-entity transform locally to keep mesh.ts focused on its own helpers.
void transformMesh;
