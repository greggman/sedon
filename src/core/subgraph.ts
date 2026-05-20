import { canonicalJson } from './eval-cache.js';
import { evaluateGraph } from './evaluate.js';
import { addNode, createGraph, type Graph } from './graph.js';
import type { InputDef, NodeDef, NodeRegistry, OutputDef } from './node-def.js';

// A reusable, named graph fragment that exposes a typed I/O boundary. Three
// node-defs come out of one subgraph definition:
//
//   1. The wrapper (`subgraph/<id>`) — appears in parent graphs as a regular
//      node with the subgraph's declared inputs/outputs. Its evaluate()
//      recursively evaluates the inner graph, tunneling caller inputs
//      through NodeContext to the input boundary.
//
//   2. The input boundary (`subgraph-input/<id>`) — placed inside the
//      subgraph's inner graph. Its outputs match the subgraph's declared
//      inputs; evaluate() reads from ctx.subgraphInputs.
//
//   3. The output boundary (`subgraph-output/<id>`) — placed inside the
//      inner graph. Its inputs match the subgraph's declared outputs;
//      evaluate() passes inputs through to outputs so the wrapper can
//      read them via the standard evaluator.
//
// The boundary nodes are paired with the subgraph: their kinds embed the
// subgraph id so each subgraph has its own boundary types. The inner graph
// holds exactly one input-boundary node and one output-boundary node,
// recorded by id on the SubgraphDef.
export interface SubgraphDef {
  id: string;
  label: string;
  category: string;
  inputs: InputDef[];
  outputs: OutputDef[];
  /** The inner graph. Mutating its nodes/edges retroactively affects every wrapper instance. */
  graph: Graph;
  /** ID of the input-boundary node placed in the inner graph. */
  inputNodeId: string;
  /** ID of the output-boundary node placed in the inner graph. Used as evaluator root. */
  outputNodeId: string;
  /**
   * Folder this subgraph lives under in the project's Asset view.
   * `null`/undefined = at the project root (alongside top-level
   * folders). Doesn't affect evaluation — purely organizational
   * metadata for the user.
   */
  parentFolderId?: string | null;
  /**
   * Monotonic counter bumped by the editor store on every mutation to
   * this subgraph (inner graph, I/O list, anything that affects the
   * wrapper's behavior). The wrapper's `NodeDef.version` is set to this
   * so the eval cache invalidates cleanly: same wrapper kind + same
   * inputs + same version ⇒ same outputs. Optional in saved files;
   * missing means "treat as version 0" — first edit will bump to 1.
   */
  version?: number;
}

const MAX_SUBGRAPH_DEPTH = 16;

// Picked so the most common parent-supplied input shapes preview as
// "one thing at origin" when no parent is present: a scatter subgraph
// gets a single point, paired attribute clouds get one identity-ish
// value to match. Types omitted from this map (Texture2D, Material,
// Geometry, Heightfield, Lighting) require GPU resources to construct
// and have no static default.
function systemDefaultForType(type: string): unknown {
  switch (type) {
    case 'Float':
      return 0;
    case 'Int':
      return 0;
    case 'Bool':
      return false;
    case 'Vec2':
    case 'Vec2i':
      return [0, 0];
    case 'Vec3':
      return [0, 0, 0];
    case 'Vec4':
      return [0, 0, 0, 0];
    case 'Quaternion':
      return [0, 0, 0, 1];
    case 'Color':
      return [1, 1, 1, 1];
    case 'Scene':
      return { entities: [] };
    case 'PointCloud':
      return {
        positions: new Float32Array([0, 0, 0]),
        count: 1,
      };
    case 'Vec3Cloud':
      return {
        values: new Float32Array([1, 1, 1]),
        count: 1,
      };
    case 'FloatCloud':
      return {
        values: new Float32Array([1]),
        count: 1,
      };
    case 'BranchGraph':
      return {
        branchCount: 0,
        vertexCount: 0,
        parentIndex: new Int32Array(0),
        parentT: new Float32Array(0),
        branchDepth: new Int32Array(0),
        vertexStart: new Uint32Array(0),
        vertexLength: new Uint32Array(0),
        positions: new Float32Array(0),
        radii: new Float32Array(0),
        arcLength: new Float32Array(0),
      };
    default:
      return undefined;
  }
}

/**
 * Compile a SubgraphDef into three NodeDefs (wrapper + two boundary types)
 * and return them as a registerable bundle. The wrapper's evaluate captures
 * the registry it'll be looked up from, so that nested subgraphs work — the
 * registry must be the one that has all subgraph kinds registered (build
 * the bundles for every subgraph first, then register them all).
 */
export function defineSubgraph(def: SubgraphDef, registry: NodeRegistry): NodeDef[] {
  const wrapperKind = `subgraph/${def.id}`;
  const inputKind = `subgraph-input/${def.id}`;
  const outputKind = `subgraph-output/${def.id}`;

  // Boundary input: its OUTPUTS are the subgraph's declared inputs (carrying
  // values FROM the wrapper INTO the inner graph). It has no graph inputs;
  // values come via context — EXCEPT when the subgraph is being viewed
  // standalone (no wrapper above it). In that case ctx.subgraphInputs is
  // undefined and we'd hand downstream nodes a bag of undefineds, which
  // crashes anything that does e.g. Float32Array.set on a Color input.
  //
  // Fallback order per input:
  //   1. ctx.subgraphInputs[name] (the wrapper's actual value)
  //   2. InputDef.default (author-provided value)
  //   3. System default for the input's type (single point at origin for
  //      PointCloud, white for Color, etc.) — picked so a "scatter trees
  //      on points" subgraph previews as "one tree at origin" without
  //      needing any custom preview chain.
  //
  // Types with no system default (Texture2D, Material, Geometry,
  // Heightfield, Lighting — anything that requires GPU resources) leave
  // the input undefined; downstream nodes that depend on them stop
  // evaluating gracefully.
  const standaloneDefaults: Record<string, unknown> = {};
  for (const i of def.inputs) {
    if (i.default !== undefined) {
      standaloneDefaults[i.name] = i.default;
    } else {
      const sys = systemDefaultForType(i.type);
      if (sys !== undefined) standaloneDefaults[i.name] = sys;
    }
  }
  // Shape hash for the boundary-input's fingerprint. Captures only the
  // interface shape (input names + types + defaults) — NOT the
  // subgraph's coarse version counter. The earlier approach of carrying
  // `version: def.version ?? 0` worked but was way too coarse: any
  // inner-graph edit bumped the subgraph version, which bumped the
  // boundary's fp, which cascaded through every inner node that
  // referenced the boundary as an upstream — so dragging a colour
  // picker inside `oak-leaf` re-evaluated `leaf-skeleton` (expensive
  // shader), `distance-transform` (multi-pass JFA), and everything
  // downstream of them, in every consumer (preview pane, asset
  // thumbnails, node previews), for every drag tick. With this shape
  // hash, only edits that actually change the boundary's interface
  // (add/rename/retype an input, change a default) bump the fp.
  // Adding/removing a boundary input still invalidates correctly,
  // which keeps the original "stale outputs map" cache-hit bug from
  // recurring — see `subgraph-input-default.test.ts`.
  const inputShape = canonicalJson(
    def.inputs.map((i) => ({ name: i.name, type: i.type, default: i.default ?? null })),
  );
  const inputBoundary: NodeDef = {
    id: inputKind,
    category: '__internal__',
    inputs: [],
    outputs: def.inputs.map<OutputDef>((i) => ({
      name: i.name,
      type: i.type,
      ...(i.description !== undefined ? { description: i.description } : {}),
      ...(i.label !== undefined ? { label: i.label } : {}),
    })),
    fingerprintExtra: inputShape,
    evaluate(ctx) {
      return ctx.subgraphInputs ?? standaloneDefaults;
    },
  };

  // Boundary output: its INPUTS are the subgraph's declared outputs (carrying
  // values from the inner graph TO the wrapper). Its outputs mirror its inputs
  // so the evaluator's root-output extraction picks them up.
  const outputBoundary: NodeDef = {
    id: outputKind,
    category: '__internal__',
    // Every boundary input is `optional`: the user authoring a subgraph
    // can connect outputs incrementally — wiring just `albedo` while
    // `normal` stays unwired shouldn't make the whole boundary skip
    // evaluation. Missing inputs come through as undefined, and the
    // wrapper / preview-synth treat undefined outputs as "render a
    // blank placeholder for this slot."
    inputs: def.outputs.map<InputDef>((o) => ({
      name: o.name,
      type: o.type,
      optional: true,
      ...(o.description !== undefined ? { description: o.description } : {}),
      ...(o.label !== undefined ? { label: o.label } : {}),
    })),
    outputs: def.outputs.map<OutputDef>((o) => ({
      name: o.name,
      type: o.type,
      ...(o.description !== undefined ? { description: o.description } : {}),
      ...(o.label !== undefined ? { label: o.label } : {}),
    })),
    // Same rationale as inputBoundary's `fingerprintExtra`: hash only
    // the boundary's interface (output names + types) so the fp
    // doesn't move on unrelated inner-graph edits.
    fingerprintExtra: canonicalJson(
      def.outputs.map((o) => ({ name: o.name, type: o.type })),
    ),
    evaluate(_ctx, inputs) {
      return inputs;
    },
  };

  // Wrapper: appears in parent graphs as a regular node. Its NodeDef.version
  // is the subgraph's version counter — the eval cache mixes this into the
  // wrapper's fingerprint, so any edit to the inner graph invalidates cached
  // outputs of this wrapper across all of its instances.
  const wrapper: NodeDef = {
    id: wrapperKind,
    category: def.category,
    inputs: def.inputs,
    outputs: def.outputs,
    version: def.version ?? 0,
    async evaluate(ctx, inputs) {
      const depth = (ctx.subgraphDepth ?? 0) + 1;
      if (depth > MAX_SUBGRAPH_DEPTH) {
        throw new Error(
          `subgraph recursion depth exceeded (${MAX_SUBGRAPH_DEPTH}) at ${wrapperKind} — likely a cycle`,
        );
      }
      // Forward the cache, touched set, and this instance's input
      // fingerprints. `subgraphInputFingerprints` is what lets the inner
      // boundary-input node fingerprint itself based on what's piped in —
      // without it, two wrapper instances with different inputs would
      // collide on boundary cache entries and produce wrong inner state.
      const innerCtx = {
        ...ctx,
        subgraphInputs: inputs,
        subgraphInputFingerprints: ctx.inputFingerprints ?? {},
        subgraphDepth: depth,
      };
      // exactOptionalPropertyTypes: only forward cache/touched when set.
      const innerOptions: Parameters<typeof evaluateGraph>[2] = {
        rootNodeId: def.outputNodeId,
        context: innerCtx,
        // Inside the wrapper we only need the boundary output's ancestors;
        // disconnected inner nodes don't affect what we return to the parent.
        scope: 'rootAncestors',
      };
      if (ctx.evalCache !== undefined) innerOptions.cache = ctx.evalCache;
      if (ctx.evalTouched !== undefined) innerOptions.touched = ctx.evalTouched;
      const result = await evaluateGraph(def.graph, registry, innerOptions);
      return result.outputs;
    },
  };

  return [wrapper, inputBoundary, outputBoundary];
}

/** True for node kinds generated by defineSubgraph (filter out of menus). */
export function isSubgraphInternalKind(kind: string): boolean {
  return kind.startsWith('subgraph-input/') || kind.startsWith('subgraph-output/');
}

export function isSubgraphInstanceKind(kind: string): boolean {
  return kind.startsWith('subgraph/');
}

/** Given a wrapper kind `subgraph/<id>`, return `<id>`. */
export function subgraphIdFromKind(kind: string): string | null {
  if (!isSubgraphInstanceKind(kind)) return null;
  return kind.slice('subgraph/'.length);
}

// Seed an empty SubgraphDef with the two boundary nodes in place but no
// declared inputs/outputs. Used by the editor's "New Subgraph" command;
// the user adds sockets via the boundary-node UI afterward.
export function createEmptySubgraph(id: string, label: string): SubgraphDef {
  const graph = createGraph();
  const inputNode = addNode(graph, `subgraph-input/${id}`, {
    position: { x: 0, y: 0 },
  });
  const outputNode = addNode(graph, `subgraph-output/${id}`, {
    position: { x: 600, y: 0 },
  });
  return {
    id,
    label,
    category: 'Subgraphs',
    inputs: [],
    outputs: [],
    graph,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
