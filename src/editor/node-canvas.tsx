import {
  Background,
  ControlButton,
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
  type OnDelete,
  type OnEdgesChange,
  type OnMove,
  type OnNodesChange,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { evaluateGraph } from '../core/evaluate.js';
import { useImageLoadGeneration } from '../nodes/image.js';
import { animationDelta, animationTime } from './render-bus.js';
import { useProjectAnimReachability } from './anim-reachability.js';
import { useAnimFrameGeneration } from './use-anim-frame.js';
import { canonicalJson } from '../core/eval-cache.js';
import { findNode, findOutputOnNode, type Graph } from '../core/graph.js';
import { createCoreTypeRegistry } from '../core/types.js';
import { AddNodePicker } from './add-node-picker.js';
import { usePickerBus } from './add-node-picker-bus.js';
import { beginCacheEval, endCacheEval, useCacheConsumer } from './cache-coordinator.js';
import { CanvasContextMenu } from './canvas-context-menu.js';
import { buildCanvasMenuItems } from './canvas-menu-items.js';
import { CanvasPanelContext } from './canvas-panel-context.js';
import { clearCanvasData, setCanvasGraph, setCanvasOutputs } from './canvas-data.js';
import {
  ADD_INPUT_HANDLE_ID,
  ADD_OUTPUT_HANDLE_ID,
  CustomNode,
  subgraphIdFromBoundaryKind,
} from './custom-node.js';
import { useLayoutStore } from './layout-store.js';
import { navigateCanvasBack, navigateCanvasForward } from './open-graph.js';
import { requestRender } from './render-bus.js';
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

  // When this canvas is drilled into a SUBGRAPH, the user expects the
  // in-node previews to reflect an ISOLATED-eval view — i.e. driven by
  // the subgraph's declared input defaults, not by whichever values
  // the parent forest happens to wire in. The canvas already evals
  // with no `subgraphInputs` context (= standalone), but editing a
  // default mutates `SubgraphDef.inputs[].default` without changing
  // `panelGraph` — so the eval effect doesn't re-fire and the
  // in-node previews stay stale.
  //
  // Track a shape key of the active subgraph's inputs (matching the
  // boundary's `inputShape` fingerprint extra) and add it to the eval
  // effect's deps below. Same idea as the boundary's fingerprintExtra:
  // when name / type / default changes, the standaloneDefaults map
  // changes, so we must re-evaluate.
  const subgraphInputsKey = useEditorStore((s) => {
    if (effectiveGraphId === 'main') return '';
    const sg = s.subgraphs.find((x) => x.id === effectiveGraphId);
    if (!sg) return '';
    return canonicalJson(
      sg.inputs.map((i) => ({ name: i.name, type: i.type, default: i.default ?? null })),
    );
  });

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
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    registerCanvasRf(panelId, rf, wrapperRef.current);
    return () => unregisterCanvasRf(panelId);
  }, [panelId, rf]);

  // Auto-pin each canvas to whatever graph it first sees. Without
  // this, an unpinned canvas falls back to `currentEditingId`, so the
  // moment something else flips that global (e.g. asset-view double-
  // click → openGraphInCanvas → setActiveEditing) every unpinned
  // canvas changes too. Pinning at mount captures the user's intent:
  // "this panel was showing X" stays "this panel shows X" unless they
  // explicitly retarget it.
  //
  // Depend on the OBSERVED `pinnedGraphId` so the effect re-fires if
  // a project load wipes `canvasGraphIds` via resetForNewProject. The
  // panel survives the wipe (DockView keeps it) but its pin is gone;
  // without this re-fire the canvas becomes silently unpinned and
  // starts following `currentEditingId` again — which is exactly the
  // "I split right and then opened a subgraph, why did BOTH canvases
  // switch?" bug.
  useEffect(() => {
    if (pinnedGraphId !== undefined) return;
    const initial = useEditorStore.getState().currentEditingId;
    const layout = useLayoutStore.getState();
    layout.setCanvasGraphId(panelId, initial);
    // Seed nav history with the initial graph so future Back can return
    // to it. recordCanvasNavigation no-ops if the panel already has a
    // history entry, so this never clobbers state restored by other
    // paths (e.g. a clone after split).
    layout.recordCanvasNavigation(panelId, initial);
  }, [panelId, pinnedGraphId]);
  // We use RF's internal store directly (not useUpdateNodeInternals) because
  // the public hook defers measurement to a requestAnimationFrame — by the
  // time it actually runs, our setRfEdges has already triggered a render
  // and EdgeWrapper has already logged the "couldn't find handle" warning.
  // We need the measurement to happen SYNCHRONOUSLY between setRfNodes and
  // setRfEdges, so the bounds are populated before EdgeWrapper looks them
  // up on its first render of the new edges.
  const rfStore = useStoreApi();
  const connect = useEditorStore((s) => s.connect);
  const removeNodesAndEdges = useEditorStore((s) => s.removeNodesAndEdges);
  const addSubgraphSocketWithEdge = useEditorStore((s) => s.addSubgraphSocketWithEdge);
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
  // Same ref pattern as AssetThumbnail: hold registry + evalCache in
  // refs so the eval effect doesn't re-fire when the registry rebuilds
  // for an UNRELATED subgraph edit. This canvas only re-evals when
  // ITS pinned panelGraph changes — which is exactly the right
  // invalidation key. (Without this, dragging a colour inside `oak-leaf`
  // re-ran every canvas's eval every drag tick → ~5fps.)
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const evalCacheRef = useRef(evalCache);
  evalCacheRef.current = evalCache;
  const imageLoadGen = useImageLoadGeneration();
  // Same role as the preview's animFrameGen — re-fires the canvas
  // eval each frame while playing so time-driven node thumbnails
  // (worley flicker, animated procedural noise) update live.
  // User-toggleable via View → Animate Node Previews. When off, the
  // hook still returns its frozen counter, but we omit it from the
  // dep list so the effect doesn't re-fire per frame. The Preview
  // pane animates regardless (separate eval path).
  const showLiveNodePreviews = useLayoutStore((s) => s.showLiveNodePreviews);
  const animFrameGen = useAnimFrameGeneration();
  const animFrameGenForDep = showLiveNodePreviews ? animFrameGen : 0;
  // Same affected-set fast-path the preview uses — skip fingerprint
  // collection for nodes outside the anim-reachable slice during
  // pure-animation re-evals.
  const { perGraphAffected } = useProjectAnimReachability();
  const subgraphsForRef = useEditorStore((s) => s.subgraphs);
  const canvasPureAnimRef = useRef({
    graph: panelGraph,
    subgraphs: subgraphsForRef,
    imageLoadGen,
  });
  const isCanvasPureAnimReeval =
    canvasPureAnimRef.current.graph === panelGraph &&
    canvasPureAnimRef.current.subgraphs === subgraphsForRef &&
    canvasPureAnimRef.current.imageLoadGen === imageLoadGen;
  canvasPureAnimRef.current = {
    graph: panelGraph,
    subgraphs: subgraphsForRef,
    imageLoadGen,
  };
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    beginCacheEval();
    void (async () => {
      const touched = new Set<string>();
      try {
        const currentAffected = isCanvasPureAnimReeval
          ? perGraphAffected.get(effectiveGraphId)
          : undefined;
        const result = await evaluateGraph(panelGraph, registryRef.current, {
          rootNodeId: panelRootNodeId,
          context: {
            device,
            animationTime: animationTime(),
            animationDelta: animationDelta(),
            // Forward so nested wrappers inherit the same fast-path.
            affectedByGraphId: perGraphAffected,
          },
          cache: evalCacheRef.current,
          touched,
          scope: 'all',
          ...(currentAffected ? { affectedSet: currentAffected } : {}),
        });
        if (cancelled) return;
        reportWorking(touched);
        // Publish per-node outputs to the canvas-data store. CustomNodes
        // subscribe per-node, so unchanged nodes (cache-hit, same output
        // reference) don't re-render — only the edited node does.
        setCanvasOutputs(panelId, result.allOutputs);
        // The eval may have mutated GPU textures in place (colorize,
        // worley, perlin, etc. all re-render into their previousOutput
        // texture). Tell every render-bus subscriber (PreviewTile,
        // ScenePreview, …) to repaint — without this, other consumers
        // that don't re-eval on this change (their `resolved`/`graph`
        // didn't change, so their effects don't fire under the ref-
        // pattern fix) would still show the pre-edit pixels.
        //
        // `force: true` bumps the bus's force-serial so per-tile dirty
        // checks redraw even when scene-ref/camera/size all match.
        // Without it, the dirty check would skip — the in-place texture
        // write is invisible to ref-equality.
        requestRender({ force: true });
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
    // registry + evalCache deliberately omitted; held via refs above.
    // `subgraphInputsKey` is intentionally a dep: an isolated-eval
    // canvas must re-run when the subgraph's input defaults change,
    // even though `panelGraph` (the inner graph) stays the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device, panelGraph, panelRootNodeId, reportWorking, subgraphInputsKey, imageLoadGen, animFrameGenForDep]);

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
  // Last structure synced to ReactFlow. Lets the sync effect below
  // short-circuit when only inputValues changed (the common case during
  // a slider/colour drag) — RF's node/handle/edge layout is unchanged,
  // so re-running setRfNodes/updateNodeInternals/setRfEdges would just
  // re-render every node for nothing.
  const lastStructRef = useRef<string | null>(null);
  const lastSyncRegistryRef = useRef<typeof seedRegistry | null>(null);

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
    // Did anything ReactFlow cares about (node set, handles, edges)
    // actually change? An inputValue-only edit leaves the structure
    // identical — skip the whole RF re-sync so we don't re-render every
    // node component each drag tick. Always refresh the refs so the
    // next real structural edit is detected.
    const structKey = graphStructureKey(panelGraph);
    const structUnchanged =
      structKey === lastStructRef.current && registry === lastSyncRegistryRef.current;
    lastStructRef.current = structKey;
    lastSyncRegistryRef.current = registry;

    const currentRfNodes = rfStore.getState().nodes;
    const newIds = new Set(panelGraph.nodes.map((n) => n.id));
    const hasOverlap = currentRfNodes.some((n) => newIds.has(n.id));
    const isSwap = currentRfNodes.length > 0 && !hasOverlap;

    if (!isSwap) {
      // Pure inputValue (or position) edit → RF layout unchanged. The
      // edited value reaches CustomNode via the canvas-data store, and
      // positions via the position-only effect, so there's nothing to
      // do here.
      if (structUnchanged) return;
      // Incremental case: same graph, edits applied to it. The naive
      // path of "setRfNodes → updateNodeInternals → setRfEdges in
      // one tick" looks like it should work because RF nodes already
      // exist in the DOM — but it fails when an existing node grows
      // a new handle (e.g. `addNodeExtraInputWithEdge` adds a new
      // socket and wires an edge to it atomically). React batches
      // the setRfNodes update, so updateNodeInternals runs against
      // the PRE-commit DOM where the new handle isn't rendered yet.
      // setRfEdges then hands RF an edge whose target handle has no
      // measurement → "Couldn't create edge for target handle id"
      // error 008. Route through the same two-phase pendingEdgeSync
      // dance the swap path uses: queue node update, let React
      // commit, then Effect 2 measures + sets edges. Old edges keep
      // rendering against still-valid nodes in the meantime.
      setRfNodes((current) => mergeRfNodes(current, panelGraph, panelPositions));
      setPendingEdgeSync({ panelGraph, registry });
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
      // Ignore when focus is in a TEXT-typed field — let the field have
      // its own undo/redo (so e.g. socket-rename inputs and the
      // command-palette have working text-undo). Non-text inputs
      // (color picker, range slider, checkbox) don't have a meaningful
      // browser undo, and they're commonly the LAST thing focused
      // after committing a graph edit — skipping them was eating
      // every undo after a colour-picker edit.
      const target = e.target as HTMLElement | null;
      if (target) {
        if (target.tagName === 'TEXTAREA' || target.isContentEditable) return;
        if (target.tagName === 'INPUT') {
          const t = (target as HTMLInputElement).type;
          // Text-like inputs have their own meaningful undo; bail out.
          // Everything else (color, range, checkbox, number-with-our-
          // own-scrub, …) just owns the focus visually — graph undo
          // should still work.
          if (t === 'text' || t === 'search' || t === 'url'
              || t === 'tel' || t === 'email' || t === 'password') {
            return;
          }
        }
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

  // `remove` changes are intentionally ignored here — ReactFlow fires
  // both `onEdgesChange(remove)` and `onNodesChange(remove)` separately
  // when the user deletes a node with connections. Catching them
  // independently produced two undo entries for what the user sees as
  // one operation. We let those changes flow through `onRfNodesChange`
  // / `onRfEdgesChange` for the visual update only and rely on the
  // single `onDelete` callback below to dispatch one batched store
  // command for the whole deletion.
  const onNodesChange = useCallback<OnNodesChange>(
    (changes) => { onRfNodesChange(changes); },
    [onRfNodesChange],
  );

  const onEdgesChange = useCallback<OnEdgesChange>(
    (changes) => { onRfEdgesChange(changes); },
    [onRfEdgesChange],
  );

  // Single dispatch for a delete operation — nodes + their connected
  // edges + any independently-selected edges all collapse into one
  // undo entry via the `batch` command. See `removeNodesAndEdges`.
  const onDelete = useCallback<OnDelete>(
    ({ nodes, edges }) => {
      const nodeIds = new Set<string>(nodes.map((n) => n.id));
      const edgeIds = new Set<string>(edges.map((e) => e.id));
      removeNodesAndEdges(nodeIds, edgeIds);
    },
    [removeNodesAndEdges],
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
        if (!fromNode) return;
        const fromDef = registry.get(fromNode.kind);
        const fromOut = findOutputOnNode(fromNode, fromDef, params.sourceHandle ?? '');
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

      const id = crypto.randomUUID();
      const color = edgeColor(graph, params.source, params.sourceHandle, registry);
      // Visual: when the target socket is multi-fan-in (declared
      // `multi: true` in the NodeDef OR on a per-instance extraInput),
      // KEEP every existing edge into it; otherwise drop the previous
      // edge so the store and RF state stay in sync after this onConnect.
      const targetNode = findNode(graph, params.target);
      const targetDef = targetNode ? registry.get(targetNode.kind) : undefined;
      const targetSocket = targetDef
        ? targetDef.inputs.find((i) => i.name === params.targetHandle)
          ?? targetNode?.extraInputs?.find((i) => i.name === params.targetHandle)
        : undefined;
      const targetIsMulti = targetSocket?.multi === true;
      setRfEdges((eds) => [
        ...(targetIsMulti
          ? eds
          : eds.filter((e) => !(e.target === params.target && e.targetHandle === params.targetHandle))),
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
    [connect, setRfEdges, registry, addSubgraphSocketWithEdge],
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
        return !!findOutputOnNode(fromNode, fromDef, sourceHandle);
      }
      if (sourceHandle === ADD_INPUT_HANDLE_ID) {
        const boundary = subgraphIdFromBoundaryKind(fromNode.kind);
        if (!boundary || boundary.side !== 'input') return false;
        return (
          !!toDef.inputs.find((i) => i.name === targetHandle) ||
          !!toNode.extraInputs?.find((i) => i.name === targetHandle)
        );
      }
      const fromOut = findOutputOnNode(fromNode, fromDef, sourceHandle);
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

  // Publish this canvas's graph to the per-node data store so CustomNodes
  // can subscribe to their own slice. setCanvasGraph rebuilds per-node
  // views, reusing the stable view object for any node whose data didn't
  // change — that's what keeps unchanged CustomNodes from re-rendering on
  // an edit elsewhere in the graph. Cleared on unmount.
  useEffect(() => {
    setCanvasGraph(panelId, panelGraph);
  }, [panelId, panelGraph]);
  useEffect(() => () => clearCanvasData(panelId), [panelId]);

  // Context carries the (stable) panelId — never changes for this
  // panel, so it triggers no re-renders — plus docsLocation, which
  // tells in-canvas [?] icons how to build URLs into the docs (the
  // editor lives at the site root). Per-node data flows through the
  // canvas-data store instead.
  const canvasPanelInfo = useMemo(
    () => ({ panelId, docsLocation: 'site-root' as const }),
    [panelId],
  );


  // Subscribe to the history shape so the corner buttons enable /
  // disable reactively. The selector returns a small object; useShallow
  // makes the comparison structural so identity-only changes
  // (set returning a new object with the same fields) don't re-render.
  // Both buttons render unconditionally — they sit in the Controls
  // strip whether or not history exists, and gray out via `disabled`
  // when there's nowhere to go. Always-present means the affordance is
  // discoverable from the moment the user opens a canvas.
  const { canGoBack, canGoForward } = useLayoutStore(
    useShallow((s) => {
      const h = s.canvasHistory[panelId];
      if (!h) return { canGoBack: false, canGoForward: false };
      return {
        canGoBack: h.cursor > 0,
        canGoForward: h.cursor < h.entries.length - 1,
      };
    }),
  );
  const onBackClick = useCallback(() => navigateCanvasBack(panelId), [panelId]);
  const onForwardClick = useCallback(() => navigateCanvasForward(panelId), [panelId]);

  // Right-click on the empty canvas OR on the multi-selection box
  // → context menu at the cursor. ReactFlow routes these to two
  // separate props:
  //   • onPaneContextMenu       — right-click on bare canvas.
  //   • onSelectionContextMenu  — right-click on the multi-select
  //                               box that RF draws around 2+
  //                               selected nodes. Without wiring
  //                               this, the browser's default menu
  //                               appears on multi-select right-
  //                               click and our menu never shows.
  // Single-node right-clicks land on CustomNode's own onContextMenu
  // (which is what handles Rename / Edit / Open Docs context). The
  // multi-select case intentionally omits those node-only items —
  // they'd be ambiguous with several nodes under the cursor.
  const [paneMenu, setPaneMenu] = useState<{ screenX: number; screenY: number; flowX: number; flowY: number } | null>(null);
  const [picker, setPicker] = useState<{ screenX: number; screenY: number; flowX: number; flowY: number } | null>(null);
  const onCanvasOrSelectionContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault();
      const flow = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setPaneMenu({
        screenX: event.clientX,
        screenY: event.clientY,
        flowX: flow.x,
        flowY: flow.y,
      });
    },
    [rf],
  );
  const onPaneContextMenu = onCanvasOrSelectionContextMenu;
  const onSelectionContextMenu = onCanvasOrSelectionContextMenu;
  // Right-click on an edge → context menu at cursor. First select
  // the edge (so the picker's splice-constraint filter and the
  // existing `addNodeAtFlowPosition` → `tryInsertOnSelectedEdge`
  // splice path both see it), then open the same menu the pane uses.
  // Deselecting nodes keeps the edge as the lone selection — without
  // this, a pre-existing selection from before the right-click would
  // confuse Cut/Copy/Extract which operate on selected nodes.
  const onEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: { id: string }) => {
      event.preventDefault();
      rf.setEdges((edges) =>
        edges.map((e) => {
          if (e.id === edge.id) return e.selected ? e : { ...e, selected: true };
          return e.selected ? { ...e, selected: false } : e;
        }),
      );
      rf.setNodes((nodes) => nodes.map((n) => (n.selected ? { ...n, selected: false } : n)));
      const flow = rf.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setPaneMenu({
        screenX: event.clientX,
        screenY: event.clientY,
        flowX: flow.x,
        flowY: flow.y,
      });
    },
    [rf],
  );
  const paneMenuItems = useMemo(() => {
    if (!paneMenu) return [];
    return buildCanvasMenuItems({
      flowX: paneMenu.flowX,
      flowY: paneMenu.flowY,
      openAddNodePicker: () => {
        setPicker({
          screenX: paneMenu.screenX,
          screenY: paneMenu.screenY,
          flowX: paneMenu.flowX,
          flowY: paneMenu.flowY,
        });
      },
    });
  }, [paneMenu]);

  // Subscribe to the picker bus so the per-node context menu (which
  // lives deep in the CustomNode tree, below this canvas) can ask US
  // to open the picker. Keyed by panelId so only the canvas that
  // owns the node receives the request.
  const pickerPending = usePickerBus((s) => s.pending);
  useEffect(() => {
    if (!pickerPending || pickerPending.canvasPanelId !== panelId) return;
    const req = usePickerBus.getState().consume(panelId);
    if (!req) return;
    setPicker({
      screenX: req.screenX,
      screenY: req.screenY,
      flowX: req.flowX,
      flowY: req.flowY,
    });
  }, [pickerPending, panelId]);

  return (
    <CanvasPanelContext.Provider value={canvasPanelInfo}>
      <div
        ref={wrapperRef}
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
          onDelete={onDelete}
          onMoveEnd={onMoveEnd}
          onNodeDragStop={onNodeDragStop}
          onSelectionDragStop={onSelectionDragStop}
          onPaneContextMenu={onPaneContextMenu}
          onSelectionContextMenu={onSelectionContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
          proOptions={{ hideAttribution: true }}
          selectionMode={SelectionMode.Partial}
          minZoom={0.1}
          colorMode="dark"
        >
          <Background />
          {/* Back / Forward live inside ReactFlow's Controls strip so
              they share the canvas mini-toolbar with zoom / fit. The
              top-left corner is already owned by Add Node. Both
              buttons mount as a pair whenever this canvas has any
              navigation history; ControlButton's `disabled` styling
              tracks the cursor position. */}
          <Controls>
            {/* Back + Forward sharing one row of the Controls strip,
                half-width each. Saves vertical space and keeps the
                two-arrow gesture readable as a single nav control.
                Both always render, greyed out via `disabled` when
                history can't move that way. Inline SVG (rather than
                ← / → glyphs) so the icon scales to whatever cell
                width the flex split produces — Unicode arrows have
                intrinsic glyph width that fought the 50/50 layout. */}
            <div className="sedon-canvas-nav-row">
              <ControlButton
                title="Back (⌘[)"
                disabled={!canGoBack}
                onClick={onBackClick}
              >
                <ChevronIcon direction="left" />
              </ControlButton>
              <ControlButton
                title="Forward (⌘])"
                disabled={!canGoForward}
                onClick={onForwardClick}
              >
                <ChevronIcon direction="right" />
              </ControlButton>
            </div>
          </Controls>
        </ReactFlow>
        {paneMenu && (
          <CanvasContextMenu
            x={paneMenu.screenX}
            y={paneMenu.screenY}
            items={paneMenuItems}
            onClose={() => setPaneMenu(null)}
          />
        )}
        {picker && (
          <AddNodePicker
            anchorX={picker.screenX}
            anchorY={picker.screenY}
            flowX={picker.flowX}
            flowY={picker.flowY}
            onClose={() => setPicker(null)}
          />
        )}
      </div>
    </CanvasPanelContext.Provider>
  );
}

// Chevron used by the Back / Forward buttons. `currentColor` lets
// ReactFlow's Controls strip style it (including the dimmed look on
// disabled). 24-unit viewBox gives the stroke room without clipping
// at the small widths the flex split produces.
function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  const d = direction === 'left' ? 'M15 6 L9 12 L15 18' : 'M9 6 L15 12 L9 18';
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

// Reconcile React Flow's current node list against the graph's nodes,
// preserving position/dimensions/selection for nodes that survive while
// adding new nodes (from undo/redo restore or load) at their saved position.
// Structural signature of a graph for the RF-sync effect: what
// ReactFlow actually cares about — the node set, each node's kind +
// variadic socket names (handles), and the edge list. Deliberately
// EXCLUDES inputValues and positions. So an inputValue-only edit (drag
// a colour/uniform) yields the same key, letting the sync effect skip
// the expensive setRfNodes / updateNodeInternals / setRfEdges churn
// that otherwise re-renders every node component each tick. Positions
// are handled by the separate position-only effect; inputValue data
// flows through the canvas-data store, not RF.
function graphStructureKey(graph: Graph): string {
  let s = '';
  for (const n of graph.nodes) {
    s += n.id + ':' + n.kind;
    if (n.extraInputs) for (const e of n.extraInputs) s += ',' + e.name;
    s += ';';
  }
  s += '|';
  for (const e of graph.edges) {
    s += e.from.node + '/' + e.from.socket + '>' + e.to.node + '/' + e.to.socket + ';';
  }
  return s;
}

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
