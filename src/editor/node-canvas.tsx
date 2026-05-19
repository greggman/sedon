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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { evaluateGraph } from '../core/evaluate.js';
import { findNode, type Graph } from '../core/graph.js';
import type { NodeOutputs } from '../core/node-def.js';
import { createCoreTypeRegistry } from '../core/types.js';
import { beginCacheEval, endCacheEval, useCacheConsumer } from './cache-coordinator.js';
import { CanvasPanelContext } from './canvas-panel-context.js';
import {
  ADD_EXTRA_INPUT_HANDLE_ID,
  ADD_INPUT_HANDLE_ID,
  ADD_OUTPUT_HANDLE_ID,
  CustomNode,
  subgraphIdFromBoundaryKind,
} from './custom-node.js';
import { useLayoutStore } from './layout-store.js';
import { buildRegistry, useRegistry } from './registry.js';
import { edgeColor, graphToRfEdges, graphToRfNodes } from './rf-conversion.js';
import { registerCanvasRf, unregisterCanvasRf } from './rf-registry.js';
import { useEditorStore } from './store.js';

const nodeTypes = { sedon: CustomNode };
const types = createCoreTypeRegistry();

// Module-level seed registry — built once from the initial subgraphs
// list so the first-mount edges already render with their type colors
// instead of flashing default-styled then re-styling on first sync.
// The graph itself is now per-canvas (see `panelGraph` inside
// NodeCanvas) since each canvas pins to its own graph; only the
// registry is process-wide.
const seedState = useEditorStore.getState();
const seedRegistry = buildRegistry(seedState.subgraphs);

interface NodeCanvasProps {
  /**
   * DockView panel id. Used to scope per-canvas viewport (pan/zoom)
   * state in the layout store so two canvas panes editing the same
   * graph maintain independent views.
   */
  panelId: string;
}

export function NodeCanvas({ panelId }: NodeCanvasProps) {
  // Which graph THIS canvas is editing. Per-canvas pinning replaces the
  // old "every canvas follows currentEditingId" model: now each canvas
  // can show a different graph and asset-view "Open in Canvas" actions
  // target one panel without disturbing the others. Falls back to the
  // editor store's currentEditingId for canvases that haven't been
  // pinned yet (the default for a freshly-created Canvas View).
  const pinnedGraphId = useLayoutStore((s) => s.canvasGraphIds[panelId]);
  const currentEditingId = useEditorStore((s) => s.currentEditingId);
  const effectiveGraphId = pinnedGraphId ?? currentEditingId;

  // Subscribe to whichever graph this canvas is showing. useShallow
  // means a render only happens when this specific graph reference
  // changes — edits to a different canvas's graph don't disturb us.
  // Also resolve the eval root: prefer a user-authored core/output in
  // the graph (the same rule Preview uses), falling back to the
  // subgraph's boundary output. We need a valid root id even with
  // scope: 'all' because evaluateGraph reads `rootOutputs` from it.
  const { graph: panelGraph, rootNodeId: panelRootNodeId } = useEditorStore(
    useShallow((s) => {
      if (effectiveGraphId === 'main') {
        return { graph: s.mainGraph, rootNodeId: s.mainRootNodeId };
      }
      const sg = s.subgraphs.find((x) => x.id === effectiveGraphId);
      if (!sg) return { graph: s.mainGraph, rootNodeId: s.mainRootNodeId };
      const previewOutput = sg.graph.nodes.find((n) => n.kind === 'core/output');
      return {
        graph: sg.graph,
        rootNodeId: previewOutput?.id ?? sg.outputNodeId,
      };
    }),
  );

  // Live positions for the graph THIS canvas is showing. Subscribed
  // separately from `panelGraph` so a drag-stop on another canvas
  // editing the same graph doesn't force this canvas to re-merge
  // through the heavy graph-reference path — only the positions
  // selector fires, and mergeRfNodes can produce an updated RF node
  // list cheaply.
  const panelPositions = useEditorStore((s) => s.nodePositions[effectiveGraphId]);
  const [rfNodes, setRfNodes, onRfNodesChange] = useNodesState(
    graphToRfNodes(panelGraph, panelPositions),
  );
  const [rfEdges, setRfEdges, onRfEdgesChange] = useEdgesState(graphToRfEdges(panelGraph, seedRegistry));

  const rf = useReactFlow();
  // Register this canvas's RF instance so toolbar items that need RF
  // (CleanupButton's auto-layout, etc.) can look it up by panelId
  // instead of relying on a shared provider. Unregister on unmount so
  // a closed panel's stale RF isn't picked up by "active canvas"
  // lookups.
  useEffect(() => {
    registerCanvasRf(panelId, rf);
    return () => unregisterCanvasRf(panelId);
  }, [panelId, rf]);

  // Auto-pin each canvas to whatever graph it first sees. Without
  // this, an unpinned canvas falls back to `currentEditingId`, so the
  // moment something else flips that global (e.g. asset-view double-
  // click → openGraphInCanvas → setActiveEditing) every unpinned
  // canvas changes too. Pinning at mount captures the user's intent:
  // "this panel was showing X" stays "this panel shows X" unless they
  // explicitly retarget it.
  useEffect(() => {
    const layout = useLayoutStore.getState();
    if (!layout.canvasGraphIds[panelId]) {
      const initial = useEditorStore.getState().currentEditingId;
      layout.setCanvasGraphId(panelId, initial);
    }
  }, [panelId]);
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
  // Project-level viewports map — used only as the initial seed for a
  // panel that hasn't recorded its own viewport for this graph yet.
  // Once the user pans/zooms in a panel, the per-panel layout-store
  // entry below takes over; we no longer write back to project.viewports
  // so two panels can't race the persistent map.
  const projectViewports = useEditorStore((s) => s.viewports);
  const panelViewports = useLayoutStore((s) => s.canvasViewports[panelId]);
  const recentCanvasViewports = useLayoutStore((s) => s.recentCanvasViewports);
  const saveCanvasViewport = useLayoutStore((s) => s.saveCanvasViewport);
  const registry = useRegistry();

  // Per-canvas evaluation. Each canvas evaluates ITS pinned graph so
  // in-node previews (ScenePreview, MaterialPreview, TexturePreview)
  // have outputs to display — independent of which graph any Preview
  // pane is showing. Without this, opening a subgraph in a canvas
  // while no Preview is pinned to it would leave every node showing
  // just the "—" placeholder (state.evalResult is fed by the active
  // Preview, which doesn't know about this canvas).
  //
  // Also registers as a cache consumer so the entries this canvas
  // depends on aren't evicted by another consumer's sweep. Without
  // that, an eval round in a sibling Preview would destroy textures
  // this canvas's in-node previews still hold → "Destroyed texture
  // used in a submit".
  const device = useEditorStore((s) => s.device);
  const evalCache = useEditorStore((s) => s.evalCache);
  const reportWorking = useCacheConsumer();
  const [canvasAllOutputs, setCanvasAllOutputs] = useState<Map<string, NodeOutputs> | null>(null);
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    beginCacheEval();
    void (async () => {
      const touched = new Set<string>();
      try {
        const result = await evaluateGraph(panelGraph, registry, {
          rootNodeId: panelRootNodeId,
          context: { device },
          cache: evalCache,
          touched,
          scope: 'all',
        });
        if (cancelled) return;
        reportWorking(touched);
        setCanvasAllOutputs(result.allOutputs);
      } catch (e) {
        // Eval errors are common in mid-edit graphs (missing required
        // input, type mismatch). Log but keep the canvas usable —
        // in-node previews will just show placeholders for the
        // affected nodes.
        if (!cancelled) console.warn('canvas eval failed', e);
      } finally {
        endCacheEval();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [device, panelGraph, panelRootNodeId, registry, evalCache, reportWorking]);

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
  // External graph changes (load, undo, redo, edits in another canvas
  // pinned to this same graph) AND panel-graph switches (asset
  // "Open in Canvas") both flow through this effect now. mergeRfNodes
  // reconciles against `panelGraph` — the per-canvas graph reference —
  // not the editor store's global active graph, so canvas A swapping
  // graphs no longer disrupts canvas B.
  //
  // Re-runs on:
  //   • syncCounter (any store edit)
  //   • panelGraph reference change (panel switched to a different graph,
  //     or this graph was edited by another canvas)
  //   • registry (subgraph defs changed, so edge colors update)
  // Two-pass sync state. When the panel swaps to a different graph,
  // Effect 1 clears RF edges + writes new nodes, then sets
  // pendingEdgeSync. Effect 2 fires on the NEXT render (after Effect
  // 1's commit), by which time:
  //   • Phase A's render has committed: new nodes are in the DOM.
  //   • Each new node's NodeWrapper passive useEffect has run, which
  //     calls observer.observe() on the node element.
  //   • Even if ResizeObserver hasn't delivered yet, we call
  //     updateNodeInternals(force:true, nodeElement) which forces a
  //     synchronous getBoundingClientRect — that's how handleBounds
  //     gets populated. Then we setRfEdges, and RF renders edges
  //     against measured handles.
  // The state-based two-pass is deterministic — rAF + ResizeObserver
  // timing varies between browsers and React reconciliation phases.
  const [pendingEdgeSync, setPendingEdgeSync] = useState<{
    panelGraph: Graph;
    registry: typeof seedRegistry;
  } | null>(null);

  // Re-sync trigger: only the `panelGraph` reference. When this canvas's
  // graph changes (open-in-canvas, edit to THIS graph in another pane,
  // load), the selector returns a new graph object and this effect fires.
  // We deliberately do NOT depend on syncCounter — that bumps for every
  // edit anywhere, including edits to other canvases' graphs, and used
  // to cause this effect to re-run unnecessarily on this canvas. The
  // spurious re-runs called updateNodeInternals → set({}) → cascade →
  // EdgeWrapper selectors → getEdgePosition for handles that may be
  // mid-rebuild, producing React Flow error 008.
  useEffect(() => {
    // Swap detection: do ANY current RF nodes appear in the new graph?
    // If not, this is a full replacement (asset-view "Open in Canvas",
    // project load, demo switch). We use node-set overlap rather than
    // graphId change because load-project keeps the same graphId
    // ('main') but replaces the whole node list.
    const currentRfNodes = rfStore.getState().nodes;
    const newIds = new Set(panelGraph.nodes.map((n) => n.id));
    const hasOverlap = currentRfNodes.some((n) => newIds.has(n.id));
    const isSwap = currentRfNodes.length > 0 && !hasOverlap;

    if (!isSwap) {
      // Incremental case: same graph, edits applied to it. Existing RF
      // nodes already have measured handles; any new handle on an
      // existing node can be measured synchronously since its node
      // element is in the DOM.
      setRfNodes((current) => mergeRfNodes(current, panelGraph, panelPositions));
      const { domNode, updateNodeInternals } = rfStore.getState();
      const updates = new Map<string, { id: string; nodeElement: HTMLDivElement; force: boolean }>();
      for (const node of panelGraph.nodes) {
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
      setRfEdges(graphToRfEdges(panelGraph, registry));
      return;
    }

    // Swap: clear edges, write new nodes, defer edge re-set to Effect 2.
    setRfEdges([]);
    setRfNodes((current) => mergeRfNodes(current, panelGraph, panelPositions));
    setPendingEdgeSync({ panelGraph, registry });
  }, [panelGraph, registry, setRfNodes, setRfEdges, rfStore, panelPositions]);

  // Position-only sync. Drag commits write to the `nodePositions`
  // slice without producing a new `panelGraph` reference, so the
  // graph-driven effect above doesn't fire. This cheaper effect
  // catches the position change, pushes the new coordinates into RF,
  // and mergeRfNodes' "existing.position === livePos" short-circuit
  // makes it a no-op on the canvas that just finished the drag.
  useEffect(() => {
    setRfNodes((current) => mergeRfNodes(current, panelGraph, panelPositions));
    // panelGraph is intentionally NOT in deps: this effect is for the
    // position-only path. Graph-structural changes are handled by the
    // effect above. The closure's captured panelGraph is fine — when
    // it changes, that other effect will re-run with the fresh graph.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelPositions, setRfNodes]);

  // Effect 2: fires after Effect 1's commit when a swap has been
  // initiated. At this point the new nodes' DOM exists and their
  // NodeWrappers have started observing for measurement. We force a
  // synchronous measure (getBoundingClientRect via updateNodeInternals)
  // so RF's nodeLookup has handleBounds for every new node BEFORE we
  // hand it the new edges. Without this, EdgeWrapper's getEdgePosition
  // call would race the ResizeObserver and log error 008.
  useEffect(() => {
    if (!pendingEdgeSync) return;
    const { domNode, updateNodeInternals } = rfStore.getState();
    const updates = new Map<string, { id: string; nodeElement: HTMLDivElement; force: boolean }>();
    for (const node of pendingEdgeSync.panelGraph.nodes) {
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
    setRfEdges(graphToRfEdges(pendingEdgeSync.panelGraph, pendingEdgeSync.registry));
    setPendingEdgeSync(null);
  }, [pendingEdgeSync, setRfEdges, rfStore]);

  // Per-panel × per-graph viewport: save the outgoing panel/graph view
  // before swapping, then restore (or fit) for the new one. The lookup
  // tier is:
  //
  //   1. This panel's own recorded viewport for this graph (panelViewports)
  //   2. The project-level last-known viewport for this graph (projectViewports)
  //   3. Fallback to fitView()
  //
  // Two canvases editing the same graph each have their own entry under
  // (1), so panning one doesn't move the other. We only seed from (2)
  // on the very first time a panel sees a graph; from then on (1) is
  // authoritative for this panel.
  const prevContextRef = useRef<string | null>(null);
  const prevPanelViewportsRef = useRef<typeof panelViewports | null>(null);
  useEffect(() => {
    const prevId = prevContextRef.current;
    const prevPanelViewports = prevPanelViewportsRef.current;
    const idChanged = prevId !== effectiveGraphId;
    const panelViewportsChanged = prevPanelViewports !== panelViewports;
    prevContextRef.current = effectiveGraphId;
    prevPanelViewportsRef.current = panelViewports;
    if (!idChanged && !panelViewportsChanged) return;

    if (idChanged && prevId !== null) {
      saveCanvasViewport(panelId, prevId, rf.getViewport());
    }

    // Lookup chain when this panel hasn't recorded its own viewport
    // for the new graph yet:
    //   1. recentCanvasViewports[graphId] — LRU across all canvases this
    //      session. Covers "I had a view of this graph in another panel,
    //      now I'm opening it here".
    //   2. projectViewports[graphId] — cross-session seed from save file.
    //   3. fitView (handled by the `else if (idChanged)` branch below).
    const stored =
      panelViewports?.[effectiveGraphId] ??
      recentCanvasViewports[effectiveGraphId] ??
      projectViewports[effectiveGraphId];
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
  }, [effectiveGraphId, panelViewports, recentCanvasViewports, projectViewports, panelId, rf, saveCanvasViewport]);

  const onMoveEnd = useCallback<OnMove>(
    (_event, viewport: Viewport) => {
      saveCanvasViewport(panelId, effectiveGraphId, viewport);
    },
    [panelId, effectiveGraphId, saveCanvasViewport],
  );

  // Commit node positions to the store at drag-stop and bump syncCounter
  // so any OTHER canvas viewing the same graph re-renders with the new
  // positions. `nodes` is RF's selection-aware set: if the user dragged
  // a multi-selection, all selected nodes commit together.
  const commitDragged = useCallback((nodes: Node[]) => {
    if (nodes.length === 0) return;
    const positions = new Map(nodes.map((n) => [n.id, n.position]));
    useEditorStore.getState().commitActivePositions(positions);
  }, []);
  const onNodeDragStop = useCallback(
    (_evt: unknown, _node: Node, nodes: Node[]) => commitDragged(nodes),
    [commitDragged],
  );
  const onSelectionDragStop = useCallback(
    (_evt: unknown, nodes: Node[]) => commitDragged(nodes),
    [commitDragged],
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
        // Use the source socket's label (or name) as the preferred
        // label for the new boundary output so wiring `worley.cells`
        // lands as "cells" rather than "untitled".
        const preferredLabel = fromOut.label ?? fromOut.name;
        addSubgraphSocketWithEdge(
          boundary.subgraphId,
          'output',
          fromOut.type,
          { node: params.source, socket: params.sourceHandle },
          { preferredLabel },
        );
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
        // Capture whatever value `toIn` was effectively resolving to
        // BEFORE the wire takes over. Priority: explicit per-instance
        // override first, then the node def's declared default. We
        // hand that to the store so the new boundary input's
        // `default` becomes the same value — that way the subgraph
        // looks identical standalone AND any wrapper instance that
        // doesn't wire the new input falls back to the same value
        // instead of the system white/0 fallback.
        const capturedDefault =
          toNode?.inputValues?.[params.targetHandle] !== undefined
            ? toNode.inputValues[params.targetHandle]
            : toIn.default;
        // Use the target socket's label (or name) as the preferred
        // boundary-input label so wiring `colorize.low` → boundary
        // lands as "low" rather than "untitled". The store dedupes
        // against existing labels by appending `-2`, `-3`, …
        const preferredLabel = toIn.label ?? toIn.name;
        addSubgraphSocketWithEdge(
          boundary.subgraphId,
          'input',
          toIn.type,
          { node: params.target, socket: params.targetHandle },
          {
            ...(capturedDefault !== undefined ? { capturedDefault } : {}),
            preferredLabel,
          },
        );
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

  // Edits dispatched by RF callbacks (onConnect, removeNodes via
  // onNodesChange, etc.) target the editor store's `state.graph`,
  // which is the graph currently being edited. With per-canvas
  // pinning that graph might differ from this canvas's pin until we
  // claim editing context. Pointer-down (capture phase, runs before
  // any RF handler) checks and syncs `currentEditingId` first so any
  // edit landing in the same gesture hits the correct backing graph.
  const onPointerDownCapture = useCallback(() => {
    if (effectiveGraphId !== useEditorStore.getState().currentEditingId) {
      useEditorStore.getState().setActiveEditing(effectiveGraphId);
    }
  }, [effectiveGraphId]);

  // Memoize so context consumers don't tear down on every render.
  // (CustomNode reads `graph` to look itself up — the rendered identity
  // of every CustomNode in this canvas depends on it staying stable
  // across renders that don't change the graph.)
  const canvasPanelInfo = useMemo(
    () => ({ panelId, graph: panelGraph, allOutputs: canvasAllOutputs }),
    [panelId, panelGraph, canvasAllOutputs],
  );

  return (
    <CanvasPanelContext.Provider value={canvasPanelInfo}>
      <div
        // Wrapper is fullsize so the capture-phase pointerdown is hit
        // for clicks anywhere in the canvas, including on nodes.
        style={{ width: '100%', height: '100%' }}
        onPointerDownCapture={onPointerDownCapture}
      >
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onMoveEnd={onMoveEnd}
          onNodeDragStop={onNodeDragStop}
          onSelectionDragStop={onSelectionDragStop}
          proOptions={{ hideAttribution: true }}
          selectionMode={SelectionMode.Partial}
          minZoom={0.1}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </CanvasPanelContext.Provider>
  );
}

// Reconcile React Flow's current node list against the graph's nodes,
// preserving position/dimensions/selection for nodes that survive while
// adding new nodes (from undo/redo restore or load) at their saved position.
function mergeRfNodes(
  current: Node[],
  graph: Graph,
  positions: Record<string, { x: number; y: number }> | undefined,
): Node[] {
  const currentById = new Map(current.map((n) => [n.id, n]));
  return graph.nodes.map((g, i) => {
    // Resolve the authoritative position for this node: live slice
    // first (drag commits write there), then the graph-node carrier
    // (for nodes just added by a command that brought a position
    // along), then a deterministic fallback.
    const livePos = positions?.[g.id] ?? g.position;
    const existing = currentById.get(g.id);
    if (existing) {
      // Keep RF's measured dimensions / selection / etc., but reconcile
      // the few authored fields that can drift between canvases:
      //   • `kind` (rarely changes, but a wrapper swap could)
      //   • `position` — when another canvas commits a drag, this
      //     canvas's RF needs to pick it up. The dragging canvas's RF
      //     position already matches, so this is a no-op for it.
      const existingKind = (existing.data as { kind?: string }).kind;
      const sameKind = existingKind === g.kind;
      const samePos =
        !livePos ||
        (existing.position.x === livePos.x && existing.position.y === livePos.y);
      if (sameKind && samePos) return existing;
      const next: Node = { ...existing };
      if (!sameKind) next.data = { ...existing.data, kind: g.kind };
      if (!samePos && livePos) next.position = livePos;
      return next;
    }
    return {
      id: g.id,
      type: 'sedon',
      position: livePos ?? { x: i * 240, y: i * 80 },
      data: { kind: g.kind },
    };
  });
}
