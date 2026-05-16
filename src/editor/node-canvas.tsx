import {
  Background,
  Controls,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStoreApi,
  type Connection,
  type Edge,
  type IsValidConnection,
  type Node,
  type OnConnect,
  type OnEdgesChange,
  type OnMove,
  type OnNodesChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useRef } from 'react';
import { findNode, type Graph } from '../core/graph.js';
import { createCoreTypeRegistry } from '../core/types.js';
import {
  ADD_EXTRA_INPUT_HANDLE_ID,
  ADD_INPUT_HANDLE_ID,
  ADD_OUTPUT_HANDLE_ID,
  CustomNode,
  subgraphIdFromBoundaryKind,
} from './custom-node.js';
import { buildRegistry, useRegistry } from './registry.js';
import { edgeColor, graphToRfEdges, graphToRfNodes } from './rf-conversion.js';
import { useEditorStore } from './store.js';

const nodeTypes = { sedon: CustomNode };
const types = createCoreTypeRegistry();

// Snapshot from the store at mount time. After this, React Flow's local state
// owns visual representation; user actions sync compute-relevant changes back
// to the store via the callbacks below. The syncCounter effect below
// reconciles RF when the graph mutates from outside (load, undo, redo).
// The seed registry is built once from the initial subgraphs list so the
// first-mount edges already render with their type colors instead of
// flashing default-styled then re-styling on first sync.
const seedState = useEditorStore.getState();
const seedRegistry = buildRegistry(seedState.subgraphs);
const seed = seedState.graph;

export function NodeCanvas() {
  const [rfNodes, setRfNodes, onRfNodesChange] = useNodesState(graphToRfNodes(seed));
  const [rfEdges, setRfEdges, onRfEdgesChange] = useEdgesState(graphToRfEdges(seed, seedRegistry));

  const rf = useReactFlow();
  // We use RF's internal store directly (not useUpdateNodeInternals) because
  // the public hook defers measurement to a requestAnimationFrame — by the
  // time it actually runs, our setRfEdges has already triggered a render
  // and EdgeWrapper has already logged the "couldn't find handle" warning.
  // We need the measurement to happen SYNCHRONOUSLY between setRfNodes and
  // setRfEdges, so the bounds are populated before EdgeWrapper looks them
  // up on its first render of the new edges.
  const rfStore = useStoreApi();
  const connect = useEditorStore((s) => s.connect);
  const removeEdges = useEditorStore((s) => s.removeEdges);
  const removeNodes = useEditorStore((s) => s.removeNodes);
  const addSubgraphSocketWithEdge = useEditorStore((s) => s.addSubgraphSocketWithEdge);
  const addNodeExtraInputWithEdge = useEditorStore((s) => s.addNodeExtraInputWithEdge);
  const currentEditingId = useEditorStore((s) => s.currentEditingId);
  const viewports = useEditorStore((s) => s.viewports);
  const registry = useRegistry();

  // External graph changes (load, undo, redo, drag-create) reach React
  // Flow via this useEffect. It runs AFTER React commits the store-
  // driven render — so by the time we get here, the boundary's
  // CustomNode has already re-rendered (its def comes from
  // useRegistry, which depends on subgraphs) and any new handle is in
  // the DOM. But RF's per-node ResizeObserver, which is what populates
  // handle bounds in RF's internal store, fires async in a separate
  // browser task and may not have run yet — so if we hand RF the new
  // edge here, EdgeWrapper looks up the new handle's bounds, finds
  // nothing, and logs error 008.
  //
  // The fix is to measure the new handle's bounds synchronously right
  // here, between setRfNodes and setRfEdges. The public hook
  // useUpdateNodeInternals defers its measurement to a rAF (which
  // would run AFTER setRfEdges and the resulting EdgeWrapper render
  // — too late), so we reach into RF's internal store directly and
  // call its `updateNodeInternals` action ourselves. By the time
  // setRfEdges propagates, every handle the new edges reference is
  // already in RF's nodeLookup with measured bounds.
  const syncCounter = useEditorStore((s) => s.syncCounter);
  useEffect(() => {
    if (syncCounter === 0) return;
    const graph = useEditorStore.getState().graph;
    setRfNodes((current) => mergeRfNodes(current, graph));

    const { domNode, updateNodeInternals } = rfStore.getState();
    const updates = new Map<string, { id: string; nodeElement: HTMLDivElement; force: boolean }>();
    for (const node of graph.nodes) {
      const nodeElement = domNode?.querySelector(
        `.react-flow__node[data-id="${node.id}"]`,
      ) as HTMLDivElement | null;
      if (nodeElement) {
        updates.set(node.id, { id: node.id, nodeElement, force: true });
      }
    }
    if (updates.size > 0) {
      updateNodeInternals(updates, { triggerFitView: false });
    }

    setRfEdges(graphToRfEdges(graph, registry));
  }, [syncCounter, registry, setRfNodes, setRfEdges, rfStore]);

  // Per-graph viewport: save on context switch, load (or fit) on entry.
  // Same shape as the per-graph camera effect in preview.tsx. Fires also
  // when the viewports map identity changes (e.g., demo load pre-seeds a
  // viewport for 'main'), but skips the redundant setViewport when the
  // stored value already matches RF's current viewport so we don't fight
  // the user's own pan/zoom that just produced it.
  const prevContextRef = useRef<string | null>(null);
  const prevViewportsRef = useRef<typeof viewports | null>(null);
  useEffect(() => {
    const prevId = prevContextRef.current;
    const prevViewports = prevViewportsRef.current;
    const idChanged = prevId !== currentEditingId;
    const viewportsChanged = prevViewports !== viewports;
    prevContextRef.current = currentEditingId;
    prevViewportsRef.current = viewports;
    if (!idChanged && !viewportsChanged) return;

    if (idChanged && prevId !== null) {
      useEditorStore.getState().saveViewportFor(prevId, rf.getViewport());
    }

    const stored = viewports[currentEditingId];
    if (stored) {
      const current = rf.getViewport();
      const same =
        current.x === stored.x &&
        current.y === stored.y &&
        current.zoom === stored.zoom;
      if (!same) rf.setViewport(stored);
    } else if (idChanged) {
      // No saved viewport for the new context — fit. Defer one frame so
      // RF can measure the nodes from the sync-counter effect above (which
      // ran in this same render cycle).
      requestAnimationFrame(() => rf.fitView({ padding: 0.2 }));
    }
  }, [currentEditingId, viewports, rf]);

  const onMoveEnd = useCallback<OnMove>(
    (_event, viewport: Viewport) => {
      const id = useEditorStore.getState().currentEditingId;
      useEditorStore.getState().saveViewportFor(id, viewport);
    },
    [],
  );

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
      const graph = useEditorStore.getState().graph;

      // Phantom drops on the "+ Add" row of a subgraph boundary. Don't
      // touch rfEdges here — the syncCounter effect re-derives them from
      // the updated graph after the store dispatch lands.
      if (params.targetHandle === ADD_OUTPUT_HANDLE_ID) {
        const boundaryNode = findNode(graph, params.target);
        const boundary = subgraphIdFromBoundaryKind(boundaryNode?.kind);
        if (!boundary || boundary.side !== 'output') return;
        const fromNode = findNode(graph, params.source);
        const fromDef = fromNode ? registry.get(fromNode.kind) : undefined;
        const fromOut = fromDef?.outputs.find((o) => o.name === params.sourceHandle);
        if (!fromOut) return;
        addSubgraphSocketWithEdge(boundary.subgraphId, 'output', fromOut.type, {
          node: params.source,
          socket: params.sourceHandle,
        });
        return;
      }
      if (params.sourceHandle === ADD_INPUT_HANDLE_ID) {
        const boundaryNode = findNode(graph, params.source);
        const boundary = subgraphIdFromBoundaryKind(boundaryNode?.kind);
        if (!boundary || boundary.side !== 'input') return;
        const toNode = findNode(graph, params.target);
        const toDef = toNode ? registry.get(toNode.kind) : undefined;
        const toIn =
          toDef?.inputs.find((i) => i.name === params.targetHandle) ??
          toNode?.extraInputs?.find((i) => i.name === params.targetHandle);
        if (!toIn) return;
        addSubgraphSocketWithEdge(boundary.subgraphId, 'input', toIn.type, {
          node: params.target,
          socket: params.targetHandle,
        });
        return;
      }

      // Phantom drop on a variadic node's "+ Add" handle: create a new
      // extra input and connect the dropped edge to it in one undoable
      // step.
      if (params.targetHandle === ADD_EXTRA_INPUT_HANDLE_ID) {
        const toNode = findNode(graph, params.target);
        const toDef = toNode ? registry.get(toNode.kind) : undefined;
        const spec = toDef?.extraInputsSpec;
        if (!toDef || !spec) return;
        const fromNode = findNode(graph, params.source);
        const fromDef = fromNode ? registry.get(fromNode.kind) : undefined;
        const fromOut = fromDef?.outputs.find((o) => o.name === params.sourceHandle);
        if (!fromOut) return;
        if (!types.isCompatible(fromOut.type, spec.type)) return;
        addNodeExtraInputWithEdge(
          params.target,
          spec.type,
          spec.namePrefix,
          toDef.inputs.length,
          { node: params.source, socket: params.sourceHandle },
        );
        return;
      }

      const id = crypto.randomUUID();
      const color = edgeColor(graph, params.source, params.sourceHandle, registry);
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
          style: { stroke: color, strokeWidth: 2 },
        },
      ]);
      connect(
        id,
        { node: params.source, socket: params.sourceHandle },
        { node: params.target, socket: params.targetHandle },
      );
    },
    [connect, setRfEdges, registry, addSubgraphSocketWithEdge, addNodeExtraInputWithEdge],
  );

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

      // Phantom "+ Add" drops on a subgraph boundary: the boundary
      // adopts the other end's type at create time, so we only need to
      // verify the OTHER end resolves to a real socket and that the
      // boundary kind matches its handle direction.
      if (targetHandle === ADD_OUTPUT_HANDLE_ID) {
        const boundary = subgraphIdFromBoundaryKind(toNode.kind);
        if (!boundary || boundary.side !== 'output') return false;
        return !!fromDef.outputs.find((o) => o.name === sourceHandle);
      }
      if (sourceHandle === ADD_INPUT_HANDLE_ID) {
        const boundary = subgraphIdFromBoundaryKind(fromNode.kind);
        if (!boundary || boundary.side !== 'input') return false;
        return (
          !!toDef.inputs.find((i) => i.name === targetHandle) ||
          !!toNode.extraInputs?.find((i) => i.name === targetHandle)
        );
      }
      // Phantom drop on a variadic node's "+ Add" handle: source must be
      // a real output whose type is compatible with the spec's type.
      if (targetHandle === ADD_EXTRA_INPUT_HANDLE_ID) {
        const spec = toDef.extraInputsSpec;
        if (!spec) return false;
        const fromOut = fromDef.outputs.find((o) => o.name === sourceHandle);
        if (!fromOut) return false;
        return types.isCompatible(fromOut.type, spec.type);
      }

      const fromOut = fromDef.outputs.find((o) => o.name === sourceHandle);
      const toIn =
        toDef.inputs.find((i) => i.name === targetHandle) ??
        toNode.extraInputs?.find((i) => i.name === targetHandle);
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
      onMoveEnd={onMoveEnd}
      proOptions={{ hideAttribution: true }}
      selectionMode={SelectionMode.Partial}
      minZoom={0.1}
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
