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
   * When the evaluator is recursing into a subgraph, this carries the
   * input values from the wrapping subgraph-instance. The subgraph-input
   * boundary node reads from this to expose them to the inner graph.
   * Undefined at the top level.
   */
  subgraphInputs?: NodeInputs;
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
}

export type NodeInputs = Record<string, unknown>;
export type NodeOutputs = Record<string, unknown>;

export interface NodeDef {
  id: string;
  category: string;
  inputs: InputDef[];
  outputs: OutputDef[];
  /**
   * Optional version stamp mixed into the eval cache's per-node fingerprint.
   * Undefined for core nodes — their behavior is fixed by the kind id, so
   * the kind is the version. Subgraph wrappers set this to the inner
   * graph's version counter so that an edit inside the subgraph (which
   * doesn't change the wrapper's kind) still invalidates the wrapper's
   * cached output.
   */
  version?: string | number;
  // Nodes may evaluate synchronously (most: pure CPU work + GPU command
  // submission, both fire-and-forget) or asynchronously (anything that needs
  // a fence, mapAsync, fetch, etc. — e.g. heightfield-to-mesh reading back a
  // GPU texture). Returning a Promise is opt-in per node.
  evaluate(ctx: NodeContext, inputs: NodeInputs): NodeOutputs | Promise<NodeOutputs>;
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
