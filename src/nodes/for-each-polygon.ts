import { addEdge, addNode, createGraph } from '../core/graph.js';
import { canonicalJson } from '../core/eval-cache.js';
import type { InputDef, NodeContext, NodeDef, NodeInputs } from '../core/node-def.js';
import type {
  FloatCloudValue,
  GrassFieldValue,
  PolygonListValue,
  PolygonValue,
  SceneValue,
  TerrainFieldValue,
  Vec3CloudValue,
} from '../core/resources.js';
import type { SubgraphDef } from '../core/subgraph.js';

// iter/for-each-polygon — invoke a private bridge subgraph once per
// polygon in a PolygonList, then merge the bridge's per-iteration
// outputs.
//
// Structurally identical to `iter/for-each-point` (same bridge-graph
// machinery, same accumulator types, same eval loop) — only the
// iteration kind differs:
//   • Iteration source: `polygons: PolygonList` instead of `points: PointCloud`.
//   • Per-iteration context: `polygon: Polygon` and `index: Int`,
//     wired through the bridge's `iteration-input` boundary.
//
// Use case: a per-block subgraph that takes one block polygon and
// emits a Scene (sidewalk-inset → perimeter-points → scatter
// buildings). The for-each-polygon runs it for every block in the
// subdivided city and merges the scenes.
//
// Output lifting (Scene → merged Scene, Float → FloatCloud, Vec3 →
// Vec3Cloud) and broadcast-input handling match for-each-point
// exactly so a body subgraph that works under one combinator works
// under either with just a bridge rewire.

const PROVIDED_CONTEXT: ReadonlyArray<InputDef> = [
  { name: 'polygon', type: 'Polygon', description: 'the current iteration\'s polygon' },
  { name: 'index', type: 'Int', description: 'zero-based iteration index' },
];

/** Same shape contract as `for-each-point.providedIterationContextFor()`. */
export function providedIterationContextFor(): ReadonlyArray<InputDef> {
  return PROVIDED_CONTEXT;
}

/** Same input-lifting rules as for-each-point. Keeps body subgraphs portable across iteration kinds. */
export function liftForEachInputType(bodyInputType: string): string {
  if (bodyInputType === 'Float') return 'FloatCloud';
  if (bodyInputType === 'Vec3') return 'Vec3Cloud';
  return bodyInputType;
}

/** Same output-lifting rules as for-each-point. */
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

function isPolygonList(v: unknown): v is PolygonListValue {
  return (
    typeof v === 'object' && v !== null
    && 'polygons' in v && Array.isArray((v as PolygonListValue).polygons)
  );
}

// Pick the i-th value for a broadcast input. Clouds index per
// iteration (like for-each-point); anything else passes through
// unchanged. PolygonList wired to a Polygon broadcast input behaves
// like a cloud — index into the i-th polygon — so a body subgraph
// that takes one Polygon broadcast input can iterate against a
// matching PolygonList without an extra deref.
function pickForIteration(value: unknown, i: number, count: number): unknown {
  if (isFloatCloud(value)) {
    return i < count ? value.values[i] : 0;
  }
  if (isVec3Cloud(value)) {
    if (i >= count) return [0, 0, 0];
    const o = i * 3;
    return [value.values[o]!, value.values[o + 1]!, value.values[o + 2]!];
  }
  if (isPolygonList(value)) {
    return value.polygons[i] ?? { outer: new Float32Array(0) };
  }
  return value;
}

export const forEachPolygonNode: NodeDef = {
  id: 'iter/for-each-polygon',
  category: 'Iteration',
  providedIterationContext: PROVIDED_CONTEXT,
  inputs: [
    {
      name: 'polygons',
      type: 'PolygonList',
      description:
        'one iteration per polygon in this list. Per-iteration `polygon` (Polygon) and `index` (Int) are exposed inside the bridge graph via the iteration-input boundary',
    },
    {
      name: '__bridgeId',
      type: 'String',
      default: '',
      hidden: true,
      description:
        'internal: the owned bridge SubgraphDef id (set by drag-drop, edited via "Edit")',
    },
  ],
  outputs: [
    {
      name: 'scene',
      type: 'Scene',
      description:
        'placeholder Scene output when no bridge is attached. Once a body is dropped, the for-each-polygon\'s outputs are derived from the bridge\'s iteration-output boundary',
    },
  ],
  doc: {
    summary:
      'Invoke a body subgraph once per polygon in a PolygonList, with an explicit bridge graph wiring iteration context to body inputs.',
    sampleGraph: buildForEachPolygonSample,
    description: `
The polygon counterpart to
[iter/for-each-point](../../iter/for-each-point). Drop a subgraph onto
this node: it becomes the body, invoked once per polygon in the wired
\`polygons\` list, with iteration context (\`polygon\`, \`index\`)
flowing through a private "bridge" graph the node owns.

The bridge graph is editable via the "Edit" affordance. Inside it you
see three boundary nodes:
  • \`subgraph-input\` — broadcast values (the same value every
    iteration)
  • \`iteration-input\` — per-iteration context (\`polygon\`, \`index\`)
  • \`iteration-output\` — per-iteration outputs the for-each-polygon
    will merge / lift

Output lifting on the for-each-polygon's outer surface:
  • Bridge \`Scene\` output → for-each-polygon \`Scene\` (merged across
    iterations, with grass / terrain / waterLevel sidecars carried
    through).
  • Bridge \`Float\` output → \`FloatCloud\`.
  • Bridge \`Vec3\` output  → \`Vec3Cloud\`.

Use this for "districts → buildings": each district polygon enters
the body, which insets (sidewalk), scatters along the perimeter, and
emits a Scene. The for-each merges them into the city.
`,
  },
  dynamicFingerprintExtra(inputs, ctx): string {
    const bridgeId = (inputs.__bridgeId as string | undefined) ?? '';
    const bridgeDef = ctx.registry?.get(`bridge-eval/${bridgeId}`);
    const bridgeVer = bridgeDef?.version ?? '';
    return `bridge:${bridgeId}@${bridgeVer}`;
  },
  async evaluate(ctx, inputs): Promise<Record<string, unknown>> {
    const list = inputs.polygons as PolygonListValue | undefined;
    const bridgeId = (inputs.__bridgeId as string | undefined) ?? '';
    if (!list || list.polygons.length === 0 || !bridgeId) {
      return { scene: { entities: [] } };
    }
    const bridgeEval = ctx.registry?.get(`bridge-eval/${bridgeId}`);
    if (!bridgeEval) {
      return { scene: { entities: [] } };
    }
    const n = list.polygons.length;

    // Accumulators keyed by the bridge's iteration-output names.
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
      const polygon = list.polygons[i] as PolygonValue;
      const iterationContext: NodeInputs = { polygon, index: i };
      // Fingerprint each polygon by its packed outer-ring bytes. Same
      // polygon ref across iterations would otherwise share a cache
      // slot — but here different iterations have different polygons
      // so the fingerprint differs per iteration.
      // Holes (when added) need including too.
      const polyFp = `poly:${canonicalJson(Array.from(polygon.outer))}`;
      const iterationContextFingerprints: Record<string, string> = {
        polygon: polyFp,
        index: `${i}`,
      };

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
            const o3 = i * 3;
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
    if (!('scene' in out)) out.scene = { entities: [] };
    return out;
  },
};

// ── Docs sample ────────────────────────────────────────────────────
// A 2-polygon list (two small squares offset on X) → for-each-polygon
// with a body that just emits a flat fill-mesh for each polygon. Shows
// the whole machinery — iteration source, bridge subgraph, body
// subgraph, lifted Scene output — in one hand-wired graph.

function buildForEachPolygonSampleBody(): SubgraphDef {
  const id = 'docs-fepoly-fill';
  const g = createGraph();
  const COL = 240;
  const ROW = 160;

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 4, y: ROW } });
  const toMesh = addNode(g, 'geom/from-polygon', { position: { x: COL, y: 0 } });
  const colour = addNode(g, 'tex/solid-color', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { color: [0.55, 0.7, 0.45, 1], resolution: 16 },
  });
  const material = addNode(g, 'material/pbr', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: { roughness: 0.8, metallic: 0 },
  });
  const entity = addNode(g, 'scene/entity', { position: { x: COL * 3, y: ROW } });

  addEdge(g, { node: inputNode.id, socket: 'polygon' }, { node: toMesh.id, socket: 'polygon' });
  addEdge(g, { node: toMesh.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
  addEdge(g, { node: colour.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
  addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
  addEdge(g, { node: entity.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Docs polygon fill',
    category: 'Docs',
    inputs: [{ name: 'polygon', type: 'Polygon' }],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

function buildForEachPolygonSampleBridge(forEachId: string): SubgraphDef {
  const id = `bridge-${forEachId}`;
  const g = createGraph();
  const COL = 240;
  const ROW = 160;

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: 0 } });
  const iterInputNode = addNode(g, `iteration-input/${id}`, { position: { x: 0, y: ROW } });
  const iterOutputNode = addNode(g, `iteration-output/${id}`, { position: { x: COL * 3, y: ROW } });
  const body = addNode(g, 'subgraph/docs-fepoly-fill', { position: { x: COL * 1.5, y: ROW } });

  addEdge(g, { node: iterInputNode.id, socket: 'polygon' }, { node: body.id, socket: 'polygon' });
  addEdge(g, { node: body.id, socket: 'scene' }, { node: iterOutputNode.id, socket: 'scene' });

  return {
    id,
    label: 'docs for-each-polygon bridge',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: iterOutputNode.id,
    owner: { kind: 'iteration-bridge', nodeId: forEachId },
    iterationKind: 'iter/for-each-polygon',
  };
}

function buildForEachPolygonSample(): {
  graph: ReturnType<typeof createGraph>;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
} {
  const g = createGraph();
  const COL = 240;
  const ROW = 160;
  const a = addNode(g, 'poly/aabb', {
    position: { x: 0, y: 0 },
    inputValues: { center: [-10, 0], size: [6, 6] },
  });
  const b = addNode(g, 'poly/aabb', {
    position: { x: 0, y: ROW },
    inputValues: { center: [10, 0], size: [6, 6] },
  });
  const list = addNode(g, 'poly/list', {
    position: { x: COL, y: ROW * 0.5 },
    extraInputs: [
      { name: 'polygon_0', type: 'Polygon', optional: true },
      { name: 'polygon_1', type: 'Polygon', optional: true },
    ],
  });
  addEdge(g, { node: a.id, socket: 'polygon' }, { node: list.id, socket: 'polygon_0' });
  addEdge(g, { node: b.id, socket: 'polygon' }, { node: list.id, socket: 'polygon_1' });
  const fepId = 'fepoly';
  const fep = addNode(g, 'iter/for-each-polygon', {
    id: fepId,
    position: { x: COL * 2, y: ROW * 0.5 },
    inputValues: { __bridgeId: `bridge-${fepId}` },
    extraOutputs: [{ name: 'scene', type: 'Scene' }],
  });
  addEdge(g, { node: list.id, socket: 'polygons' }, { node: fep.id, socket: 'polygons' });
  return {
    graph: g,
    rootNodeId: fep.id,
    subgraphs: [
      buildForEachPolygonSampleBody(),
      buildForEachPolygonSampleBridge(fepId),
    ],
  };
}
