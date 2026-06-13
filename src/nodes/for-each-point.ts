import { addEdge, addNode, createGraph } from '../core/graph.js';
import { canonicalJson } from '../core/eval-cache.js';
import type { InputDef, NodeContext, NodeDef, NodeInputs } from '../core/node-def.js';
import type {
  FloatCloudValue,
  GrassFieldValue,
  PointCloudValue,
  SceneValue,
  TerrainFieldValue,
  Vec3CloudValue,
} from '../core/resources.js';
import type { SubgraphDef } from '../core/subgraph.js';

// iter/for-each-point — invoke a private BRIDGE subgraph once per
// point in a PointCloud, then merge the bridge's per-iteration
// outputs.
//
// The bridge graph:
//   • Owned by this for-each-point instance (1:1, hidden from
//     Assets). Created on first body attach; lifecycle bound to the
//     owning node.
//   • Contains three boundary nodes the user CAN see while editing
//     the bridge:
//       - `subgraph-input/<bridgeId>`  ← broadcast values (one per
//         this node's `extraInputs`, the same value every iteration)
//       - `iteration-input/<bridgeId>` ← per-iteration context
//         (outputs named after `providedIterationContext` below —
//         `position` and `index`)
//       - `iteration-output/<bridgeId>` → per-iteration outputs that
//         this node will merge / lift into its own outer outputs
//   • The user wires the iteration-input outputs into any node they
//     want — usually a body subgraph wrapper, but conversion /
//     transform nodes are also fair game. That explicit mapping
//     keeps bodies independent of the iteration kind: a "place a
//     thing at a position" body declaring `position: Vec3` works
//     with for-each-point, for-each-face, for-each-segment, etc.
//     because each kind exposes a `position` in its
//     `providedIterationContext`.
//
// Per-iteration eval (this NodeDef):
//   for each point i in `points`:
//     ctx.iterationContext            = { position: pc.positions[i], index: i }
//     ctx.iterationContextFingerprints = { ...same map fingerprinted }
//     result = bridgeEval.evaluate(ctx, broadcastInputsForIter)
//     accumulate result into per-output accumulators
//   build merged / lifted outputs
//
// Output lifting matches the bridge's declared `iteration-output`
// types (which become the bridge's SubgraphDef.outputs):
//   Scene → Scene  (entities concatenated, grass / terrain /
//                   waterLevel sidecars carried through)
//   Float → FloatCloud
//   Vec3  → Vec3Cloud
//   anything else → omitted (no cloud variant)
//
// Broadcast input typing (mirrored onto this node's surface as
// extraInputs):
//   bridge.subgraph-input declares `size: Vec3`  →  for-each-point
//     extra `size: Vec3Cloud` (so a Vec3Cloud wire indexes per
//     iteration; a plain Vec3 wire broadcasts via the
//     Vec3→Vec3Cloud edge-compat rule).

const PROVIDED_CONTEXT: ReadonlyArray<InputDef> = [
  { name: 'position', type: 'Vec3', description: 'world-space position of the current point' },
  { name: 'index', type: 'Int', description: 'zero-based iteration index' },
];

/**
 * The per-iteration context names + types this iteration kind
 * provides. Shared with `defineBridgeSubgraph` so the bridge's
 * `iteration-input` boundary's outputs match what this node's
 * evaluate stamps into `ctx.iterationContext`.
 */
export function providedIterationContextFor(): ReadonlyArray<InputDef> {
  return PROVIDED_CONTEXT;
}

/**
 * Translate one of the bridge's declared broadcast-input types into
 * the matching socket type used on the for-each-point's mirrored
 * input. Float → FloatCloud, Vec3 → Vec3Cloud, everything else
 * passes through (broadcast-only, no cloud variant exists).
 */
export function liftForEachInputType(bodyInputType: string): string {
  if (bodyInputType === 'Float') return 'FloatCloud';
  if (bodyInputType === 'Vec3') return 'Vec3Cloud';
  return bodyInputType;
}

/**
 * Translate a bridge `iteration-output` type into the for-each-point's
 * lifted outer-output type. Different from input lifting because
 * outputs accumulate per iteration rather than broadcast:
 *   • Scene → Scene  (merged)
 *   • Float → FloatCloud
 *   • Vec3  → Vec3Cloud
 *   • anything else → null (no socket emitted on the for-each-point)
 */
export function liftForEachOutputType(bridgeOutputType: string): string | null {
  if (bridgeOutputType === 'Scene') return 'Scene';
  if (bridgeOutputType === 'Float') return 'FloatCloud';
  if (bridgeOutputType === 'Vec3') return 'Vec3Cloud';
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

// Convert whatever value the user wired into a broadcast input to a
// per-iteration scalar/array. Clouds index; everything else passes
// through (every iteration sees the same value).
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
  id: 'iter/for-each-point',
  category: 'Iteration',
  providedIterationContext: PROVIDED_CONTEXT,
  inputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description:
        'one iteration per point in this cloud. Per-iteration `position` (Vec3) and `index` (Int) are exposed inside the bridge graph via the iteration-input boundary',
    },
    {
      // Owned bridge subgraph id (e.g. `bridge-<for-each-point-uuid>`).
      // Set by the editor's drag-drop / attach-body action. The user
      // never edits this directly; they edit the bridge graph via the
      // "Edit" affordance on the node.
      name: '__bridgeId',
      type: 'String',
      default: '',
      hidden: true,
      description:
        'internal: the owned bridge SubgraphDef id (set by drag-drop, edited via "Edit")',
    },
  ],
  outputs: [
    // Static fallback: an empty Scene output when no bridge is bound
    // yet. Once a bridge is attached, node.extraOutputs replaces this
    // with the lifted iteration-output set (one socket per Scene /
    // Float / Vec3 declared on the bridge's iteration-output boundary).
    {
      name: 'scene',
      type: 'Scene',
      description:
        'placeholder Scene output when no bridge is attached. Once a body is dropped, the for-each-point\'s outputs are derived from the bridge\'s iteration-output boundary',
    },
  ],
  doc: {
    summary:
      'Invoke a body subgraph once per point in a PointCloud, with an explicit bridge graph wiring iteration context to body inputs.',
    sampleGraph: buildForEachPointSample,
    description: `
Drop a subgraph onto a for-each-point: it becomes the body, invoked
once per point in the wired \`points\` cloud, with iteration context
(\`position\`, \`index\`) flowing through a private "bridge" graph the
node owns.

The bridge graph is editable via the "Edit" affordance.
Inside it you see three boundary nodes — broadcast inputs from outside
(\`subgraph-input\`), per-iteration context from the iteration kind
(\`iteration-input\`), and per-iteration outputs the for-each-point
will merge / lift (\`iteration-output\`) — plus any body wrappers /
conversion nodes you place between them. The default drop wires
context names to body inputs of the same name automatically; deeper
customization (rename, transform, fork into two body branches) lives
inside the bridge.

Output lifting on the for-each-point's outer surface:
- Bridge \`Scene\` output  → for-each-point \`Scene\` (merged across
  iterations, with grass / terrain / waterLevel sidecars carried
  through).
- Bridge \`Float\` output  → \`FloatCloud\` (one value per iteration).
- Bridge \`Vec3\` output   → \`Vec3Cloud\`.

Bodies stay generic — they declare regular inputs by whatever name
fits the body's job (\`position\`, \`pos\`, \`worldPos\`, …). The
bridge graph is where iteration context gets mapped onto the body's
inputs explicitly, so the same body works under different iteration
kinds (for-each-point, future for-each-face, for-each-segment) just
by re-wiring its bridge.
`,
  },
  // For-each-point's output depends on its bridge's evaluation, but
  // the bridge is fetched at evaluate time via `ctx.registry` — it
  // isn't an upstream socket whose fingerprint would otherwise enter
  // our own. Without this, an edit to any subgraph the bridge
  // references (cabinet-cell inside bridge-fep-cabinets, the most
  // common nesting) doesn't change our own fingerprint, and the for-
  // each-point cache hits with stale output. Mixing the bridge's
  // (already-transitive) version into our fp closes that gap.
  dynamicFingerprintExtra(inputs, ctx): string {
    const bridgeId = (inputs.__bridgeId as string | undefined) ?? '';
    const bridgeDef = ctx.registry?.get(`bridge-eval/${bridgeId}`);
    const bridgeVer = bridgeDef?.version ?? '';
    // Mix animationTime when the bridge's inner graph contains anim
    // activity — same rationale as subgraph wrappers: the iter's
    // per-iteration eval can produce different output per frame when
    // its body wraps an animated subgraph, but without an outer-fp
    // shift the iter node cache-hits and never re-runs.
    const aff = ctx.affectedByGraphId?.get(bridgeId);
    const animPart = aff && aff.size > 0 ? `|anim:${ctx.animationTime ?? 0}` : '';
    return `bridge:${bridgeId}@${bridgeVer}${animPart}`;
  },
  async evaluate(ctx, inputs): Promise<Record<string, unknown>> {
    const pc = inputs.points as PointCloudValue | undefined;
    const bridgeId = (inputs.__bridgeId as string | undefined) ?? '';
    if (!pc || pc.count === 0 || !bridgeId) {
      // No bridge attached yet, or no points to iterate. Empty Scene
      // matches the static default-output declaration so consumers
      // can still wire optimistically.
      return { scene: { entities: [] } };
    }

    const bridgeEval = ctx.registry?.get(`bridge-eval/${bridgeId}`);
    if (!bridgeEval) {
      // Bridge isn't in the registry — happens transiently during a
      // registry rebuild after the bridge subgraph was added, and
      // permanently if the bridge was deleted from outside. Either
      // way, empty Scene is the safe fallback.
      return { scene: { entities: [] } };
    }

    const n = pc.count;

    // Accumulators keyed by the bridge's iteration-output names.
    // Type-derived from the bridge's declared outputs (Scene merged,
    // Float / Vec3 collected per iteration into a cloud).
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
    for (const o of bridgeEval.outputs) {
      if (o.type === 'Scene') {
        accumulators.set(o.name, {
          kind: 'Scene', entities: [],
          grass: [], terrain: [], waterLevel: undefined,
        });
      } else if (o.type === 'Float') {
        accumulators.set(o.name, { kind: 'Float', values: new Float32Array(n) });
      } else if (o.type === 'Vec3') {
        accumulators.set(o.name, { kind: 'Vec3', values: new Float32Array(n * 3) });
      }
    }

    for (let i = 0; i < n; i++) {
      // Per-iteration context: stamp `position` from the points cloud
      // and `index` from the loop counter. These names must match
      // PROVIDED_CONTEXT (and therefore the bridge's iteration-input
      // boundary outputs) — that's the wire-time contract.
      const o3 = i * 3;
      const iterationContext: NodeInputs = {
        position: [pc.positions[o3]!, pc.positions[o3 + 1]!, pc.positions[o3 + 2]!],
        index: i,
      };
      // Fingerprint each context value individually so the bridge's
      // iteration-input boundary's fp differs per iteration. Without
      // this, every iteration's inner eval shares one cache slot and
      // returns the same output.
      const iterationContextFingerprints: Record<string, string> = {
        position: canonicalJson(iterationContext.position),
        index: `${i}`,
      };

      // Broadcast inputs: walk the bridge's declared subgraph-input
      // (== bridgeEval.inputs) and for each, look up what the user
      // wired into the for-each-point's mirrored extra socket. Cloud
      // values get index-deref'd to a per-iteration scalar; broadcast
      // values pass through unchanged (every iteration sees the same).
      //
      // Per-input fingerprints reflect the PICKED value. Two cases:
      //
      //   1. Cloud-deref'd (picked !== wired): a primitive scalar /
      //      vec extracted from the outer cloud. Fingerprint via
      //      canonicalJson on the picked value — content is plain
      //      JSON, varies per iteration.
      //
      //   2. Broadcast (picked === wired): the whole upstream value
      //      passes through unchanged every iteration. The CORRECT
      //      fingerprint is the upstream node's already-computed fp
      //      (sitting on `ctx.inputFingerprints[bIn.name]`).
      //      Content-fingerprinting via canonicalJson is WRONG here
      //      for GPU-bearing values like MaterialValue: a GPUTexture
      //      stringifies to `{}`, so a white-basecolor and a red-
      //      basecolor material produce the same canonical JSON and
      //      the bridge cache hits on the stale entry — visible
      //      symptom: changing material colour didn't update the
      //      rendered cabinets.
      //
      // Outer fps don't move per iteration (broadcast is constant
      // across iters by definition), but they DO move across
      // re-evals when the upstream value changes — which is exactly
      // what the cache needs.
      const broadcastInputs: NodeInputs = {};
      const broadcastFingerprints: Record<string, string> = {};
      const outerFps = ctx.inputFingerprints ?? {};
      for (const bIn of bridgeEval.inputs) {
        const wired = inputs[bIn.name];
        const picked = wired === undefined
          ? bIn.default
          : pickForIteration(wired, i, n);
        broadcastInputs[bIn.name] = picked;
        const upstreamFp = outerFps[bIn.name];
        broadcastFingerprints[bIn.name] = picked === wired && upstreamFp !== undefined
          ? upstreamFp
          : canonicalJson(picked);
      }

      const iterCtx: NodeContext = {
        ...ctx,
        iterationContext,
        iterationContextFingerprints,
        inputFingerprints: broadcastFingerprints,
      };
      const result = await bridgeEval.evaluate(iterCtx, broadcastInputs);
      const resultMap = result as Record<string, unknown>;

      for (const o of bridgeEval.outputs) {
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
            acc.values[o3] = typeof v[0] === 'number' ? v[0] : 0;
            acc.values[o3 + 1] = typeof v[1] === 'number' ? v[1] : 0;
            acc.values[o3 + 2] = typeof v[2] === 'number' ? v[2] : 0;
          }
        }
      }
    }

    // Materialise.
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
    // If the bridge has no Scene output but the static def has one,
    // tack on an empty Scene so the placeholder output still resolves.
    if (!('scene' in out)) out.scene = { entities: [] };
    return out;
  },
};

// Docs sample: a 3×3 grid of small red cubes. The body is a tiny
// inline subgraph `docs-fep-cube` with one regular input `position`
// — bound via the bridge graph's iteration-input.position → body.position
// wire. Demonstrates the new wiring story without magic names.
function buildForEachPointSampleBody(): SubgraphDef {
  const id = 'docs-fep-cube';
  const g = createGraph();
  const COL = 240;
  const ROW = 160;

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 5, y: ROW } });

  const cube = addNode(g, 'geom/cube', { position: { x: COL, y: 0 }, inputValues: { size: 0.3 } });
  const place = addNode(g, 'geom/transform', { position: { x: COL * 2, y: 0 } });
  const colour = addNode(g, 'tex/solid-color', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { color: [0.85, 0.32, 0.22, 1], resolution: 16 },
  });
  const material = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: { roughness: 0.7, metallic: 0 },
  });
  const entity = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW } });

  addEdge(g, { node: cube.id, socket: 'geometry' }, { node: place.id, socket: 'geometry' });
  addEdge(g, { node: inputNode.id, socket: 'position' }, { node: place.id, socket: 'translate' });
  addEdge(g, { node: place.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
  addEdge(g, { node: colour.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
  addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
  addEdge(g, { node: entity.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Docs cube cell',
    category: 'Docs',
    inputs: [{ name: 'position', type: 'Vec3' }],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// Build the bridge subgraph that owns the docs sample for-each-point.
// Hand-wired (instead of going through the editor's attach-body
// action) because the docs sample needs to be a pure data builder.
function buildForEachPointSampleBridge(forEachId: string): SubgraphDef {
  const id = `bridge-${forEachId}`;
  const g = createGraph();
  const COL = 240;
  const ROW = 160;

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: 0 } });
  const iterInputNode = addNode(g, `iteration-input/${id}`, { position: { x: 0, y: ROW } });
  const iterOutputNode = addNode(g, `iteration-output/${id}`, { position: { x: COL * 3, y: ROW } });
  const body = addNode(g, 'subgraph/docs-fep-cube', { position: { x: COL * 1.5, y: ROW } });

  // The interesting edge: iteration-input.position → body.position.
  // This is the bridge mapping the user would author by hand for
  // anything more elaborate than the default-by-name auto-wire.
  addEdge(g, { node: iterInputNode.id, socket: 'position' }, { node: body.id, socket: 'position' });
  addEdge(g, { node: body.id, socket: 'scene' }, { node: iterOutputNode.id, socket: 'scene' });

  return {
    id,
    label: 'docs for-each bridge',
    category: 'Subgraphs',
    inputs: [], // no broadcast inputs for the docs sample
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: iterOutputNode.id,
    owner: { kind: 'iteration-bridge', nodeId: forEachId },
    iterationKind: 'iter/for-each-point',
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
  const grid = addNode(g, 'points/grid', {
    id: 'grid',
    position: { x: 0, y: ROW },
    inputValues: { cols: 3, rows: 3, spacing: 0.6 },
  });
  const fepId = 'fep';
  const fep = addNode(g, 'iter/for-each-point', {
    id: fepId,
    position: { x: COL, y: ROW },
    inputValues: { __bridgeId: `bridge-${fepId}` },
    extraOutputs: [{ name: 'scene', type: 'Scene' }],
  });
  addEdge(g, { node: grid.id, socket: 'points' }, { node: fep.id, socket: 'points' });
  return {
    graph: g,
    rootNodeId: fep.id,
    subgraphs: [
      buildForEachPointSampleBody(),
      buildForEachPointSampleBridge(fepId),
    ],
  };
}
