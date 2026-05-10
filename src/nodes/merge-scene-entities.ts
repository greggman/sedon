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
  id: 'core/merge-scene-entities',
  category: 'Scene',
  inputs: [{ name: 'scene', type: 'Scene' }],
  outputs: [{ name: 'scene', type: 'Scene' }],
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
          'core/merge-scene-entities requires CPU-side meshes on every ' +
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
      out.push({
        geometry,
        material: group.material,
        transform: identity(),
        tint: group.tint,
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
