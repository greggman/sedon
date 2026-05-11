import {
  Background,
  Controls,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type IsValidConnection,
  type Node,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect } from 'react';
import { findNode, type Graph } from '../core/graph.js';
import { createCoreTypeRegistry } from '../core/types.js';
import { CustomNode } from './custom-node.js';
import { useRegistry } from './registry.js';
import { graphToRfEdges, graphToRfNodes } from './rf-conversion.js';
import { useEditorStore } from './store.js';

const nodeTypes = { sedon: CustomNode };
const types = createCoreTypeRegistry();

// Snapshot from the store at mount time. After this, React Flow's local state
// owns visual representation; user actions sync compute-relevant changes back
// to the store via the callbacks below. The syncCounter effect below
// reconciles RF when the graph mutates from outside (load, undo, redo).
const seed = useEditorStore.getState().graph;

export function NodeCanvas() {
  const [rfNodes, , onRfNodesChange] = useNodesState(graphToRfNodes(seed));
  const [rfEdges, setRfEdges, onRfEdgesChange] = useEdgesState(graphToRfEdges(seed));

  const rf = useReactFlow();
  const connect = useEditorStore((s) => s.connect);
  const removeEdges = useEditorStore((s) => s.removeEdges);
  const removeNodes = useEditorStore((s) => s.removeNodes);
  const syncCounter = useEditorStore((s) => s.syncCounter);

  // External graph changes (load, undo, redo) reach React Flow via this
  // effect. Smart-merge: existing nodes keep their RF position so any drag
  // that happened since the last command isn't lost; new nodes use their
  // saved position; removed nodes drop out.
  useEffect(() => {
    if (syncCounter === 0) return;
    const graph = useEditorStore.getState().graph;
    rf.setNodes((current) => mergeRfNodes(current, graph));
    rf.setEdges(graphToRfEdges(graph));
  }, [syncCounter, rf]);

  // Keyboard shortcuts: Ctrl/Cmd+Z = undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y = redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (!meta) return;
      // Ignore when focus is in an editable field — let the field have its
      // own undo/redo behavior.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if (e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        useEditorStore.getState().undo();
      } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
        e.preventDefault();
        useEditorStore.getState().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onNodesChange = useCallback<OnNodesChange>(
    (changes) => {
      onRfNodesChange(changes);
      const removed = new Set<string>();
      for (const change of changes) {
        if (change.type === 'remove') removed.add(change.id);
      }
      if (removed.size > 0) removeNodes(removed);
    },
    [onRfNodesChange, removeNodes],
  );

  const onEdgesChange = useCallback<OnEdgesChange>(
    (changes) => {
      onRfEdgesChange(changes);
      const removed = new Set<string>();
      for (const change of changes) {
        if (change.type === 'remove') removed.add(change.id);
      }
      if (removed.size > 0) removeEdges(removed);
    },
    [onRfEdgesChange, removeEdges],
  );

  const onConnect = useCallback<OnConnect>(
    (params: Connection) => {
      if (!params.sourceHandle || !params.targetHandle) return;
      const id = crypto.randomUUID();
      // Visual: drop any existing edge into the same input, then add the new one
      // with the same id we'll send to the store so the two stay in sync.
      setRfEdges((eds) => [
        ...eds.filter((e) => !(e.target === params.target && e.targetHandle === params.targetHandle)),
        {
          id,
          source: params.source,
          target: params.target,
          sourceHandle: params.sourceHandle,
          targetHandle: params.targetHandle,
        },
      ]);
      connect(
        id,
        { node: params.source, socket: params.sourceHandle },
        { node: params.target, socket: params.targetHandle },
      );
    },
    [connect, setRfEdges],
  );

  const registry = useRegistry();
  const isValidConnection = useCallback<IsValidConnection>(
    (params: Connection | Edge) => {
      const source = 'source' in params ? params.source : null;
      const target = 'target' in params ? params.target : null;
      const sourceHandle = 'sourceHandle' in params ? (params as Connection).sourceHandle : null;
      const targetHandle = 'targetHandle' in params ? (params as Connection).targetHandle : null;
      if (!source || !target || !sourceHandle || !targetHandle) return false;
      if (source === target) return false;

      const graph = useEditorStore.getState().graph;
      const fromNode = findNode(graph, source);
      const toNode = findNode(graph, target);
      if (!fromNode || !toNode) return false;
      const fromDef = registry.get(fromNode.kind);
      const toDef = registry.get(toNode.kind);
      if (!fromDef || !toDef) return false;
      const fromOut = fromDef.outputs.find((o) => o.name === sourceHandle);
      const toIn = toDef.inputs.find((i) => i.name === targetHandle);
      if (!fromOut || !toIn) return false;
      return types.isCompatible(fromOut.type, toIn.type);
    },
    [registry],
  );

  return (
    <ReactFlow
      nodes={rfNodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      proOptions={{ hideAttribution: true }}
      selectionMode={SelectionMode.Partial}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}

// Reconcile React Flow's current node list against the graph's nodes,
// preserving position/dimensions/selection for nodes that survive while
// adding new nodes (from undo/redo restore or load) at their saved position.
function mergeRfNodes(current: Node[], graph: Graph): Node[] {
  const currentById = new Map(current.map((n) => [n.id, n]));
  return graph.nodes.map((g, i) => {
    const existing = currentById.get(g.id);
    if (existing) {
      // Keep RF state; just update the kind in case it ever changes.
      const existingKind = (existing.data as { kind?: string }).kind;
      if (existingKind === g.kind) return existing;
      return { ...existing, data: { ...existing.data, kind: g.kind } };
    }
    return {
      id: g.id,
      type: 'sedon',
      position: g.position ?? { x: i * 240, y: i * 80 },
      data: { kind: g.kind },
    };
  });
}
