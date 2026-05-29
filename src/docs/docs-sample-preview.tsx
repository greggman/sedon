import {
  Background,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { evaluateGraph } from '../core/evaluate.js';
import type { NodeOutputs } from '../core/node-def.js';
import type {
  GeometryValue,
  HeightfieldValue,
  MaterialValue,
  PathValue,
  SceneValue,
  Texture2DValue,
} from '../core/resources.js';
import { layoutGraph, type NodeMeasurement } from '../editor/auto-layout.js';
import { CanvasPanelContext } from '../editor/canvas-panel-context.js';
import { clearCanvasData, setCanvasGraph, setCanvasOutputs } from '../editor/canvas-data.js';
import { CustomNode } from '../editor/custom-node.js';
import { MeshPreview } from '../editor/mesh-preview.js';
import { PathPreview } from '../editor/path-preview.js';
import { graphToRfEdges, graphToRfNodes } from '../editor/rf-conversion.js';
import { ScenePreview } from '../editor/scene-preview.js';
import { useEditorStore, type CameraState } from '../editor/store.js';
import { TexturePreview } from '../editor/texture-preview.js';
import { createCoreNodeRegistry } from '../nodes/index.js';
import { acquireGpuDevice } from '../render/device.js';

// Embedded sample graph + live preview for the per-node docs pages.
// Side-by-side: the authored sample graph on the left (a real React
// Flow canvas rendering the editor's CustomNode), the evaluated
// rootNodeId output on the right.
//
// Mounts on top of the same useEditorStore the editor uses, so dragging
// a slider inside a CustomNode goes through setInputValue → store
// dispatch → routeBack → mainGraph update — exactly like the editor.
// The store is pre-seeded by `main.tsx` so `currentEditingId='main'`
// and `mainGraph` is the sample graph before first paint; this
// component is just the renderer + the re-eval-on-graph-change loop.
//
// Auto-layout runs once on mount, after React Flow has measured the
// nodes' rendered dimensions — the layoutGraph crossing-minimiser needs
// real widths/heights to produce a sensible result. After positions
// land we call fitView so the graph frames itself in the panel.
//
// v1 preview support: Texture2D (covers perlin, blend, every other
// noise / filter output). Material / Scene / Heightfield fall back to
// a "no preview available" message — their standalone preview
// components exist and can land in a follow-up.

interface DocsSamplePreviewProps {
  // sampleGraph is supplied for API symmetry but the actual graph the
  // canvas renders comes from the editor store (seeded by main.tsx).
  // Keep the prop so the typed shape conveys "this component needs a
  // sample graph to function" at the call site.
  sampleGraph: { graph: import('../core/graph.js').Graph; rootNodeId: string };
}

const DOCS_PANEL_ID = 'docs-sample';
const nodeTypes = { sedon: CustomNode };

// Default scene-preview camera. ScenePreview auto-frames distance +
// target against the scene's AABB on every render, so only yaw/pitch
// actually matter here — pick angles that show three quarters of a
// rotation so spheres / cubes / terrain read as 3D rather than flat.
const DEFAULT_DOC_CAMERA: CameraState = {
  yaw: 0.6,
  pitch: 0.35,
  distance: 3,
  target: [0, 0, 0],
};

function isTexture2D(v: unknown): v is Texture2DValue {
  return typeof v === 'object' && v !== null && 'texture' in v && 'format' in v;
}
function isHeightfield(v: unknown): v is HeightfieldValue {
  return (
    typeof v === 'object' && v !== null && 'texture' in v && 'worldSize' in v && 'heightRange' in v
  );
}
function isMaterial(v: unknown): v is MaterialValue {
  return typeof v === 'object' && v !== null && 'kind' in v;
}
function isScene(v: unknown): v is SceneValue {
  return typeof v === 'object' && v !== null && Array.isArray((v as { entities?: unknown }).entities);
}
function isGeometry(v: unknown): v is GeometryValue {
  // GeometryValue carries GPU buffers + indexCount/indexFormat. The
  // `positionBuffer` field is what uniquely identifies it vs. the other
  // value kinds (no other value has a positionBuffer).
  return typeof v === 'object' && v !== null && 'positionBuffer' in v && 'indexCount' in v;
}
function isPath(v: unknown): v is PathValue {
  return typeof v === 'object' && v !== null && 'samples' in v && 'count' in v && 'width' in v;
}

type PreviewTarget =
  | { kind: 'texture'; value: Texture2DValue }
  | { kind: 'material'; value: MaterialValue }
  | { kind: 'scene'; value: SceneValue }
  | { kind: 'geometry'; value: GeometryValue }
  | { kind: 'path'; value: PathValue }
  | { kind: 'none' };

function previewTargetFor(outputs: NodeOutputs | undefined): PreviewTarget {
  if (!outputs) return { kind: 'none' };
  for (const v of Object.values(outputs)) {
    if (isHeightfield(v)) return { kind: 'texture', value: v.texture };
    if (isTexture2D(v)) return { kind: 'texture', value: v };
    if (isGeometry(v)) return { kind: 'geometry', value: v };
    if (isPath(v)) return { kind: 'path', value: v };
    if (isMaterial(v)) return { kind: 'material', value: v };
    if (isScene(v)) return { kind: 'scene', value: v };
  }
  return { kind: 'none' };
}

export function DocsSamplePreview(props: DocsSamplePreviewProps) {
  return (
    <ReactFlowProvider>
      <DocsSamplePreviewInner {...props} />
    </ReactFlowProvider>
  );
}

function DocsSamplePreviewInner(_props: DocsSamplePreviewProps) {
  const rf = useReactFlow();
  const [device, setDevice] = useState<GPUDevice | null>(null);
  const [rootOutputs, setRootOutputs] = useState<NodeOutputs | null>(null);
  const [error, setError] = useState<string | null>(null);

  const registry = useMemo(() => createCoreNodeRegistry(), []);

  // Live graph + root from the editor store. setInputValue (called by
  // CustomNode value editors) mutates this; every change re-fires the
  // eval effect below so the preview tracks the slider.
  const liveGraph = useEditorStore((s) => s.graph);
  const liveRootNodeId = useEditorStore((s) => s.rootNodeId);
  const positions = useEditorStore((s) => s.nodePositions.main);

  // Acquire the GPU device once. CustomNode reads `device` off the
  // editor store for its in-node previews, so set it there too.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const gpu = await acquireGpuDevice();
        if (cancelled) return;
        useEditorStore.setState({ device: gpu.device });
        setDevice(gpu.device);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Publish the live graph to the per-panel canvas-data store so
  // CustomNode (subscribed per-node via useCanvasNode) sees its data.
  useEffect(() => {
    setCanvasGraph(DOCS_PANEL_ID, liveGraph);
  }, [liveGraph]);
  useEffect(() => () => clearCanvasData(DOCS_PANEL_ID), []);

  // Re-evaluate on graph or device change. Output goes back into
  // canvas-data so every in-node preview tile in the embedded canvas
  // updates, and into local state so the side preview updates too.
  // Eval errors surface to `error` rather than getting swallowed —
  // otherwise a sample graph with a wiring mistake (e.g. forgetting
  // to feed a material's basecolor) leaves the preview pane stuck on
  // "Evaluating…" forever with the only signal being a console warn.
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await evaluateGraph(liveGraph, registry, {
          rootNodeId: liveRootNodeId,
          context: { device },
          scope: 'all',
        });
        if (cancelled) return;
        setCanvasOutputs(DOCS_PANEL_ID, result.allOutputs);
        const root = result.allOutputs.get(liveRootNodeId) ?? null;
        setRootOutputs(root);
        if (root) {
          setError(null);
        } else {
          // Eval completed but the root produced nothing — most likely
          // a required input was unwired and the evaluator skipped it.
          setError(`root node \`${liveRootNodeId}\` produced no output (a required input is probably unwired)`);
        }
      } catch (e) {
        if (!cancelled) {
          console.warn('docs sample eval failed', e);
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [device, liveGraph, liveRootNodeId, registry]);

  // RF nodes/edges. Generated from the live graph so a setInputValue
  // mutation triggers re-render here too (the rf node `data.kind` is
  // unchanged but the parent graph identity changes; the CustomNode
  // already subscribes per-node to canvas-data for its actual data).
  const rfNodes = useMemo<Node[]>(
    () => graphToRfNodes(liveGraph, positions),
    [liveGraph, positions],
  );
  const rfEdges = useMemo<Edge[]>(
    () => graphToRfEdges(liveGraph, registry),
    [liveGraph, registry],
  );
  const [nodes, setNodes, onNodesChange] = useNodesState(rfNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(rfEdges);
  useEffect(() => { setNodes(rfNodes); }, [rfNodes, setNodes]);
  useEffect(() => { setEdges(rfEdges); }, [rfEdges, setEdges]);

  // Auto-layout: run ONCE after React Flow has measured every node's
  // rendered dimensions. layoutGraph needs widths/heights for its
  // crossing-minimiser to do anything useful. We retry on rAF until
  // measurements show up — once we have them, compute positions and
  // persist them through the editor store's nodePositions map so
  // graphToRfNodes finds them on subsequent renders.
  //
  // Visibility: until the layout + fitView have committed, the canvas
  // is hidden behind a `layoutReady=false` opacity gate. ReactFlow
  // still has to render the nodes (so we can measure them), but the
  // user only ever sees the final composition. Without this gate the
  // page lands with the nodes at their authored / default positions
  // and the viewport at zoom 1, then animates to the framed view — a
  // visible "settle" we don't want.
  const layoutAppliedRef = useRef(false);
  const [layoutReady, setLayoutReady] = useState(false);
  const tryAutoLayout = useCallback(() => {
    if (layoutAppliedRef.current) return true;
    const rfNodesNow = rf.getNodes();
    if (rfNodesNow.length === 0) return false;
    const allMeasured = rfNodesNow.every(
      (n) => n.measured?.width !== undefined && n.measured?.height !== undefined,
    );
    if (!allMeasured) return false;
    const measured = new Map<string, NodeMeasurement | undefined>();
    for (const n of rfNodesNow) {
      const m = n.measured;
      if (!m) {
        measured.set(n.id, undefined);
        continue;
      }
      const entry: NodeMeasurement = {};
      if (m.width !== undefined) entry.width = m.width;
      if (m.height !== undefined) entry.height = m.height;
      measured.set(n.id, entry);
    }
    const newPositions = layoutGraph(liveGraph, measured, registry);
    const posMap: Record<string, { x: number; y: number }> = {};
    for (const [id, p] of newPositions) posMap[id] = p;
    // Persist through the store so graphToRfNodes uses these positions
    // on every subsequent regeneration (setInputValue rebuilds rfNodes
    // from the new graph reference).
    useEditorStore.setState((s) => ({
      nodePositions: { ...s.nodePositions, main: posMap },
    }));
    layoutAppliedRef.current = true;
    // Wait one frame so RF commits the new positions, then snap the
    // viewport with no animation and reveal the canvas. `duration: 0`
    // is the key knob — anything > 0 produces the visible zoom tween
    // the user noticed.
    requestAnimationFrame(() => {
      rf.fitView({ padding: 0.15, duration: 0 });
      // Reveal AFTER the fitView so the very first frame the user
      // sees is the final, framed composition.
      requestAnimationFrame(() => setLayoutReady(true));
    });
    return true;
  }, [rf, liveGraph, registry]);

  useEffect(() => {
    if (layoutAppliedRef.current) return;
    let frame = 0;
    function attempt() {
      if (tryAutoLayout()) return;
      frame = requestAnimationFrame(attempt);
    }
    frame = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(frame);
  }, [tryAutoLayout]);

  // Persist drag positions back into the store. Without this, the next
  // setInputValue-triggered re-render of rfNodes (graphToRfNodes uses
  // `nodePositions.main` as the position source) would snap the node
  // back to its post-auto-layout position — the user moves it, scrubs a
  // slider, the node teleports. By writing the drag-end position into
  // the same store map, the regenerated rfNodes pick up the new spot
  // and the node stays put.
  const onNodeDragStop = useCallback((_e: React.MouseEvent, node: Node) => {
    useEditorStore.setState((s) => ({
      nodePositions: {
        ...s.nodePositions,
        main: {
          ...s.nodePositions.main,
          [node.id]: { x: node.position.x, y: node.position.y },
        },
      },
    }));
  }, []);

  const previewTarget = useMemo(() => previewTargetFor(rootOutputs ?? undefined), [rootOutputs]);

  return (
    <div className="sedon-doc-sample">
      <div
        className="sedon-doc-sample-graph"
        // ReactFlow needs to render the nodes so we can measure them
        // before the auto-layout can compute final positions. Until
        // that's done and fitView has snapped to the final viewport,
        // we keep the canvas at opacity 0 so the user never sees the
        // pre-layout intermediate state. The transition gives a soft
        // reveal once everything's settled.
        style={{
          opacity: layoutReady ? 1 : 0,
          transition: 'opacity 0.15s ease-out',
        }}
      >
        <CanvasPanelContext.Provider value={{ panelId: DOCS_PANEL_ID }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStop={onNodeDragStop}
            // Match the editor canvas: default RF interactivity (so the
            // in-node value editors receive their pointer events the
            // same way they do in the editor), `minZoom: 0.1` so users
            // can zoom out far enough to frame larger sample graphs,
            // panOnDrag + zoomOnScroll for navigation, no connection
            // affordance because adding edges to a docs example would
            // be a strange thing to do.
            nodesConnectable={false}
            panOnDrag
            zoomOnScroll
            minZoom={0.1}
            colorMode="dark"
            proOptions={{ hideAttribution: true }}
          >
            <Background />
          </ReactFlow>
        </CanvasPanelContext.Provider>
      </div>

      <div className="sedon-doc-sample-result">
        <div className="sedon-doc-sample-result-label">Preview</div>
        <div className="sedon-doc-sample-result-body">
          {error ? (
            <div className="sedon-doc-sample-error">Preview unavailable: {error}</div>
          ) : !device || !rootOutputs ? (
            <div className="sedon-doc-muted">Evaluating…</div>
          ) : previewTarget.kind === 'texture' ? (
            <TexturePreview device={device} value={previewTarget.value} size={280} />
          ) : previewTarget.kind === 'geometry' ? (
            previewTarget.value.mesh ? (
              <MeshPreview
                device={device}
                geometry={previewTarget.value}
                interactive
              />
            ) : (
              <div className="sedon-doc-muted">
                No preview: GPU-only mesh. The source node didn't materialise CPU
                vertex data (e.g. <code>cpu_access: false</code> on
                heightfield-to-mesh) so the wireframe expander has nothing to read.
              </div>
            )
          ) : previewTarget.kind === 'path' ? (
            <PathPreview path={previewTarget.value} size={280} />
          ) : previewTarget.kind === 'scene' ? (
            <ScenePreview
              device={device}
              scene={previewTarget.value}
              camera={DEFAULT_DOC_CAMERA}
              interactive
            />
          ) : (
            <div className="sedon-doc-muted">
              No preview available for output kind <code>{previewTarget.kind}</code>.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
