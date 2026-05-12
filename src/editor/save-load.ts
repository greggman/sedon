import { fromJSON, type Graph } from '../core/graph.js';
import type { SubgraphDef } from '../core/subgraph.js';

// On-disk save format. Bumped when the shape changes incompatibly.
// v1: graph + rootNodeId, no subgraphs.
// v2: adds subgraphs[].
export const SAVE_FORMAT_VERSION = 2;

export interface SaveFile {
  formatVersion: typeof SAVE_FORMAT_VERSION;
  graph: Graph;
  rootNodeId: string;
  /**
   * Subgraph definitions used by the project. Empty for projects that don't
   * use any. v1 files (no subgraphs field) load as if this were [].
   */
  subgraphs: SubgraphDef[];
}

export function serializeSaveFile(file: SaveFile): string {
  return JSON.stringify(file, null, 2);
}

/**
 * Parse the JSON text of a save file. Accepts both v1 (no subgraphs) and
 * v2 (with subgraphs). Throws on malformed input. Pure: no GPU / no
 * registry / no React dependencies, so it round-trips cleanly in tests.
 */
export function parseSaveFile(text: string): SaveFile {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const v = parsed.formatVersion as number | undefined;
  if (v !== 1 && v !== SAVE_FORMAT_VERSION) {
    throw new Error(
      `unsupported save file format ${v} (expected ${SAVE_FORMAT_VERSION} or 1)`,
    );
  }
  if (typeof parsed.rootNodeId !== 'string') {
    throw new Error('missing rootNodeId');
  }
  const graph = fromJSON(JSON.stringify(parsed.graph));
  const rawSubgraphs = parsed.subgraphs;
  const subgraphs = Array.isArray(rawSubgraphs)
    ? rawSubgraphs.map((sg) => parseSubgraphDef(sg))
    : [];
  return {
    formatVersion: SAVE_FORMAT_VERSION,
    graph,
    rootNodeId: parsed.rootNodeId,
    subgraphs,
  };
}

export function parseSubgraphDef(raw: unknown): SubgraphDef {
  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid subgraph: not an object');
  }
  const o = raw as Partial<SubgraphDef> & { graph?: unknown };
  if (
    typeof o.id !== 'string' ||
    typeof o.label !== 'string' ||
    typeof o.category !== 'string' ||
    typeof o.inputNodeId !== 'string' ||
    typeof o.outputNodeId !== 'string' ||
    !Array.isArray(o.inputs) ||
    !Array.isArray(o.outputs)
  ) {
    throw new Error('invalid subgraph: missing required fields');
  }
  const innerGraph = fromJSON(JSON.stringify(o.graph));
  return {
    id: o.id,
    label: o.label,
    category: o.category,
    inputs: o.inputs,
    outputs: o.outputs,
    graph: innerGraph,
    inputNodeId: o.inputNodeId,
    outputNodeId: o.outputNodeId,
  };
}
