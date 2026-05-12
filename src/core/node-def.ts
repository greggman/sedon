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
}

export type NodeInputs = Record<string, unknown>;
export type NodeOutputs = Record<string, unknown>;

export interface NodeDef {
  id: string;
  category: string;
  inputs: InputDef[];
  outputs: OutputDef[];
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
