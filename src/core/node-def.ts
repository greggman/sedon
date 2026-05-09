export interface InputDef {
  name: string;
  type: string;
  default?: unknown;
  description?: string;
  // Marks an input as optional: when unconnected and no default and no
  // inputValue, the evaluator passes `undefined` rather than skipping the
  // node, and the validator does not flag it as missing. The node's evaluate()
  // is responsible for handling the undefined case.
  optional?: boolean;
}

export interface OutputDef {
  name: string;
  type: string;
  description?: string;
}

export interface NodeContext {
  device?: GPUDevice;
}

export type NodeInputs = Record<string, unknown>;
export type NodeOutputs = Record<string, unknown>;

export interface NodeDef {
  id: string;
  category: string;
  inputs: InputDef[];
  outputs: OutputDef[];
  evaluate(ctx: NodeContext, inputs: NodeInputs): NodeOutputs;
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
