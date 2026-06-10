export interface InputDef {
  /**
   * Stable identifier used as the inputValues key, the React Flow handle
   * id, and the edge socket reference. For core nodes this is the
   * human-readable name; for subgraph boundaries it's a UUID generated
   * when the socket is created so the user can rename the display
   * `label` without invalidating handle measurements or breaking edges.
   */
  name: string;
  type: string;
  default?: unknown;
  description?: string;
  /**
   * Display label shown next to the socket in the UI. When absent, the
   * UI falls back to `name`. Only subgraph boundaries set this — they
   * use UUIDs for `name` so renames touch only `label`.
   */
  label?: string;
  // Marks an input as optional: when unconnected and no default and no
  // inputValue, the evaluator passes `undefined` rather than skipping the
  // node, and the validator does not flag it as missing. The node's evaluate()
  // is responsible for handling the undefined case.
  optional?: boolean;
  /**
   * For `Int` inputs that represent an enum, the closed set of valid
   * (value, label) pairs. When set, the UI renders a `<select>`
   * dropdown instead of a number scrubber, and the runtime still
   * stores the value as a plain integer (the enum is purely a UI
   * affordance).
   *
   * Subgraph passthrough is NOT supported yet — if you wire an
   * enum-typed input through a subgraph boundary, the wrapper's
   * mirrored input loses the dropdown and reads as a plain Int.
   * Adding propagation would require the boundary to introspect what
   * its outputs connect to and inherit metadata; tracked as future
   * work.
   */
  enumOptions?: ReadonlyArray<{ value: number; label: string }>;
  /**
   * Custom inline editor widget override. The default editor for an
   * input is chosen by its `type` (Color → swatch picker, Float →
   * scrubber, etc.); when this field is set the UI dispatches by
   * `widget` instead. Used for input shapes that don't have their
   * own socket type but need a special editor — e.g. `gradient`
   * (the in-popup N-stop ramp editor).
   *
   * Pairs with `hideSocket` below — most widget-driven inputs are
   * authored only (no incoming wire possible because nothing else
   * has that shape), so they also opt out of the handle.
   */
  widget?: string;
  /**
   * Skip rendering the React Flow handle (socket) for this input.
   * The input becomes authored-only: editable via its inline widget,
   * but no wire can be connected to it. Useful for inputs whose
   * underlying data shape exists only inside this one node — there's
   * no socket type for "list of gradient stops," and no other node
   * could produce one anyway, so the handle would only mislead.
   */
  hideSocket?: boolean;
  /**
   * Skip rendering the inspector row for this input entirely — no
   * label, no editor, no socket. The value still lives in
   * `inputValues` and flows through evaluate/serialize/copy-paste like
   * any other input. Used for internal state the node author maintains
   * programmatically (e.g. cached image dimensions on `tex/image`)
   * that needs to persist with the graph but isn't user-facing.
   */
  hidden?: boolean;
  /**
   * Inclusive numeric bounds for Int / Float inputs. The evaluator
   * clamps incoming values (from any source — upstream wire, user-set
   * inputValue, or default) into [min, max] before calling the node's
   * `evaluate`, so node code can rely on the declared range and skip
   * defensive clamping. The inspector also clamps on commit so the UI
   * never shows a value the runtime would silently clip.
   *
   * Either bound is independent: declaring only `min` leaves the
   * upper end unconstrained. Ignored for non-numeric input types.
   */
  min?: number;
  max?: number;
  /**
   * For `widget: 'point-list'` inputs: invert the vertical screen
   * axis so that the second authoring coordinate (the index-2 tuple
   * slot — used as "height/up" by curve-2d profiles) grows UP the
   * canvas instead of DOWN. The terrain-path convention is Y-down
   * (top of canvas = far end of the world); curve-2d's mental model
   * is Y-up (top of canvas = top of the candlestick). This flag
   * picks the second convention. Ignored by non-point-list editors.
   */
  flipY?: boolean;
  /**
   * For `widget: 'point-list'` inputs: opt the editor into the
   * Bezier-handle UI used by `path/curve-2d`. Each tuple's slots
   * 1..6 are interpreted as `[type, leftDx, leftDy, rightDx,
   * rightDy]` (slot 0 / 2 remain X / Y as elsewhere); the editor
   * renders draggable tangent handles for selected anchors and
   * cycles handle types via ctrl-click. Off (default) gives the
   * plain terrain-path editor — just anchor dots.
   */
  bezierHandles?: boolean;
  /**
   * For `widget: 'point-list'` inputs: treat the points as a CLOSED
   * ring (polygon outline) rather than an OPEN polyline (terrain
   * path). The editor draws the wraparound segment from the last
   * vertex back to the first so the user sees the polygon they're
   * authoring. Off (default) is the original polyline behavior.
   * Independent of `bezierHandles` — both `path/curve-2d` and
   * `poly/from-points` set this when they want closed
   * authoring.
   */
  closed?: boolean;
}

export interface OutputDef {
  /** See {@link InputDef.name} — same rule for outputs. */
  name: string;
  type: string;
  description?: string;
  /** See {@link InputDef.label} — same rule for outputs. */
  label?: string;
}

export interface NodeContext {
  device?: GPUDevice;
  /**
   * The node registry the evaluator is dispatching against. Threaded
   * into the context so nodes whose evaluate() needs to look up other
   * node-kinds at runtime — `iter/for-each-point` invokes a body
   * subgraph wrapper N times — can do so without each NodeDef having
   * to capture the registry in closure. Subgraph wrappers still capture
   * their own registry reference in closure (predates this field);
   * either source works.
   */
  registry?: NodeRegistry;
  /**
   * When the evaluator is recursing into a subgraph, this carries the
   * input values from the wrapping subgraph-instance. The subgraph-input
   * boundary node reads from this to expose them to the inner graph.
   * Undefined at the top level.
   */
  subgraphInputs?: NodeInputs;
  /**
   * Per-iteration context values, set by `iter/for-each-point` (and
   * future for-each-* nodes) when invoking their bridge subgraph N
   * times. Keyed by the names declared in the iteration kind's
   * `providedIterationContext` (e.g. `position`, `index` for
   * for-each-point). The `iteration-input/<id>` boundary node inside
   * the bridge reads from this. Parallel to `subgraphInputs` but
   * scoped to the iteration body — outer broadcast values still flow
   * via `subgraphInputs`.
   */
  iterationContext?: NodeInputs;
  /**
   * Fingerprints of the iteration kind's per-iteration values for
   * THIS iteration. Mixed into the `iteration-input/<id>` boundary's
   * fingerprint so each iteration's inner eval has a distinct cache
   * key (without this every iteration cache-hits on the same
   * fingerprint and returns the same output — see the per-iter ctx
   * setup in for-each-point.evaluate).
   */
  iterationContextFingerprints?: Record<string, string>;
  /**
   * Recursion depth, incremented on each subgraph entry to bound
   * accidental cycles (subgraph A → subgraph B → subgraph A → ...).
   */
  subgraphDepth?: number;
  /**
   * The current eval round's cache. Subgraph wrappers forward this to
   * `evaluateGraph` when recursing so the inner nodes hit the same shared
   * cache as the top-level graph. Undefined when caching is disabled.
   */
  evalCache?: import('./eval-cache.js').EvalCache;
  /**
   * Per-eval-round set of fingerprints that were referenced (either
   * computed fresh or hit in the cache). After all consumers finish a
   * round, the caller passes this set to `sweepCache` to evict anything
   * not in it.
   */
  evalTouched?: Set<string>;
  /**
   * This node's own upstream input fingerprints — set per-node by the
   * evaluator right before calling `def.evaluate`. The subgraph wrapper
   * reads this and forwards it as `subgraphInputFingerprints` into the
   * inner eval, so the inner boundary node can fingerprint itself based
   * on what the parent piped in (its outputs depend on `subgraphInputs`,
   * which aren't on the inner graph).
   */
  inputFingerprints?: Record<string, string>;
  /**
   * Fingerprints of the wrapper's inputs, propagated into the inner
   * eval. The boundary-input node's fingerprint mixes this in.
   */
  subgraphInputFingerprints?: Record<string, string>;
  /**
   * The output this node produced on its most recent prior evaluation,
   * if any. Nodes that own GPU resources can inspect this and re-use
   * compatible textures/buffers instead of allocating fresh ones — for
   * example, a noise node that only had its `scale` parameter nudged
   * keeps the same output dimensions and should re-render into the
   * existing texture rather than allocating a new one every frame. Use
   * is fully opt-in: if a node ignores this field, behavior is
   * identical to the old "always allocate fresh" path.
   */
  previousOutput?: NodeOutputs;
  /**
   * This node's id in its containing graph (or its subgraph's inner
   * graph). Set by the evaluator. Producer nodes stamp this onto
   * SceneEntity.provenance.originNodeId so GPU picking can route back
   * to the right node.
   */
  nodeId?: string;
  /**
   * Chain of subgraph wrapper instances from outermost to innermost,
   * representing where in the project this evaluation is happening.
   * Empty at the top level. The subgraph wrapper appends one entry
   * before recursing into the inner graph. Producer nodes copy this
   * (verbatim) into SceneEntity.provenance.subgraphPath so the editor's
   * "View in Canvas →" menu can show the full nesting.
   */
  subgraphPath?: import('./resources.js').SubgraphPathEntry[];
}

export type NodeInputs = Record<string, unknown>;
export type NodeOutputs = Record<string, unknown>;

/**
 * Per-node documentation, surfaced by the static docs page generator
 * and the [?] icon on each node header.
 *
 * The shape intentionally pulls every textual piece off the same
 * NodeDef the runtime already exposes, so a single source of truth
 * powers both the editor (tooltips, popover help) and the published
 * `docs/nodes/<id>/` pages. Inputs/outputs tables fall out of the
 * existing `description` fields on InputDef/OutputDef — only the
 * per-node story (summary, longer body, and a worked example) is new.
 *
 * `sampleGraph` returns a self-contained graph that demonstrates the
 * node in a realistic chain (often just the node itself plus a few
 * upstream defaults + a `core/output`). The docs page mounts the same
 * editor canvas + preview pipeline against it so the example renders
 * live, identically to how it'd render inside a project.
 */
export interface NodeDoc {
  /**
   * One-line headline shown under the node name. Plain text; keep it
   * short enough to read at a glance in a search-engine snippet.
   */
  summary: string;
  /**
   * Optional longer body. Paragraphs separated by blank lines. Plain
   * text only (no markdown processing) so authors aren't tempted to
   * lean on link/image markup we don't render yet.
   */
  description?: string;
  /**
   * Builder that returns a worked-example graph and its eval root.
   * Called once per docs page render. The returned graph should be
   * fully self-contained — its node ids are unique within the docs
   * page; no references to outside subgraphs.
   */
  sampleGraph?: () => {
    graph: import('./graph.js').Graph;
    rootNodeId: string;
    /**
     * Optional subgraph defs the sample graph references. Required for
     * nodes whose sample meaningfully uses subgraph wrapper kinds —
     * `iter/for-each-point` is the canonical case: the iteration body
     * IS a subgraph, so the sample has to author one and register it
     * alongside the main graph. Threaded through the docs page entry
     * (src/docs/main.tsx) into the store's `subgraphs` slice before
     * mount so the registry includes the wrapper kind by the time the
     * sample evaluates.
     */
    subgraphs?: import('./subgraph.js').SubgraphDef[];
  };
}

export interface NodeDef {
  id: string;
  category: string;
  inputs: InputDef[];
  outputs: OutputDef[];
  /**
   * Optional human-facing documentation. When present, the docs build
   * step emits a static page for this node at `docs/nodes/<id>/`, and
   * the [?] icon on the node header links to it. Missing-doc nodes
   * show no icon and are skipped by the generator.
   */
  doc?: NodeDoc;
  /**
   * When set, instances of this node may carry per-instance
   * `extraInputs` appended after `inputs`. The UI shows a "+ Add"
   * affordance on this node; clicking creates a new InputDef with
   * `namePrefix_${nextIdx}` and the given type. Used by `scene/merge`
   * (variadic merge) — most nodes leave this undefined and keep their
   * static input list.
   */
  extraInputsSpec?: {
    type: string;
    namePrefix: string;
    /** Button label, e.g. "Add scene". Defaults to "+ Add input". */
    addLabel?: string;
  };
  /**
   * Optional version stamp mixed into the eval cache's per-node fingerprint.
   * Undefined for core nodes — their behavior is fixed by the kind id, so
   * the kind is the version. Subgraph wrappers set this to the inner
   * graph's version counter so that an edit inside the subgraph (which
   * doesn't change the wrapper's kind) still invalidates the wrapper's
   * cached output.
   */
  version?: string | number;
  /**
   * Optional string mixed into the per-node fingerprint's `extra` field.
   * Used by subgraph boundary NodeDefs to fingerprint their interface
   * shape (input/output names + types) without coupling to the
   * subgraph's coarse version counter — that way, edits inside a
   * subgraph that don't change the boundary's interface (e.g. tweaking
   * a colour inside `oak-leaf`) don't move the boundary's fingerprint
   * and don't cascade-invalidate every inner node downstream of it.
   * Adding or removing a boundary input DOES change this string, so
   * the "stale outputs map" cache-hit bug from before still can't
   * recur. The evaluator concatenates this with any built-in `extra`
   * (currently the subgraph-input boundary's `subgraphInputFingerprints`).
   */
  fingerprintExtra?: string;
  // Nodes may evaluate synchronously (most: pure CPU work + GPU command
  // submission, both fire-and-forget) or asynchronously (anything that needs
  // a fence, mapAsync, fetch, etc. — e.g. heightfield-to-mesh reading back a
  // GPU texture). Returning a Promise is opt-in per node.
  evaluate(ctx: NodeContext, inputs: NodeInputs): NodeOutputs | Promise<NodeOutputs>;
  /**
   * Per-instance dynamic fingerprint contribution. Called once per
   * evaluation with the resolved inputs; the returned string is mixed
   * into the cache key alongside the declared inputs.
   *
   * Use for nodes whose output depends on STATE OUTSIDE the input
   * graph that can change between evals — e.g. `tex/image` reads an
   * external URL into a module-level bitmap cache; the URL alone
   * fingerprints the input, but a per-URL "loaded version" counter
   * forces the cache to miss on the eval that follows the fetch
   * landing.
   *
   * Most nodes shouldn't implement this — declare your inputs and let
   * the evaluator hash them. The escape hatch is for genuine
   * out-of-band state.
   */
  dynamicFingerprintExtra?(inputs: NodeInputs, ctx: NodeContext): string;
  /**
   * Opt-in: the node's output value depends on the calling subgraph
   * context (specifically `ctx.subgraphPath`), so the evaluator must
   * include that path in this node's fingerprint to avoid cache
   * pollution across contexts.
   *
   * Set this on any node that stamps provenance into its output:
   * scene-entity, instance-scene-on-points, merge-scene-entities. The
   * concrete bug it prevents: an asset-thumbnail evaluation of a
   * subgraph (with empty subgraphPath) populates the shared eval cache;
   * the main scene's wrapper invocation of the same subgraph then
   * cache-hits and reuses the wrong-provenance entities. With this
   * flag, the two contexts produce different fingerprints → separate
   * cache slots → correct provenance per context.
   *
   * Unset for non-provenance nodes (perlin, sphere, …) so thumbnails
   * and the main graph still share their (context-independent) cached
   * geometry and textures.
   */
  provenanceDependent?: boolean;
  /**
   * For iteration nodes (`iter/for-each-point` and future for-each-*
   * kinds): the per-iteration context values this kind PROVIDES to
   * its bridge subgraph. Drives:
   *   • The output sockets of the `iteration-input/<id>` boundary
   *     node placed inside the owned bridge subgraph (one output per
   *     entry, name + type matching).
   *   • The keys stamped into `ctx.iterationContext` per iteration
   *     by the iteration node's evaluate.
   *
   * By convention `position: Vec3` and `index: Int` are the
   * iteration-locator pair every iteration kind that walks a list
   * of "spots" provides; specialty kinds add their own (a future
   * for-each-face would add `normal`, `face_index`; for-each-segment
   * `tangent`, `length`, `start`, `end`; etc.).
   *
   * Undefined / empty when this NodeDef isn't an iteration node.
   */
  providedIterationContext?: ReadonlyArray<InputDef>;
}

export interface NodeRegistry {
  register(def: NodeDef): void;
  get(id: string): NodeDef | undefined;
  has(id: string): boolean;
  list(): NodeDef[];
}

export function createNodeRegistry(): NodeRegistry {
  const defs = new Map<string, NodeDef>();
  return {
    register(def) {
      if (defs.has(def.id)) {
        throw new Error(`node already registered: ${def.id}`);
      }
      defs.set(def.id, def);
    },
    get(id) {
      return defs.get(id);
    },
    has(id) {
      return defs.has(id);
    },
    list() {
      return [...defs.values()];
    },
  };
}

export function findInput(def: NodeDef, name: string): InputDef | undefined {
  return def.inputs.find((i) => i.name === name);
}

export function findOutput(def: NodeDef, name: string): OutputDef | undefined {
  return def.outputs.find((o) => o.name === name);
}
