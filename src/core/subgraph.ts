import { canonicalJson } from './eval-cache.js';
import { evaluateGraph } from './evaluate.js';
import { addNode, createGraph, type Graph } from './graph.js';
import type { InputDef, NodeDef, NodeRegistry, OutputDef } from './node-def.js';
import { getPreviewMaterial, getPreviewTexture2D } from './resources.js';

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
  /**
   * Marks this SubgraphDef as private node-owned state rather than a
   * user-authored asset. Set for the iteration bridge subgraphs that
   * `core/for-each-point` (and future for-each-* nodes) own — one
   * bridge per for-each-* instance, lifecycle bound to that instance.
   * Bridges:
   *   • are filtered out of the Assets panel (user never sees them
   *     listed alongside their authored subgraphs)
   *   • aren't reachable as wrappers in any parent graph (no
   *     `subgraph/<bridge-id>` wrapper instance is added externally)
   *   • are reached for editing only via the owning node's "Edit
   *     iteration" affordance
   * Absent on user-authored subgraphs.
   */
  owner?: {
    kind: 'iteration-bridge';
    /** The for-each-* node whose `__bridgeId` references this subgraph. */
    nodeId: string;
  };
  /**
   * The "iteration kind" this bridge is wired against — e.g.
   * `core/for-each-point`. Determines which iteration-context outputs
   * appear on the `iteration-input/<id>` boundary inside the bridge
   * (sourced from that NodeDef's `providedIterationContext`). Only
   * meaningful when `owner.kind === 'iteration-bridge'`.
   */
  iterationKind?: string;
}

const MAX_SUBGRAPH_DEPTH = 16;

// Per-key fallback for a subgraph-input boundary. Distinct from the
// raw `ctx.subgraphInputs ?? standaloneDefaults` that used to live in
// each boundary's evaluate: that was all-or-nothing, but real callers
// pass {name: undefined} for any unwired-and-undefaulted input on the
// outer surface (e.g. a for-each-point with a bridge-input the user
// hasn't wired). Without per-key fallback, that undefined sails into
// the inner graph and any node reading the value crashes (transform's
// scale[0], material's basecolor.kind, etc.). Boundary docstring at
// the top of defineSubgraph describes this fallback order — this is
// just the function that actually implements it.
//
// GPU-bound types (Material, Texture2D) have no static default, so
// `standaloneDefaults` can't carry one. When we have a `device` and
// the input is still undefined after the static fallbacks, fill in
// from `getPreviewMaterial` / `getPreviewTexture2D` (1×1 grey, cached
// per device). This is what makes a subgraph that takes a Material
// preview standalone in the Assets thumbnail / inner-view instead
// of rendering empty.
function resolveBoundaryInputs(
  provided: Record<string, unknown> | undefined,
  standaloneDefaults: Record<string, unknown>,
  lazyDefaults: ReadonlyArray<{ name: string; type: string }>,
  device: GPUDevice | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...standaloneDefaults };
  if (provided !== undefined) {
    for (const k of Object.keys(provided)) {
      const v = provided[k];
      if (v !== undefined) out[k] = v;
    }
  }
  if (device !== undefined) {
    for (const { name, type } of lazyDefaults) {
      if (out[name] !== undefined) continue;
      if (type === 'Material') out[name] = getPreviewMaterial(device);
      else if (type === 'Texture2D') out[name] = getPreviewTexture2D(device);
    }
  }
  return out;
}

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
  if (def.owner?.kind === 'iteration-bridge') {
    return defineBridgeSubgraph(def, registry);
  }
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
  // Types with no system default (Geometry, Heightfield, Lighting —
  // anything that requires GPU resources and can't be substituted with
  // a flat placeholder) leave the input undefined; downstream nodes
  // that depend on them stop evaluating gracefully.
  // Texture2D + Material DO get a lazy GPU default (1×1 grey, cached
  // per device) so a body subgraph that takes a Material previews
  // standalone instead of rendering empty.
  const standaloneDefaults: Record<string, unknown> = {};
  const lazyDefaults: { name: string; type: string }[] = [];
  for (const i of def.inputs) {
    if (i.default !== undefined) {
      standaloneDefaults[i.name] = i.default;
    } else {
      const sys = systemDefaultForType(i.type);
      if (sys !== undefined) standaloneDefaults[i.name] = sys;
      else if (i.type === 'Material' || i.type === 'Texture2D') {
        lazyDefaults.push({ name: i.name, type: i.type });
      }
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
      return resolveBoundaryInputs(ctx.subgraphInputs, standaloneDefaults, lazyDefaults, ctx.device);
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
  // is the subgraph's TRANSITIVE version — its own version + every inner
  // subgraph instance's (already-registered) wrapper version. The eval
  // cache mixes this into the wrapper's fingerprint, so any edit anywhere
  // in the dependency tree invalidates cached outputs of this wrapper.
  // Direct `def.version` (own counter only) would miss edits in a nested
  // subgraph: editing cabinet-cell would change cabinet-cell.version but
  // NOT the bridge subgraph's version above it, so a for-each-point
  // wrapping the bridge would cache-hit and silently swallow the change.
  const wrapper: NodeDef = {
    id: wrapperKind,
    category: def.category,
    inputs: def.inputs,
    outputs: def.outputs,
    version: transitiveSubgraphVersion(def, registry),
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
      // Push this wrapper instance onto the subgraph chain so producer
      // nodes inside the inner graph stamp the right path on emitted
      // entities (used by GPU picking → "View in Canvas →" / "Frame").
      // `ctx.nodeId` is the wrapper's id in the PARENT graph, set by
      // the evaluator on the call into evaluate(); it uniquely
      // identifies which instance of this subgraph we're recursing into.
      const innerCtx = {
        ...ctx,
        subgraphInputs: inputs,
        subgraphInputFingerprints: ctx.inputFingerprints ?? {},
        subgraphDepth: depth,
        subgraphPath: [
          ...(ctx.subgraphPath ?? []),
          { wrapperNodeId: ctx.nodeId ?? '<unknown>', subgraphId: def.id },
        ],
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

/**
 * Compile a BRIDGE SubgraphDef — the private node-owned graph held by
 * `core/for-each-point` (and future for-each-* nodes). Produces 3
 * NodeDefs, NONE of them a regular `subgraph/<id>` wrapper (bridges
 * are never instanced from a user-authored graph; they're invoked
 * directly by for-each-* nodes' evaluate via `ctx.iterationContext`):
 *
 *   1. `subgraph-input/<bridge-id>` — same as a regular subgraph's
 *      input boundary: its outputs are the bridge's declared inputs,
 *      carrying broadcast (non-iterated) values FROM the owning
 *      for-each-* node into the bridge graph.
 *   2. `iteration-input/<bridge-id>` — outputs are the iteration
 *      kind's `providedIterationContext` (e.g. `position`, `index`
 *      for for-each-point). Reads per-iteration values from
 *      `ctx.iterationContext`; user wires from these into body
 *      wrappers and any conversion / transform nodes inside the
 *      bridge.
 *   3. `iteration-output/<bridge-id>` — inputs are the bridge's
 *      declared outputs (i.e. what gets gathered each iteration and
 *      lifted by the for-each-* node into its outer outputs). Same
 *      shape and pass-through evaluate as a regular subgraph-output
 *      boundary, just a different kind so the editor renders it
 *      distinctly.
 *
 * The iteration kind's NodeDef must already be in the registry when
 * this runs; bridges only exist alongside their owning iteration
 * node, and the registry build order (core nodes first, then
 * subgraphs) guarantees this.
 */
function defineBridgeSubgraph(def: SubgraphDef, registry: NodeRegistry): NodeDef[] {
  const inputKind = `subgraph-input/${def.id}`;
  const iterInputKind = `iteration-input/${def.id}`;
  const iterOutputKind = `iteration-output/${def.id}`;
  const bridgeEvalKind = `bridge-eval/${def.id}`;

  // Look up what the iteration kind provides per-iteration. Falls
  // back to empty when the kind isn't registered — a bridge whose
  // iteration kind disappeared (deleted node-def, schema migration)
  // still loads cleanly with no per-iteration outputs rather than
  // throwing during registry build.
  const iterKindDef = registry.get(def.iterationKind ?? '');
  const providedContext = iterKindDef?.providedIterationContext ?? [];

  // Broadcast subgraph-input — identical to a regular subgraph's
  // input boundary. Same standalone-defaults fallback chain.
  const standaloneDefaults: Record<string, unknown> = {};
  const lazyDefaults: { name: string; type: string }[] = [];
  for (const i of def.inputs) {
    if (i.default !== undefined) {
      standaloneDefaults[i.name] = i.default;
    } else {
      const sys = systemDefaultForType(i.type);
      if (sys !== undefined) standaloneDefaults[i.name] = sys;
      else if (i.type === 'Material' || i.type === 'Texture2D') {
        lazyDefaults.push({ name: i.name, type: i.type });
      }
    }
  }
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
      return resolveBoundaryInputs(ctx.subgraphInputs, standaloneDefaults, lazyDefaults, ctx.device);
    },
  };

  // Iteration-input boundary — outputs come from the iteration kind's
  // declared context. Reads per-iter values from ctx.iterationContext;
  // standalone (no for-each-* invoking) falls back to type defaults so
  // the bridge previews as a "first iteration" snapshot without
  // crashing.
  const iterStandaloneDefaults: Record<string, unknown> = {};
  for (const c of providedContext) {
    const sys = systemDefaultForType(c.type);
    if (sys !== undefined) iterStandaloneDefaults[c.name] = sys;
  }
  const iterInputBoundary: NodeDef = {
    id: iterInputKind,
    category: '__internal__',
    inputs: [],
    outputs: providedContext.map<OutputDef>((c) => ({
      name: c.name,
      type: c.type,
      ...(c.description !== undefined ? { description: c.description } : {}),
    })),
    // Shape hash: iteration kind + provided-context interface. Edits
    // INSIDE the bridge graph mustn't bump this (we don't want a body
    // wrapper edit to cascade-invalidate every iteration's eval); only
    // the iteration kind itself changing does.
    fingerprintExtra: canonicalJson({
      iterationKind: def.iterationKind ?? null,
      provided: providedContext.map((c) => ({ name: c.name, type: c.type })),
    }),
    evaluate(ctx) {
      return ctx.iterationContext ?? iterStandaloneDefaults;
    },
  };

  // Iteration-output boundary — same shape + pass-through evaluate as
  // a regular subgraph-output boundary. The for-each-* node sets
  // rootNodeId to this boundary's id and reads its outputs for each
  // iteration, then merges/lifts into the for-each-* node's own
  // outer outputs.
  const iterOutputBoundary: NodeDef = {
    id: iterOutputKind,
    category: '__internal__',
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
    fingerprintExtra: canonicalJson(
      def.outputs.map((o) => ({ name: o.name, type: o.type })),
    ),
    evaluate(_ctx, inputs) {
      return inputs;
    },
  };

  // Internal "evaluator" NodeDef for the bridge — analogous to a
  // regular subgraph's wrapper, but it's never instanced into any
  // user-authored graph. The owning for-each-* node looks this up by
  // kind (`bridge-eval/<id>`) from `ctx.registry` and calls its
  // evaluate per iteration with the broadcast inputs in hand and
  // `ctx.iterationContext` / `iterationContextFingerprints` already
  // populated. We capture def.graph + def.outputNodeId in closure so
  // the for-each-* node doesn't need any other handle to the bridge.
  const bridgeEval: NodeDef = {
    id: bridgeEvalKind,
    category: '__internal__',
    inputs: def.inputs,
    outputs: def.outputs,
    // Same transitive-version rationale as the regular wrapper above:
    // a bridge containing a subgraph/cabinet-cell instance must
    // re-evaluate when cabinet-cell is edited, even though the bridge
    // itself wasn't touched.
    version: transitiveSubgraphVersion(def, registry),
    async evaluate(ctx, inputs) {
      const depth = (ctx.subgraphDepth ?? 0) + 1;
      if (depth > MAX_SUBGRAPH_DEPTH) {
        throw new Error(
          `bridge recursion depth exceeded (${MAX_SUBGRAPH_DEPTH}) at ${bridgeEvalKind} — for-each-* invoking itself directly or transitively?`,
        );
      }
      const innerCtx: typeof ctx = {
        ...ctx,
        subgraphInputs: inputs,
        subgraphInputFingerprints: ctx.inputFingerprints ?? {},
        // `iterationContext` + `iterationContextFingerprints` stay on
        // ctx as the for-each-* node set them; forwarded unchanged.
        subgraphDepth: depth,
      };
      const innerOptions: Parameters<typeof evaluateGraph>[2] = {
        rootNodeId: def.outputNodeId,
        context: innerCtx,
        scope: 'rootAncestors',
      };
      if (ctx.evalCache !== undefined) innerOptions.cache = ctx.evalCache;
      if (ctx.evalTouched !== undefined) innerOptions.touched = ctx.evalTouched;
      const result = await evaluateGraph(def.graph, registry, innerOptions);
      return result.outputs;
    },
  };

  return [inputBoundary, iterInputBoundary, iterOutputBoundary, bridgeEval];
}

/** True for node kinds generated by defineSubgraph (filter out of menus). */
export function isSubgraphInternalKind(kind: string): boolean {
  return (
    kind.startsWith('subgraph-input/')
    || kind.startsWith('subgraph-output/')
    || kind.startsWith('iteration-input/')
    || kind.startsWith('iteration-output/')
    || kind.startsWith('bridge-eval/')
  );
}

export function isSubgraphInstanceKind(kind: string): boolean {
  return kind.startsWith('subgraph/');
}

/** True for the per-iteration input boundary inside a for-each-* bridge. */
export function isIterationInputKind(kind: string): boolean {
  return kind.startsWith('iteration-input/');
}

/** True for the per-iteration output boundary inside a for-each-* bridge. */
export function isIterationOutputKind(kind: string): boolean {
  return kind.startsWith('iteration-output/');
}

/** Given a wrapper kind `subgraph/<id>`, return `<id>`. */
export function subgraphIdFromKind(kind: string): string | null {
  if (!isSubgraphInstanceKind(kind)) return null;
  return kind.slice('subgraph/'.length);
}

/**
 * Topologically sort subgraphs so a subgraph appears AFTER every
 * subgraph it transitively references. The wrapper NodeDef for the
 * outer subgraph stamps its `version` from the inner subgraph's
 * already-registered version (see `defineSubgraph`'s transitive-
 * version computation) — that only works when the inner is
 * registered first. Cycles are broken arbitrarily (the SubgraphDef
 * graph forbids them via the recursion-depth check, but the sort
 * stays defensive).
 */
export function topologicallySortSubgraphs(
  subgraphs: ReadonlyArray<SubgraphDef>,
): SubgraphDef[] {
  const byId = new Map(subgraphs.map((s) => [s.id, s]));
  const out: SubgraphDef[] = [];
  const visited = new Set<string>();
  const inProgress = new Set<string>();
  function visit(sg: SubgraphDef) {
    if (visited.has(sg.id)) return;
    if (inProgress.has(sg.id)) return; // cycle — emit on the way out
    inProgress.add(sg.id);
    for (const node of sg.graph.nodes) {
      const innerId = subgraphIdFromKind(node.kind);
      if (innerId !== null) {
        const inner = byId.get(innerId);
        if (inner) visit(inner);
      }
    }
    inProgress.delete(sg.id);
    visited.add(sg.id);
    out.push(sg);
  }
  for (const sg of subgraphs) visit(sg);
  return out;
}

/**
 * Compute a TRANSITIVE version string for a subgraph: its own
 * `version` field combined with the (already-registered) wrapper
 * versions of every subgraph it instantiates in its inner graph.
 * The outer wrapper's `NodeDef.version` is set to this string, so
 * editing ANY subgraph in the dependency tree changes the outer
 * wrapper's fingerprint and forces a re-eval through the outer
 * wrapper's cache.
 *
 * Requires inner subgraphs' wrappers to already be in the registry
 * (call after topologicallySortSubgraphs).
 */
export function transitiveSubgraphVersion(
  def: SubgraphDef,
  registry: NodeRegistry,
): string {
  const parts = [String(def.version ?? 0)];
  // Sort referenced ids for determinism (graph node iteration order
  // depends on insertion, which can shift across edits and would
  // produce spurious version churn).
  const innerIds = new Set<string>();
  for (const node of def.graph.nodes) {
    const innerId = subgraphIdFromKind(node.kind);
    if (innerId !== null) innerIds.add(innerId);
  }
  for (const innerId of [...innerIds].sort()) {
    const innerWrapper = registry.get(`subgraph/${innerId}`);
    if (innerWrapper?.version !== undefined) {
      parts.push(`${innerId}:${innerWrapper.version}`);
    }
  }
  return parts.join('|');
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
