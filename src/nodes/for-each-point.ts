import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef, NodeInputs } from '../core/node-def.js';
import type {
  FloatCloudValue,
  GrassFieldValue,
  PointCloudValue,
  SceneValue,
  TerrainFieldValue,
  Vec3CloudValue,
} from '../core/resources.js';
import type { SubgraphDef } from '../core/subgraph.js';

// core/for-each-point — invoke a body subgraph once per point.
//
// The point of this node: instance a SUBGRAPH (with full per-iteration
// parameters) at every point in a PointCloud, then merge the result.
// Where `core/instance-geometry-on-points` only stamps a fixed mesh
// and `core/instance-scene-on-points` only stamps a fixed scene, this
// node lets each iteration's body run a real graph with per-iteration
// inputs — so you can grow legs as a table widens, place drawers /
// shelves on per-cell variants of a bookshelf grid, drop pipe-elbow
// segments at every vertex of a spline, and so on.
//
// Body picking: the body is the wrapper kind of a subgraph (e.g.
// `subgraph/drawer`), stored on each for-each-point instance as the
// hidden `__body` inputValue. The runtime call is then just
// `ctx.registry.get(__body).evaluate(ctx, perIterationInputs)` — the
// body's wrapper handles the inner-graph recursion exactly as a
// regular wrapper would, so eval-cache fingerprinting and nested
// subgraphs work for free.
//
// Per-iteration inputs:
//   • `__position` (Vec3) and `__index` (Int) are AUTO-FED from the
//     points cloud + the iteration counter. If the body subgraph
//     declares inputs of these literal names, the for-each-point
//     hides them from its mirrored socket list and supplies them
//     directly. Other names pass through.
//   • Inputs declared as Float / Vec3 on the body are mirrored as
//     FloatCloud / Vec3Cloud on the for-each-point. A scalar wired
//     to a *Cloud socket broadcasts (every iteration gets the same
//     value); a cloud wire delivers `cloud.values[i]` per iteration.
//     See CORE_CONVERSIONS in core/types.ts for the broadcast rules.
//   • Inputs of any other type (Texture2D, Material, Scene, …) are
//     mirrored as-is and always broadcast.
//
// Output (Phase A): a single Scene merged from every iteration's
// scene output. Sidecar fields (grass, terrain, waterLevel) are
// carried through identically to core/scene-merge.

const IMPLICIT_INPUT_NAMES = new Set(['__position', '__index']);

/**
 * The set of input names that the for-each-point auto-fills per
 * iteration — so the body-input mirroring on the for-each side
 * should skip them. Exposed for the editor's setForEachBody action
 * (and any future drag-drop integration) to use the same allow-list
 * as evaluate().
 */
export function isImplicitForEachInputName(name: string): boolean {
  return IMPLICIT_INPUT_NAMES.has(name);
}

/**
 * Translate one of the body's declared input types into the
 * matching socket type used on the for-each-point's mirrored input.
 * Float → FloatCloud, Vec3 → Vec3Cloud, everything else passes
 * through unchanged (broadcast-only). The Float→FloatCloud /
 * Vec3→Vec3Cloud edge-compatibility rules let plain scalar sources
 * still wire cleanly to the cloud-typed sockets.
 */
export function liftForEachInputType(bodyInputType: string): string {
  if (bodyInputType === 'Float') return 'FloatCloud';
  if (bodyInputType === 'Vec3') return 'Vec3Cloud';
  return bodyInputType;
}

/**
 * Translate a body output's type into the type the for-each-point
 * emits on its mirrored output socket. The lifting differs from the
 * INPUT side because outputs accumulate per iteration rather than
 * broadcast:
 *   • `Scene`  → `Scene`  (merged: entity lists concatenated)
 *   • `Float`  → `FloatCloud`  (one value per iteration)
 *   • `Vec3`   → `Vec3Cloud`   (one Vec3 per iteration)
 *   • anything else → null     (no sensible lift — a "cloud of textures"
 *                              isn't a type we model; outputs of those
 *                              types simply aren't surfaced on the
 *                              for-each-point)
 *
 * Returning null means "skip this body output when building the
 * for-each-point's mirrored outputs."
 */
export function liftForEachOutputType(bodyOutputType: string): string | null {
  if (bodyOutputType === 'Scene') return 'Scene';
  if (bodyOutputType === 'Float') return 'FloatCloud';
  if (bodyOutputType === 'Vec3') return 'Vec3Cloud';
  return null;
}

function isFloatCloud(v: unknown): v is FloatCloudValue {
  return (
    typeof v === 'object' && v !== null
    && 'values' in v && 'count' in v
    && (v as FloatCloudValue).values instanceof Float32Array
    && (v as FloatCloudValue).values.length === (v as FloatCloudValue).count
  );
}

function isVec3Cloud(v: unknown): v is Vec3CloudValue {
  return (
    typeof v === 'object' && v !== null
    && 'values' in v && 'count' in v
    && (v as Vec3CloudValue).values instanceof Float32Array
    && (v as Vec3CloudValue).values.length === (v as Vec3CloudValue).count * 3
  );
}

function isSceneValue(v: unknown): v is SceneValue {
  return (
    typeof v === 'object' && v !== null
    && 'entities' in v && Array.isArray((v as SceneValue).entities)
  );
}

// Deref a per-iteration value from whatever the for-each socket
// received. Clouds are indexed; scalars / textures / materials pass
// through as broadcasts. Vec3 outputs are emitted as plain
// `[x, y, z]` arrays since that's how the eval-time representation
// of a Vec3 input is shaped elsewhere.
function pickForIteration(value: unknown, i: number, count: number): unknown {
  if (isFloatCloud(value)) {
    return i < count ? value.values[i] : 0;
  }
  if (isVec3Cloud(value)) {
    if (i >= count) return [0, 0, 0];
    const o = i * 3;
    return [value.values[o]!, value.values[o + 1]!, value.values[o + 2]!];
  }
  return value;
}

export const forEachPointNode: NodeDef = {
  id: 'core/for-each-point',
  category: 'Iteration',
  inputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description:
        'one iteration per point in this cloud. Per-iteration position is auto-fed to the body subgraph as `__position` (and the iteration index as `__index`)',
    },
    {
      // Wrapper kind of the body subgraph (e.g. `subgraph/drawer`).
      // Phase A: edited as a plain text input. Phase B will replace
      // this with a drag-an-asset-onto-the-node affordance.
      name: '__body',
      type: 'String',
      default: '',
      hidden: true,
      description:
        'internal: the body subgraph wrapper kind (drop an asset onto the node to set this)',
    },
  ],
  outputs: [
    {
      name: 'scene',
      type: 'Scene',
      description:
        'merged scene: every iteration\'s body output, concatenated. Grass / terrain / waterLevel sidecars are carried through like core/scene-merge',
    },
  ],
  doc: {
    summary:
      'Invoke a body subgraph once per point in a PointCloud and merge the result.',
    sampleGraph: buildForEachPointSample,
    description: `
Iterates a body subgraph N times — once per point in the wired
\`points\` cloud — and merges every iteration\'s scene output into a
single \`Scene\`. Each iteration\'s body receives the per-iteration
\`__position\` (Vec3) and \`__index\` (Int) implicitly, plus any
mirrored body inputs from the for-each-point\'s wired sockets.

Mirrored sockets: when a body is set, the for-each-point exposes one
extra socket per body input. \`Float\` body inputs mirror as
\`FloatCloud\` (per-iteration value); \`Vec3\` body inputs mirror as
\`Vec3Cloud\`. Other types (\`Texture2D\`, \`Material\`, \`Scene\`, …)
mirror as-is and broadcast — the same value flows into every
iteration. A scalar wired to a \`FloatCloud\` / \`Vec3Cloud\` socket
broadcasts to all iterations (see the \`Float → FloatCloud\` and
\`Vec3 → Vec3Cloud\` rules in core/types.ts).
`,
  },
  async evaluate(ctx, inputs): Promise<Record<string, unknown>> {
    const pc = inputs.points as PointCloudValue | undefined;
    const bodyKind = (inputs.__body as string | undefined) ?? '';
    if (!pc || pc.count === 0 || !bodyKind) {
      // The fallback output shape — `scene: {entities:[]}` — covers
      // the "no body wired yet" case the static def.outputs declares.
      // Once a body IS set, extraOutputs replaces def.outputs and
      // downstream consumers read whatever the body's outputs were
      // lifted to. The empty fallback here doesn't conflict because
      // an empty-body for-each can't have any wired outgoing edges
      // anyway.
      return { scene: { entities: [] } };
    }

    const bodyDef = ctx.registry?.get(bodyKind);
    if (!bodyDef) {
      // Body wrapper isn't in the registry (renamed / deleted
      // subgraph, or a typo in __body). Emit empty values rather
      // than throw — partial / mid-edit graphs should still preview.
      return { scene: { entities: [] } };
    }

    const n = pc.count;

    // One accumulator per body output, typed by what the output
    // lifts to. Each output is built up independently per iteration
    // so a body with multiple outputs (e.g. `result_scene` plus a
    // computed `area: Float`) lifts each one to the right cloud /
    // merged type without conflating them.
    interface SceneAcc {
      kind: 'Scene';
      entities: SceneValue['entities'];
      grass: GrassFieldValue[];
      terrain: TerrainFieldValue[];
      waterLevel: number | undefined;
    }
    interface FloatAcc { kind: 'Float'; values: Float32Array }
    interface Vec3Acc { kind: 'Vec3'; values: Float32Array }
    type Acc = SceneAcc | FloatAcc | Vec3Acc;
    const accumulators = new Map<string, Acc>();
    for (const o of bodyDef.outputs) {
      if (o.type === 'Scene') {
        accumulators.set(o.name, {
          kind: 'Scene',
          entities: [],
          grass: [],
          terrain: [],
          waterLevel: undefined,
        });
      } else if (o.type === 'Float') {
        accumulators.set(o.name, { kind: 'Float', values: new Float32Array(n) });
      } else if (o.type === 'Vec3') {
        accumulators.set(o.name, { kind: 'Vec3', values: new Float32Array(n * 3) });
      }
      // Non-cloudable output types (Texture2D, Material, …) silently
      // skipped: their "cloud of N textures" lift doesn't exist as a
      // type, so we don't emit a socket for them on the for-each
      // side either (setForEachBody's `liftForEachOutputType` returns
      // null for these, mirroring this decision in the editor).
    }

    for (let i = 0; i < n; i++) {
      // Per-iteration inputs: __position / __index auto-fed; every
      // other body input pulls its value from `inputs[name]` on the
      // for-each-point's side, indexing into cloud-typed values.
      const iterInputs: NodeInputs = {};
      for (const bodyInput of bodyDef.inputs) {
        if (bodyInput.name === '__position') {
          const o = i * 3;
          iterInputs.__position = [pc.positions[o]!, pc.positions[o + 1]!, pc.positions[o + 2]!];
          continue;
        }
        if (bodyInput.name === '__index') {
          iterInputs.__index = i;
          continue;
        }
        const wired = inputs[bodyInput.name];
        if (wired === undefined) {
          iterInputs[bodyInput.name] = bodyInput.default;
        } else {
          iterInputs[bodyInput.name] = pickForIteration(wired, i, n);
        }
      }

      // Per-iteration ctx: the body wrapper forwards `ctx.inputFingerprints`
      // into the inner eval as `subgraphInputFingerprints`, which the
      // boundary-input node mixes into its own fingerprint. The
      // for-each-point's OWN inputFingerprints are constant across
      // iterations (they describe the cloud-shaped wired values, not
      // per-iteration scalars), so without an iteration-specific bump
      // every inner node's fingerprint matches across iterations →
      // the eval cache returns the same GeometryValue for all N body
      // calls → the renderer batches all entities at one position.
      // Stamping `__iter` into the per-call inputFingerprints map
      // makes each iteration's inner boundary fp unique without
      // requiring us to fingerprint heterogeneous per-iter values
      // (Vec3 arrays, Material refs, etc.) ourselves.
      const iterCtx = {
        ...ctx,
        inputFingerprints: {
          ...(ctx.inputFingerprints ?? {}),
          __iter: `${i}`,
        },
      };
      const result = await bodyDef.evaluate(iterCtx, iterInputs);
      const resultMap = result as Record<string, unknown>;
      // Distribute this iteration's outputs into the per-output
      // accumulators. Missing values from the body skip the slot for
      // this iteration (Float clouds get 0, Vec3 clouds get [0,0,0]).
      for (const o of bodyDef.outputs) {
        const acc = accumulators.get(o.name);
        if (!acc) continue;
        const v = resultMap[o.name];
        if (acc.kind === 'Scene') {
          if (!isSceneValue(v)) continue;
          acc.entities.push(...v.entities);
          if (v.grass) acc.grass.push(...v.grass);
          if (v.terrain) acc.terrain.push(...v.terrain);
          if (typeof v.waterLevel === 'number') {
            acc.waterLevel = acc.waterLevel === undefined
              ? v.waterLevel
              : Math.max(acc.waterLevel, v.waterLevel);
          }
        } else if (acc.kind === 'Float') {
          if (typeof v === 'number') acc.values[i] = v;
        } else if (acc.kind === 'Vec3') {
          if (Array.isArray(v) && v.length >= 3) {
            const o3 = i * 3;
            acc.values[o3] = typeof v[0] === 'number' ? v[0] : 0;
            acc.values[o3 + 1] = typeof v[1] === 'number' ? v[1] : 0;
            acc.values[o3 + 2] = typeof v[2] === 'number' ? v[2] : 0;
          }
        }
      }
    }

    // Materialise the accumulators into the final outputs object.
    const out: Record<string, unknown> = {};
    for (const [name, acc] of accumulators) {
      if (acc.kind === 'Scene') {
        const scene: SceneValue = { entities: acc.entities };
        if (acc.grass.length > 0) scene.grass = acc.grass;
        if (acc.terrain.length > 0) scene.terrain = acc.terrain;
        if (acc.waterLevel !== undefined) scene.waterLevel = acc.waterLevel;
        out[name] = scene;
      } else if (acc.kind === 'Float') {
        out[name] = { values: acc.values, count: n } satisfies FloatCloudValue;
      } else if (acc.kind === 'Vec3') {
        out[name] = { values: acc.values, count: n } satisfies Vec3CloudValue;
      }
    }
    return out;
  },
};

// Docs sample: a 3×3 grid of small red cubes, each stamped by a tiny
// `docs-fep-cube` body subgraph that takes only the implicit
// `__position` input. Kept self-contained — the body builds its own
// material from a solid-color so the sample needs no external wires
// AND demonstrates the "body is a subgraph with its own internal
// machinery" point of the node. Defined as a function so the sample
// allocates fresh objects per render (matches how other sampleGraph
// callbacks behave).
function buildForEachPointSampleBody(): SubgraphDef {
  const id = 'docs-fep-cube';
  const g = createGraph();
  const COL = 240;
  const ROW = 160;

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW } });

  const cube = addNode(g, 'core/cube', { position: { x: COL, y: 0 }, inputValues: { size: 0.3 } });
  const place = addNode(g, 'core/transform', { position: { x: COL * 2, y: 0 } });
  const colour = addNode(g, 'core/solid-color', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { color: [0.85, 0.32, 0.22, 1], resolution: 16 },
  });
  const material = addNode(g, 'core/material', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: { roughness: 0.7, metallic: 0 },
  });
  const entity = addNode(g, 'core/scene-entity', { position: { x: COL * 3, y: ROW } });

  addEdge(g, { node: cube.id, socket: 'geometry' }, { node: place.id, socket: 'geometry' });
  addEdge(g, { node: inputNode.id, socket: '__position' }, { node: place.id, socket: 'translate' });
  addEdge(g, { node: place.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
  addEdge(g, { node: colour.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
  addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
  addEdge(g, { node: entity.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Docs cube cell',
    category: 'Docs',
    inputs: [{ name: '__position', type: 'Vec3' }],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

function buildForEachPointSample(): {
  graph: ReturnType<typeof createGraph>;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
} {
  const g = createGraph();
  const COL = 240;
  const ROW = 160;
  const grid = addNode(g, 'core/grid-distribute', {
    id: 'grid',
    position: { x: 0, y: ROW },
    inputValues: { cols: 3, rows: 3, spacing: 0.6 },
  });
  const fep = addNode(g, 'core/for-each-point', {
    id: 'fep',
    position: { x: COL, y: ROW },
    inputValues: { __body: 'subgraph/docs-fep-cube' },
    extraOutputs: [{ name: 'scene', type: 'Scene' }],
  });
  addEdge(g, { node: grid.id, socket: 'points' }, { node: fep.id, socket: 'points' });
  return {
    graph: g,
    rootNodeId: fep.id,
    subgraphs: [buildForEachPointSampleBody()],
  };
}
