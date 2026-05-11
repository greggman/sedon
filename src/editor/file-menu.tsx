import { useReactFlow } from '@xyflow/react';
import { fromJSON, type Graph } from '../core/graph.js';
import type { SubgraphDef } from '../core/subgraph.js';
import { confirmDiscardIfDirty } from './confirm-dirty.js';
import { buildRegistry } from './registry.js';
import { graphToRfEdges, graphToRfNodes } from './rf-conversion.js';
import { useEditorStore } from './store.js';

const SAVE_FORMAT_VERSION = 2;

interface SaveFile {
  formatVersion: typeof SAVE_FORMAT_VERSION;
  graph: Graph;
  rootNodeId: string;
  /**
   * Subgraph definitions used by the project. Empty for projects that don't
   * use any. v1 files (no subgraphs field) load as if this were [].
   */
  subgraphs: SubgraphDef[];
}

export function FileMenu() {
  const rf = useReactFlow();
  const setGraph = useEditorStore((s) => s.setGraph);
  const markClean = useEditorStore((s) => s.markClean);
  const commitActivePositions = useEditorStore((s) => s.commitActivePositions);

  const onSave = () => {
    // First, sync the active graph's drag-positions back to the store so
    // they get serialized. Whichever graph is currently being edited (main
    // or a subgraph) sees its positions persisted.
    const activePositions = new Map(
      rf.getNodes().map((n) => [n.id, n.position]),
    );
    commitActivePositions(activePositions);

    // Read MAIN graph + subgraphs from the store (NOT the active graph,
    // which may be a subgraph the user is currently editing — Save always
    // serializes the whole project).
    const state = useEditorStore.getState();
    const file: SaveFile = {
      formatVersion: SAVE_FORMAT_VERSION,
      graph: state.mainGraph,
      rootNodeId: state.mainRootNodeId,
      subgraphs: state.subgraphs,
    };
    const json = JSON.stringify(file, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sedon-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
    markClean();
  };

  const onLoad = () => {
    if (!confirmDiscardIfDirty()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as Record<string, unknown>;
        // Accept both v1 (no subgraphs) and v2 (with subgraphs).
        const v = parsed.formatVersion as number | undefined;
        if (v !== 1 && v !== SAVE_FORMAT_VERSION) {
          throw new Error(
            `unsupported save file format ${v} (expected ${SAVE_FORMAT_VERSION} or 1)`,
          );
        }
        if (typeof parsed.rootNodeId !== 'string') {
          throw new Error('missing rootNodeId');
        }
        const loadedGraph = fromJSON(JSON.stringify(parsed.graph));

        // Subgraphs: validate each inner graph; v1 files have none.
        const rawSubgraphs = parsed.subgraphs;
        const subgraphs = Array.isArray(rawSubgraphs)
          ? rawSubgraphs.map((sg) => parseSubgraphDef(sg))
          : [];

        setGraph(loadedGraph, parsed.rootNodeId as string, subgraphs);
        const registry = buildRegistry(subgraphs);
        rf.setNodes(graphToRfNodes(loadedGraph));
        rf.setEdges(graphToRfEdges(loadedGraph, registry));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-alert
        alert(`Failed to load: ${msg}`);
      }
    };
    input.click();
  };

  function parseSubgraphDef(raw: unknown): SubgraphDef {
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

  return (
    <>
      <button type="button" onClick={onSave} className="sedon-toolbar-button" title="Download graph as JSON">
        Save
      </button>
      <button type="button" onClick={onLoad} className="sedon-toolbar-button" title="Load graph from JSON">
        Load
      </button>
    </>
  );
}
