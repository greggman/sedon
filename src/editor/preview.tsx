import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Graph } from '../core/graph.js';
import { evaluateGraph } from '../core/evaluate.js';
import { defaultLighting, type LightingValue } from '../core/resources.js';
import { acquireGpuDevice, type GpuDevice } from '../render/device.js';
import { multiply, rotationX, rotationY, translation } from '../render/mat4.js';
import { beginCacheEval, endCacheEval, useCacheConsumer } from './cache-coordinator.js';
import { useLayoutStore } from './layout-store.js';
import { openGraphInCanvas } from './open-graph.js';
import { PreviewTile } from './preview-tile.js';
import { synthesizeTiles, type PreviewTileSpec } from './preview-synth.js';
import { useRegistry } from './registry.js';
import { isAnimating, requestRender, setAnimating, subscribeAnimating } from './render-bus.js';
import { useEditorStore, type CameraState } from './store.js';

// Play/pause for time-driven effects (grass wind). Off by default so
// idle previews stay render-on-demand; turning it on starts the
// render-bus's continuous rAF loop and advances the animation clock.
// Global (not per-pane): one clock drives every preview canvas.
function AnimateToggle() {
  const [playing, setPlaying] = useState(isAnimating());
  useEffect(() => subscribeAnimating(setPlaying), []);
  return (
    <button
      type="button"
      className="sedon-toolbar-button sedon-animate-toggle"
      title={playing ? 'Pause animation (wind)' : 'Play animation (wind)'}
      onClick={() => setAnimating(!playing)}
    >
      {playing ? '⏸ Pause' : '▶ Play'}
    </button>
  );
}

// Camera math: orbit around `target` at `distance`, oriented by yaw/pitch.
// Drag rotates yaw/pitch. Cmd/Ctrl-drag pans target along the camera's
// local right/up. Scroll zooms (changes distance).
//
// WASD/QE keyboard nav (when preview pane has focus): W/S walk
// forward/back along camera-forward projected to the XZ plane, A/D
// strafe along camera-right (already horizontal — yaw-only basis has
// no Y). Q/E move the target on world up/down. Shift multiplies speed.
//
// All input handlers live on the wrapper div, not on individual tile
// canvases, so events route the same way regardless of which tile the
// pointer happens to be over. Shared camera ref means every tile renders
// the same viewpoint.
type OrbitCamera = CameraState;

const MOVEMENT_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);
// 'f' is a one-shot Frame Selected: not held, not a movement key, but
// it still needs to live in HANDLED_KEYS so the wrapper's keydown
// handler swallows it (matches Blender/Maya/Unity expectation).
const HANDLED_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'shift', 'f']);

const DEFAULT_CAMERA: OrbitCamera = {
  yaw: 0,
  pitch: 0.4,
  distance: 3,
  target: [0, 0, 0],
};

function cloneCamera(c: OrbitCamera): OrbitCamera {
  return {
    yaw: c.yaw,
    pitch: c.pitch,
    distance: c.distance,
    target: [c.target[0], c.target[1], c.target[2]],
  };
}

interface PreviewProps {
  /**
   * DockView panel id. When set, the Preview reads its "pinned graph"
   * from the layout store via this id, letting different Preview tabs
   * watch different graphs (e.g. forest while editing leaf). Unset
   * means "follow active editing context" — the legacy single-pane
   * behavior.
   */
  panelId?: string;
}

export function Preview({ panelId }: PreviewProps = {}) {
  // Two refs because we attach the keyboard/focus listeners to the
  // pane wrapper (it's the focus target for WASD nav) but the
  // pointer/wheel listeners to the inner canvas grid. The header
  // chrome (Play/Pause button, pin dropdown) is a sibling of the
  // grid — putting pointer listeners on the wrapper would catch
  // pointerdown events that bubbled from those buttons and then
  // setPointerCapture would steal the pointerup, so the buttons'
  // own click handlers would never fire.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [gpu, setGpu] = useState<GpuDevice | null>(null);

  const cameraRef = useRef<OrbitCamera>(cloneCamera(DEFAULT_CAMERA));
  const keysRef = useRef<Set<string>>(new Set());
  // Tiles register their canvas + renderer here when they mount, and
  // deregister on unmount. The F-key handler walks this to find the
  // tile under the cursor and runs pickAt against THAT tile's renderer.
  const tilesRef = useRef<Map<string, { canvas: HTMLCanvasElement; renderer: import('../render/scene.js').SceneRenderer }>>(new Map());
  // Last cursor position (clientX/Y, in CSS px). Updated on pointermove
  // even outside drag so F-on-hover knows where to pick.
  const lastCursorRef = useRef<{ clientX: number; clientY: number } | null>(null);
  // PreviewTile takes `onTileReady` as a dependency — a fresh callback
  // every Preview render would force it to tear down + rebuild the
  // SceneRenderer (and its batches) on every state change, which makes
  // pickAt see an empty `batches` array more often than not. Cache one
  // STABLE registrar per tile name so the dep is referentially stable
  // for the tile's whole lifetime.
  const tileRegistrarsRef = useRef<Map<string, (info: { canvas: HTMLCanvasElement; renderer: import('../render/scene.js').SceneRenderer } | null) => void>>(new Map());
  const tileRegistrarFor = useCallback((name: string) => {
    const cache = tileRegistrarsRef.current;
    const existing = cache.get(name);
    if (existing) return existing;
    const fn = (info: { canvas: HTMLCanvasElement; renderer: import('../render/scene.js').SceneRenderer } | null) => {
      const tilesMap = tilesRef.current;
      if (info) {
        tilesMap.set(name, info);
        // Push the active selection to the freshly-mounted tile too,
        // so swapping panels / re-creating renderers doesn't lose the
        // outline.
        if (selectionRef.current) info.renderer.setSelection(selectionRef.current);
      }
      else tilesMap.delete(name);
    };
    cache.set(name, fn);
    return fn;
  }, []);

  // Right-click pick menu — populated with the chain from a pickAt at the
  // click position, then rendered as an absolute-positioned div.
  // `null` = closed; non-null = open at (x, y). Items are pre-resolved
  // closures so the menu rendering doesn't need to hold renderer refs
  // (the menu may outlive the user's hover-over-a-tile state).
  interface ContextMenuItem {
    label: string;
    /** Visually-emphasised default (the same target the F key uses). */
    primary?: boolean;
    action: () => void;
  }
  interface ContextMenuState {
    x: number;
    y: number;
    items: ContextMenuItem[];
  }
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Current selection (rendered as an outline by SceneRenderer). F-key
  // and right-click Frame items set this; Escape and Frame-Scene clear
  // it. Selection lives on a ref so we can push it to newly-mounting
  // tiles too (they register via onTileReady AFTER first render).
  const selectionRef = useRef<import('../render/scene.js').SceneSelection | null>(null);
  function applySelection(sel: import('../render/scene.js').SceneSelection | null): void {
    selectionRef.current = sel;
    for (const tile of tilesRef.current.values()) {
      tile.renderer.setSelection(sel);
    }
    requestRender();
  }
  // Click-outside dismissal: any mousedown that isn't on the menu itself
  // (the menu calls e.stopPropagation() on its own mousedown) closes us.
  // Skipped entirely when the menu isn't open, so we don't pay for an
  // always-on global listener.
  useEffect(() => {
    if (!contextMenu) return;
    const onDown = () => setContextMenu(null);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [contextMenu]);
  // Kicked by keydown to start the WASD motion rAF when it isn't already
  // running. Filled in by the motion-loop effect below; default no-op so
  // pre-mount keydown is a no-op rather than a crash.
  const motionStartRef = useRef<() => void>(() => {});

  // Mirror `effectiveGraphId` into a ref so input handlers (mounted once)
  // always read the current value without us tearing down + re-binding
  // listeners on every pin change.
  const effectiveGraphIdRef = useRef<string>('main');

  // Commit this panel's camera. Per-panel × per-graph state lives in
  // the layout store so two Preview panes on the same graph don't echo
  // each other through the project-shared cameras map. Without a
  // panelId (legacy single-pane caller) we fall back to the project
  // map so the camera still persists across sessions.
  const commitCamera = useCallback(
    (graphId: string, cam: OrbitCamera) => {
      const snapshot = cloneCamera(cam);
      if (panelId) {
        useLayoutStore.getState().savePreviewCamera(panelId, graphId, snapshot);
      } else {
        useEditorStore.getState().saveCameraFor(graphId, snapshot);
      }
    },
    [panelId],
  );

  // Resolve which graph this Preview is showing. Unpinned panels follow
  // `currentEditingId` (legacy behavior); pinned ones lock to a specific
  // graph independently. The eval below runs against THIS graph, not
  // necessarily the one the user is currently editing.
  const pinnedGraphId = useLayoutStore((s) =>
    panelId ? s.pinnedGraphIds[panelId] : undefined,
  );
  const currentEditingId = useEditorStore((s) => s.currentEditingId);
  const effectiveGraphId = pinnedGraphId ?? currentEditingId;

  const activeGraph = useEditorStore((s) => s.graph);
  const activeRootNodeId = useEditorStore((s) => s.rootNodeId);
  const mainGraph = useEditorStore((s) => s.mainGraph);
  const mainRootNodeId = useEditorStore((s) => s.mainRootNodeId);
  const subgraphs = useEditorStore((s) => s.subgraphs);
  const setDevice = useEditorStore((s) => s.setDevice);
  const evalCache = useEditorStore((s) => s.evalCache);
  // This Preview is one consumer of the shared eval cache. Reporting
  // our `touched` set after each eval lets the coordinator union it
  // with every OTHER consumer's set (other Previews, asset thumbnails)
  // and sweep only entries nobody is using — avoiding the
  // "Buffer used in submit while destroyed" we hit when each pane
  // swept independently.
  const reportWorking = useCacheConsumer();
  const registry = useRegistry();

  // Auto-pin each Preview to whatever graph it first shows. Without
  // this, an unpinned Preview falls back to `currentEditingId`, so the
  // moment something else flips that global (e.g. asset-view "Open in
  // Canvas" → setActiveEditing) every unpinned Preview swaps too.
  // Pinning captures the user's intent: this pane shows X until they
  // explicitly retarget it.
  //
  // We depend on `pinnedGraphId` (not just panelId) so this also re-pins
  // after `resetForNewProject` clears all pins on a demo/project load —
  // otherwise the pane is left unpinned and silently follows
  // currentEditingId again.
  useEffect(() => {
    if (!panelId) return;
    if (pinnedGraphId === undefined) {
      const initial = useEditorStore.getState().currentEditingId;
      useLayoutStore.getState().setPanelPinnedGraph(panelId, initial);
    }
  }, [panelId, pinnedGraphId]);

  // The (graph, rootNodeId) pair the eval runs against. For pinned
  // previews this is a non-active subgraph (or main); the eval still
  // shares the global cache so any nodes both views reference get
  // computed once. For "Active" panels we deliberately read the
  // already-resolved store fields so we don't re-derive what the store
  // already tracks.
  const { graph, rootNodeId } = useMemo(() => {
    if (effectiveGraphId === currentEditingId) {
      return { graph: activeGraph, rootNodeId: activeRootNodeId };
    }
    if (effectiveGraphId === 'main') {
      return { graph: mainGraph, rootNodeId: mainRootNodeId };
    }
    const sg = subgraphs.find((s) => s.id === effectiveGraphId);
    if (!sg) {
      // Pinned graph went away (deleted subgraph) — fall back to active.
      return { graph: activeGraph, rootNodeId: activeRootNodeId };
    }
    // Same root-resolution rule as setActiveEditing: prefer a
    // user-authored core/output for standalone preview, else the
    // boundary output.
    const previewOutput = sg.graph.nodes.find((n) => n.kind === 'core/output');
    const rootId = previewOutput?.id ?? sg.outputNodeId;
    return { graph: sg.graph as Graph, rootNodeId: rootId };
  }, [
    effectiveGraphId,
    currentEditingId,
    activeGraph,
    activeRootNodeId,
    mainGraph,
    mainRootNodeId,
    subgraphs,
  ]);

  const [tiles, setTiles] = useState<PreviewTileSpec[]>([]);

  // Acquire the (shared) GPU device. `acquireGpuDevice` is memoized,
  // so opening a second Preview hits the same device the first one
  // already published to the store — no second adapter, no orphaned
  // pipelines. The local `gpu` state still exists because PreviewTile
  // needs both `device` and `format` (the store only carries device).
  //
  // We deliberately don't clear `device` from the store on unmount:
  // other consumers (asset thumbnails, in-node thumbnails) keep using
  // the device after a Preview pane closes, and the device itself
  // lives for the app's lifetime.
  useEffect(() => {
    let cancelled = false;
    acquireGpuDevice()
      .then((g) => {
        if (cancelled) return;
        setGpu(g);
        setDevice(g.device);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(e);
        setError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [setDevice]);

  // Wrapper-level input. Every drag/wheel/key event lands here regardless
  // of which tile the pointer is over, so we don't duplicate handlers per
  // tile. The wrapper itself is the focus target for keyboard input —
  // pointerdown explicitly focuses it so WASD works after a click.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    const grid = gridRef.current;
    if (!wrapper || !grid) return;

    // Active pointers, keyed by pointerId. One entry → rotate/pan drag;
    // two → pinch-to-dolly (touch screens). Tracking by id (instead of a
    // single dragging bool) is what lets two-finger gestures work without
    // the second touch being treated as a new click.
    const pointers = new Map<number, { x: number; y: number }>();
    let mode: 'idle' | 'drag' | 'pinch' = 'idle';
    let panning = false;       // ctrl/meta-modified drag (single-pointer)
    let pinchDist = 0;          // last frame's finger separation (pixels)
    // Click-vs-drag discrimination: pointerdown captures the start
    // position; pointermove past `CLICK_SLOP_PX` knocks `couldBeClick`
    // false. If pointerup arrives still-clicky, we run a click-to-
    // select (no framing) at the original pointerdown position.
    const CLICK_SLOP_PX = 4;
    let couldBeClick = false;
    let clickStartX = 0;
    let clickStartY = 0;

    const fingerDistance = (): number => {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return 0;
      const dx = a.x - b.x, dy = a.y - b.y;
      return Math.hypot(dx, dy);
    };

    const onPointerDown = (e: PointerEvent) => {
      // Touch pointers report button=-1; pen/mouse use 0 for primary. We
      // accept both — touch wouldn't pinch otherwise.
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      wrapper.focus();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { grid.setPointerCapture(e.pointerId); } catch { /* ignore */ }

      if (pointers.size === 1) {
        mode = 'drag';
        panning = e.metaKey || e.ctrlKey;
        // Single-pointer down WITHOUT a modifier could be the start of
        // a click-to-select. A subsequent pointermove past the slop
        // threshold cancels it; pointerup before then runs the select.
        couldBeClick = !panning;
        clickStartX = e.clientX;
        clickStartY = e.clientY;
      } else if (pointers.size === 2) {
        // Second finger arrived — enter pinch. Seed the running distance
        // from the current finger separation so the first move tick
        // doesn't snap.
        mode = 'pinch';
        panning = false;
        pinchDist = fingerDistance();
        couldBeClick = false;
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      // Track latest cursor pos for the F-key Frame Selected — fires
      // for hover and drag alike, regardless of whether the pointer
      // is captured. The drag/pinch logic below only acts on captured
      // pointers (`prev` lookup).
      lastCursorRef.current = { clientX: e.clientX, clientY: e.clientY };
      // Cancel click candidacy once the cursor moves past the slop —
      // user is dragging the camera, not clicking to select.
      if (couldBeClick) {
        const ddx = e.clientX - clickStartX;
        const ddy = e.clientY - clickStartY;
        if (ddx * ddx + ddy * ddy > CLICK_SLOP_PX * CLICK_SLOP_PX) couldBeClick = false;
      }
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const cam = cameraRef.current;

      if (mode === 'pinch') {
        // Update this finger, then dolly by the ratio of new/prev finger
        // separation. Same exponential feel as the wheel handler so a
        // pinch and a scroll behave the same way.
        prev.x = e.clientX; prev.y = e.clientY;
        const dist = fingerDistance();
        if (pinchDist > 0 && dist > 0) {
          const ratio = dist / pinchDist;
          cam.distance = Math.max(0.5, Math.min(250, cam.distance / ratio));
        }
        pinchDist = dist;
        requestRender();
        return;
      }
      if (mode !== 'drag') return;

      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      prev.x = e.clientX; prev.y = e.clientY;
      if (panning) {
        // Rows of the rotation matrix are the camera basis in world
        // space (R⁻¹ = Rᵀ for an orthonormal rotation).
        const r = multiply(rotationX(cam.pitch), rotationY(cam.yaw));
        const rightX = r[0]!, rightY = r[4]!, rightZ = r[8]!;
        const upX = r[1]!, upY = r[5]!, upZ = r[9]!;
        const panSens = 0.0025 * cam.distance;
        const px = -dx * panSens;
        const py = dy * panSens;
        cam.target[0] += rightX * px + upX * py;
        cam.target[1] += rightY * px + upY * py;
        cam.target[2] += rightZ * px + upZ * py;
      } else {
        const sens = 0.005;
        cam.yaw += dx * sens;
        cam.pitch = Math.max(
          -Math.PI / 2 + 0.01,
          Math.min(Math.PI / 2 - 0.01, cam.pitch + dy * sens),
        );
      }
      requestRender();
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      try { grid.releasePointerCapture(e.pointerId); } catch { /* ignore */ }

      if (pointers.size === 1 && mode === 'pinch') {
        // One finger lifted mid-pinch; fall back to a single-pointer
        // drag using the remaining finger so the gesture flows naturally
        // (no jump from the lifted finger's old position).
        mode = 'drag';
        panning = false;
        return;
      }
      if (pointers.size > 0) return;
      const wasClick = couldBeClick;
      couldBeClick = false;
      mode = 'idle';
      panning = false;
      // Save under the panel's effective graph id, NOT the global
      // currentEditingId — so a pinned Forest preview saves to
      // cameras['main'] even while the user is editing a leaf subgraph
      // in another panel.
      const gid = effectiveGraphIdRef.current;
      commitCamera(gid, cameraRef.current);
      // Click-to-select: never moved past the slop, so this was a tap
      // and not a camera drag. Pick at the original down-position
      // (using clientX/Y from THAT event, not pointerup — touch
      // pointerup can report a position that drifted slightly even
      // when the user thought it was stationary) and outline the hit.
      // No camera move — selecting and framing are separate gestures.
      if (wasClick) void pickAndSelect(clickStartX, clickStartY);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = cameraRef.current;
      const factor = Math.exp(e.deltaY * 0.001);
      cam.distance = Math.max(0.5, Math.min(250, cam.distance * factor));
      const id = effectiveGraphIdRef.current;
      commitCamera(id, cameraRef.current);
      requestRender();
    };

    // PreviewTile uses these projection params for its colour render —
    // pickAt must match exactly so the off-centre pick frustum lines up
    // pixel-for-pixel with what the user sees. If you change them in
    // preview-tile.tsx, change them here.
    const PREVIEW_FOV_Y = (60 * Math.PI) / 180;
    const PREVIEW_NEAR = 0.1;
    // Adaptive far plane — matches the colour-render frustum in
    // preview-tile.tsx so the picking ray traverses the same depth
    // range the user sees. A fixed 100m cap clipped 200m+ scenes.
    const previewFar = (distance: number) => Math.max(200, distance * 4);

    // Walk the registered tiles and return the one whose canvas
    // contains `clientX, clientY`. Returns the canvas rect + entry so
    // the caller can convert to backing-buffer pixel coords.
    function tileUnderCursor(clientX: number, clientY: number) {
      for (const entry of tilesRef.current.values()) {
        const r = entry.canvas.getBoundingClientRect();
        if (clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom) {
          return { entry, rect: r };
        }
      }
      return null;
    }

    // F-key target: frame whatever is currently selected. A no-op if
    // nothing is selected — matches Blender / Maya / Unity, where F is
    // "view selected" and a no-op without a selection. The user picks
    // first (click-to-select or right-click → Frame menu) and then F
    // re-frames whatever's outlined.
    function frameSelected(): void {
      const sel = selectionRef.current;
      if (!sel) return;
      // Any registered tile's renderer can answer — selection is
      // mirrored to every tile via applySelection, so they all carry
      // the same matched entities + transforms. Use the first one.
      const tile = tilesRef.current.values().next().value;
      if (!tile) return;
      const bounds = tile.renderer.getSelectionBounds(sel);
      if (bounds) frameCameraToBounds(bounds.center, bounds.radius);
    }

    // Click-to-select: pick at (clientX, clientY) and outline the hit
    // without moving the camera. Plain left-click → select. The F-key
    // and right-click menu route through their own pick paths because
    // they also need the resolved provenance for framing decisions.
    async function pickAndSelect(clientX: number, clientY: number): Promise<void> {
      const hit = tileUnderCursor(clientX, clientY);
      if (!hit) return;
      const { entry, rect } = hit;
      const canvas = entry.canvas;
      const px = Math.floor((clientX - rect.left) / rect.width * canvas.width);
      const py = Math.floor((clientY - rect.top) / rect.height * canvas.height);
      const cam = cameraRef.current;
      const modelView = multiply(
        multiply(
          multiply(translation(0, 0, -cam.distance), rotationX(cam.pitch)),
          rotationY(cam.yaw),
        ),
        translation(-cam.target[0], -cam.target[1], -cam.target[2]),
      );
      const id = await entry.renderer.pickAt({
        x: px, y: py,
        viewportWidth: canvas.width, viewportHeight: canvas.height,
        modelView,
        fovYRadians: PREVIEW_FOV_Y, aspect: canvas.width / canvas.height,
        zNear: PREVIEW_NEAR, zFar: previewFar(cam.distance),
      });
      if (id === 0) {
        // Click on sky / empty → deselect, matching how every DCC
        // tool treats a click-in-the-void as "clear my selection".
        applySelection(null);
        return;
      }
      const info = entry.renderer.getPickInfo(id);
      if (!info) return;
      const placements = info.provenance?.placements;
      if (placements && placements.length > 0) {
        const p = placements[placements.length - 1]!;
        applySelection({ kind: 'placement', distributeNodeId: p.distributeNodeId, pointIndex: p.pointIndex });
      } else if (info.provenance) {
        applySelection({ kind: 'origin', originNodeId: info.provenance.originNodeId });
      } else {
        applySelection(null);
      }
    }

    // Frame the camera onto a (center, radius) bounding sphere — what
    // the user actually means by "the tree" when they pick a leaf.
    // distance = radius / sin(fov/2) is the tightest fit; multiply by a
    // safety factor so the silhouette doesn't kiss the viewport edge.
    function frameCameraToBounds(center: [number, number, number], radius: number): void {
      const cam = cameraRef.current;
      cam.target[0] = center[0];
      cam.target[1] = center[1];
      cam.target[2] = center[2];
      const fit = radius / Math.sin(PREVIEW_FOV_Y / 2);
      cam.distance = Math.max(2, Math.min(250, fit * 1.4));
      commitCamera(effectiveGraphIdRef.current, cam);
      requestRender();
    }
    // Legacy fallback when bounds aren't computable (geometry has no
    // CPU mesh, or selection refers to an entity not in the scene).
    // Uses the placement's translation + a scale-derived distance.
    function frameCameraToTransform(t: Float32Array): void {
      const cam = cameraRef.current;
      const sX = Math.hypot(t[0]!, t[1]!, t[2]!);
      const sY = Math.hypot(t[4]!, t[5]!, t[6]!);
      const sZ = Math.hypot(t[8]!, t[9]!, t[10]!);
      const scale = Math.max(sX, sY, sZ);
      cam.target[0] = t[12]!;
      cam.target[1] = t[13]!;
      cam.target[2] = t[14]!;
      cam.distance = Math.max(2, Math.min(250, scale * 5));
      commitCamera(effectiveGraphIdRef.current, cam);
      requestRender();
    }
    // Identity transform for "Frame Scene" — drops target back at the
    // origin with the default-ish 50m distance (max of the 5×scale
    // heuristic clamped to 250, so a no-scale identity gives 5m. We
    // want "scene" to mean "pull back to see everything," so handle
    // that explicitly rather than running it through frameCameraTo.)
    function frameSceneDefault(): void {
      const cam = cameraRef.current;
      cam.target[0] = 0; cam.target[1] = 0; cam.target[2] = 0;
      cam.distance = 50;
      commitCamera(effectiveGraphIdRef.current, cam);
      requestRender();
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      // Esc closes an open context menu and clears the selection
      // outline. (Both behaviours match how every 3D app dismisses
      // transient UI / deselects.)
      if (k === 'escape') {
        setContextMenu(null);
        if (selectionRef.current) applySelection(null);
        return;
      }
      if (!HANDLED_KEYS.has(k)) return;
      e.preventDefault();
      // F is one-shot: fire on keydown, no key-held state to track.
      // No-op when nothing is selected — F is "view selected", not
      // "pick whatever is under the cursor"; the user selects via
      // click or the right-click Frame menu and F re-frames it.
      if (k === 'f') {
        frameSelected();
        return;
      }
      keysRef.current.add(k);
      if (MOVEMENT_KEYS.has(k)) motionStartRef.current();
    };

    // -----------------------------------------------------------------
    // Right-click context menu — picks at the cursor and offers Frame /
    // View in Canvas choices drawn from the entity's provenance chain.
    // -----------------------------------------------------------------
    // kebab → Title Case for subgraph ids that are used to label menu
    // items. "oak-tree" → "Oak Tree". Stable, no store lookup needed.
    function titleCase(id: string): string {
      return id
        .split(/[-_/]/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
    }

    async function pickForMenu(clientX: number, clientY: number): Promise<void> {
      const hit = tileUnderCursor(clientX, clientY);
      if (!hit) return;
      const { entry, rect } = hit;
      const canvas = entry.canvas;
      const px = Math.floor((clientX - rect.left) / rect.width * canvas.width);
      const py = Math.floor((clientY - rect.top) / rect.height * canvas.height);
      const cam = cameraRef.current;
      const modelView = multiply(
        multiply(
          multiply(translation(0, 0, -cam.distance), rotationX(cam.pitch)),
          rotationY(cam.yaw),
        ),
        translation(-cam.target[0], -cam.target[1], -cam.target[2]),
      );
      const id = await entry.renderer.pickAt({
        x: px, y: py,
        viewportWidth: canvas.width, viewportHeight: canvas.height,
        modelView,
        fovYRadians: PREVIEW_FOV_Y, aspect: canvas.width / canvas.height,
        zNear: PREVIEW_NEAR, zFar: previewFar(cam.distance),
      });
      const info = id !== 0 ? entry.renderer.getPickInfo(id) : null;

      const items: ContextMenuItem[] = [];
      if (info) {
        const placements = info.provenance?.placements ?? [];
        const subgraphPath = info.provenance?.subgraphPath ?? [];
        // Frame items, outermost-placement first (the F-default target).
        // Each placement corresponds to a subgraph in `subgraphPath` by
        // the invariant `placement[i] scattered subgraphPath[N-1-i]'s
        // output` — true for the standard "distribute takes a subgraph
        // wrapper's output" pattern; fallback label "Instance" when the
        // mapping doesn't apply (no enclosing subgraph).
        for (let i = placements.length - 1; i >= 0; i--) {
          const p = placements[i]!;
          const sgIdx = subgraphPath.length - 1 - i;
          const sg = sgIdx >= 0 ? subgraphPath[sgIdx] : undefined;
          const name = sg ? titleCase(sg.subgraphId) : 'Instance';
          const sel: import('../render/scene.js').SceneSelection = {
            kind: 'placement', distributeNodeId: p.distributeNodeId, pointIndex: p.pointIndex,
          };
          items.push({
            label: `Frame ${name} #${p.pointIndex}`,
            primary: i === placements.length - 1, // outermost = F-default
            action: () => {
              applySelection(sel);
              const bounds = entry.renderer.getSelectionBounds(sel);
              if (bounds) frameCameraToBounds(bounds.center, bounds.radius);
              else frameCameraToTransform(p.pointTransform);
            },
          });
        }
        if (placements.length === 0) {
          // No scatter — frame the entity's own bounds (e.g. terrain is
          // one big mesh placed by scene-entity, no instance-scatter).
          const originNodeId = info.provenance?.originNodeId;
          items.push({
            label: 'Frame Selection',
            primary: true,
            action: () => {
              if (originNodeId) {
                const sel: import('../render/scene.js').SceneSelection = { kind: 'origin', originNodeId };
                applySelection(sel);
                const bounds = entry.renderer.getSelectionBounds(sel);
                if (bounds) frameCameraToBounds(bounds.center, bounds.radius);
                else frameCameraToTransform(info.transform);
              } else {
                frameCameraToTransform(info.transform);
              }
            },
          });
        }
      }
      items.push({
        label: 'Frame Scene',
        action: () => {
          frameSceneDefault();
          applySelection(null);
        },
      });
      if (info && info.provenance && info.provenance.subgraphPath.length > 0) {
        // View in Canvas — innermost (deepest) subgraph first since
        // "I want to edit the leaf" is the most-likely intent when
        // right-clicking a forest leaf.
        const sgPath = info.provenance.subgraphPath;
        for (let i = sgPath.length - 1; i >= 0; i--) {
          const sg = sgPath[i]!;
          items.push({
            label: `View ${titleCase(sg.subgraphId)} in Canvas`,
            action: () => openGraphInCanvas(sg.subgraphId),
          });
        }
      }
      items.push({
        label: 'View Main in Canvas',
        action: () => openGraphInCanvas('main'),
      });

      setContextMenu({ x: clientX, y: clientY, items });
    }

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      // Update the cursor ref so the menu picks at the right pixel
      // (pointermove may not have fired in between).
      lastCursorRef.current = { clientX: e.clientX, clientY: e.clientY };
      void pickForMenu(e.clientX, e.clientY);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (!HANDLED_KEYS.has(k)) return;
      e.preventDefault();
      keysRef.current.delete(k);
      let stillMoving = false;
      keysRef.current.forEach((held) => {
        if (MOVEMENT_KEYS.has(held)) stillMoving = true;
      });
      if (!stillMoving) {
        const id = effectiveGraphIdRef.current;
        commitCamera(id, cameraRef.current);
      }
    };
    const onBlur = () => {
      if (keysRef.current.size === 0) return;
      keysRef.current.clear();
      const id = effectiveGraphIdRef.current;
      commitCamera(id, cameraRef.current);
    };

    // Pointer + wheel + contextmenu listen on the GRID (the canvas
    // area). Keyboard + blur listen on the WRAPPER (the focus
    // target). This split is load-bearing: the wrapper also
    // contains the header chrome (Play/Pause, pin dropdown), so if
    // pointerdown listened on the wrapper, button clicks would
    // bubble in and setPointerCapture would steal their pointerup.
    grid.addEventListener('pointerdown', onPointerDown);
    grid.addEventListener('pointermove', onPointerMove);
    grid.addEventListener('pointerup', onPointerUp);
    grid.addEventListener('pointercancel', onPointerUp);
    grid.addEventListener('wheel', onWheel, { passive: false });
    grid.addEventListener('contextmenu', onContextMenu);
    wrapper.addEventListener('keydown', onKeyDown);
    wrapper.addEventListener('keyup', onKeyUp);
    wrapper.addEventListener('blur', onBlur);

    return () => {
      grid.removeEventListener('pointerdown', onPointerDown);
      grid.removeEventListener('pointermove', onPointerMove);
      grid.removeEventListener('pointerup', onPointerUp);
      grid.removeEventListener('pointercancel', onPointerUp);
      grid.removeEventListener('wheel', onWheel);
      grid.removeEventListener('contextmenu', onContextMenu);
      wrapper.removeEventListener('keydown', onKeyDown);
      wrapper.removeEventListener('keyup', onKeyUp);
      wrapper.removeEventListener('blur', onBlur);
    };
  }, [commitCamera]);

  // WASD motion loop. The rAF only runs *while a movement key is held* —
  // when the user releases the last movement key, the loop self-terminates
  // and the app goes back to fully idle. Each motion frame calls
  // requestRender() so the tiles redraw the new camera. The keydown
  // handler kicks the loop on by calling `ensureRunning()` via the ref
  // we expose here.
  useEffect(() => {
    let raf = 0;
    let running = false;
    let cancelled = false;
    let lastFrameTime = 0;

    const frame = () => {
      if (cancelled) {
        running = false;
        return;
      }
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
      lastFrameTime = now;
      const cam = cameraRef.current;
      const keys = keysRef.current;
      const movementHeld =
        keys.has('w') || keys.has('a') || keys.has('s') ||
        keys.has('d') || keys.has('q') || keys.has('e');
      if (!movementHeld) {
        running = false;
        return;
      }
      const sprint = keys.has('shift') ? 3 : 1;
      const speed = cam.distance * 0.5 * sprint * dt;
      const r = multiply(rotationX(cam.pitch), rotationY(cam.yaw));
      const rightX = r[0]!, rightZ = r[8]!;
      const fwdRawX = -r[2]!, fwdRawZ = -r[10]!;
      const fwdLen = Math.hypot(fwdRawX, fwdRawZ);
      const fwdX = fwdRawX / fwdLen, fwdZ = fwdRawZ / fwdLen;
      let dx = 0, dy = 0, dz = 0;
      if (keys.has('w')) { dx += fwdX; dz += fwdZ; }
      if (keys.has('s')) { dx -= fwdX; dz -= fwdZ; }
      if (keys.has('d')) { dx += rightX; dz += rightZ; }
      if (keys.has('a')) { dx -= rightX; dz -= rightZ; }
      if (keys.has('e')) { dy += 1; }
      if (keys.has('q')) { dy -= 1; }
      const len = Math.hypot(dx, dy, dz);
      if (len > 0) {
        const k = speed / len;
        cam.target[0] += dx * k;
        cam.target[1] += dy * k;
        cam.target[2] += dz * k;
        requestRender();
      }
      raf = requestAnimationFrame(frame);
    };

    motionStartRef.current = () => {
      if (running || cancelled) return;
      running = true;
      lastFrameTime = performance.now();
      raf = requestAnimationFrame(frame);
    };

    return () => {
      cancelled = true;
      motionStartRef.current = () => {};
      cancelAnimationFrame(raf);
    };
  }, []);

  // Camera load/save on context switch — preserves per-graph framing.
  // Keyed by `effectiveGraphId` so pinned previews load their pinned
  // graph's camera even when the user navigates the active editing
  // context to a different graph.
  // Project-level cameras (per-graph defaults, persisted to save file) —
  // used only as the seed when this panel hasn't recorded its own
  // camera for the new graph yet. Two Preview panels never echo each
  // other through this map because gestures now write to layout-store
  // via commitCamera, not back to the project map.
  const projectCameras = useEditorStore((s) => s.cameras);
  const panelCameras = useLayoutStore((s) =>
    panelId ? s.previewCameras[panelId] : undefined,
  );
  const recentPreviewCameras = useLayoutStore((s) => s.recentPreviewCameras);
  const prevContextRef = useRef<string | null>(null);
  const prevPanelCamerasRef = useRef<typeof panelCameras | null>(null);
  // The previously-resolved fallback camera for this pane's effective
  // graph. We need this because `projectCameras` (and
  // `recentPreviewCameras`) can change ASYNCHRONOUSLY of any pin/edit —
  // notably during a demo-load: setGraph populates `cameras` with the
  // demo's per-graph framings AFTER this Preview component has already
  // mounted and snapshotted DEFAULT_CAMERA. Without tracking the
  // resolved stored value, the effect early-returns (idChanged=false,
  // panelCamerasChanged=false) and the Preview keeps DEFAULT_CAMERA —
  // user sees an empty sky because they're standing inside the
  // terrain. (Forest's main camera lives at distance=95.)
  const prevStoredRef = useRef<CameraState | undefined>(undefined);
  useEffect(() => {
    effectiveGraphIdRef.current = effectiveGraphId;
    const prevId = prevContextRef.current;
    const prevPanelCameras = prevPanelCamerasRef.current;
    const idChanged = prevId !== effectiveGraphId;
    const panelCamerasChanged = prevPanelCameras !== panelCameras;
    // Lookup chain when this preview hasn't recorded its own camera
    // for the new graph yet:
    //   1. recentPreviewCameras[graphId] — LRU across all previews this
    //      session (a freshly opened preview on a graph gets the last
    //      view another preview had).
    //   2. projectCameras[graphId] — cross-session seed from save file.
    //   3. DEFAULT_CAMERA.
    const stored =
      panelCameras?.[effectiveGraphId] ??
      recentPreviewCameras[effectiveGraphId] ??
      projectCameras[effectiveGraphId];
    const prevStored = prevStoredRef.current;
    const storedChanged = prevStored !== stored;
    // Early-return if nothing actionable changed. We deliberately
    // include `storedChanged` so a late-arriving fallback (demo
    // load → projectCameras populated) still takes effect even
    // though effectiveGraphId hasn't changed. Without it, the
    // Preview would stay on DEFAULT_CAMERA after every demo load
    // — exactly the "forest doesn't render" symptom.
    if (!idChanged && !panelCamerasChanged && !storedChanged) return;
    if (idChanged && prevId !== null) {
      commitCamera(prevId, cameraRef.current);
    }
    cameraRef.current = stored ? cloneCamera(stored) : cloneCamera(DEFAULT_CAMERA);
    prevContextRef.current = effectiveGraphId;
    prevPanelCamerasRef.current = panelCameras;
    prevStoredRef.current = stored;
    // The camera ref was mutated outside React; request a render so tiles
    // pick up the new viewpoint without waiting for the next input event.
    requestRender();
  }, [effectiveGraphId, panelCameras, recentPreviewCameras, projectCameras, commitCamera]);

  // Look up the root node's def — we need its declared output list to
  // map values back to socket names + types when synthesizing tiles.
  const rootDef = useMemo(() => {
    const node = graph.nodes.find((n) => n.id === rootNodeId);
    return node ? registry.get(node.kind) : undefined;
  }, [graph, rootNodeId, registry]);

  // Evaluate the graph and synthesize one tile per renderable output.
  //
  // The eval round: every node referenced this pass records its
  // fingerprint into `touched`. After eval, we sweep the shared cache,
  // evicting anything not in `touched` and destroying orphaned GPU
  // resources. When multi-pane editing arrives, each pane becomes a
  // consumer in the same round — we'd accumulate touched fingerprints
  // across all consumers before sweeping, but the structure here is
  // already correct for one consumer.
  // Hold registry + evalCache via refs so the eval effect doesn't
  // re-fire when the registry rebuilds for an UNRELATED subgraph edit.
  // Same pattern as AssetThumbnail / node-canvas — see those files
  // for the full rationale.
  const registryRef = useRef(registry);
  registryRef.current = registry;
  const evalCacheRef = useRef(evalCache);
  evalCacheRef.current = evalCache;
  useEffect(() => {
    if (!gpu) return;
    let cancelled = false;
    // Bracket the eval with begin/endCacheEval so the cache coordinator
    // defers sweeps while ANY consumer is in flight. Without this,
    // whichever consumer's eval finishes first triggers a sweep that
    // destroys cache entries the other in-flight evals just populated
    // but haven't yet reported. That manifests as "Destroyed texture
    // used in submit" on startup when Previews + asset thumbnails all
    // evaluate concurrently.
    beginCacheEval();
    (async () => {
      const touched = new Set<string>();
      let result;
      try {
        result = await evaluateGraph(graph, registryRef.current, {
          rootNodeId,
          context: { device: gpu.device },
          cache: evalCacheRef.current,
          touched,
        });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(e);
        setError(msg);
        return;
      } finally {
        endCacheEval();
      }
      if (cancelled) return;
      // Hand our touched set to the cache coordinator. It unions with
      // every other live consumer's set (other Previews, asset
      // thumbnails) and sweeps only entries no one references.
      reportWorking(touched);
      const nextLighting =
        (result.outputs.lighting as LightingValue | undefined) ?? defaultLighting();
      const nextTiles = synthesizeTiles(gpu.device, rootDef, result.outputs, nextLighting);
      setTiles(nextTiles);
      setError(null);
      // Always schedule a paint at the eval boundary. PreviewTile's own
      // scene-change effect would normally fire requestRender, but it
      // compares the new scene to the old by Object.is — and a re-eval
      // can update GPU resources IN-PLACE (texture content overwritten
      // via reusableTexture) while leaving the wrapping SceneValue
      // reference unchanged (cache hit at the root output node). Without
      // an explicit nudge here, those cases leave the canvas stale until
      // some other render trigger (camera move, resize) fires. The
      // render bus coalesces multiple requestRender calls in the same
      // frame, so this is cheap when the PreviewTile effect also fires.
      requestRender();
    })();
    return () => {
      cancelled = true;
    };
    // registry + evalCache held via ref so we don't re-fire when only
    // those identities flip. `subgraphs` IS in the dep list though:
    // when this preview is showing a graph that contains wrapper
    // instances of edited subgraphs, the subgraph defs are part of the
    // dependency chain — `graph` alone (e.g. mainGraph when previewing
    // main) doesn't change ref on a subgraph edit, but the wrapper's
    // output IS stale. Without this dep, "preview main, edit inside
    // a subgraph instanced by main" left the preview frozen on the
    // pre-edit canopy. The eval cache makes the extra re-eval cheap
    // when nothing the current graph references actually changed
    // (every node's fingerprint stays put → cache hits all the way).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpu, graph, rootNodeId, rootDef, reportWorking, subgraphs]);

  return (
    <div
      className="sedon-preview-pane"
      ref={wrapperRef}
      tabIndex={0}
    >
      <div className="sedon-preview-header">
        {panelId && (
          <PreviewPinDropdown
            panelId={panelId}
            subgraphs={subgraphs}
            pinnedGraphId={pinnedGraphId}
          />
        )}
        <AnimateToggle />
      </div>
      <div className="sedon-preview-grid" ref={gridRef}>
        {gpu &&
          tiles.map((t) => (
            <PreviewTile
              key={t.name}
              gpu={gpu}
              scene={t.scene}
              lighting={t.lighting}
              cameraRef={cameraRef}
              label={t.name}
              flatPreview={t.flatPreview}
              onTileReady={tileRegistrarFor(t.name)}
            />
          ))}
      </div>
      {error !== null && <div className="sedon-preview-error">{error}</div>}
      {contextMenu && createPortal(
        // Portal to document.body. DockView wraps each panel in a
        // `transform: translate3d(0,0,0)` container, which creates a
        // new containing block — under the wrapper, `position: fixed`
        // anchors to THAT container instead of the viewport, so the
        // menu lands at the wrong coordinates (or entirely off-screen
        // when the panel isn't at (0,0)). Rendering into document.body
        // escapes the transform context and lets `left/top: clientX/Y`
        // align with the cursor as intended.
        <div
          className="sedon-assets-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          // Eat mousedown so the global dismissal listener below doesn't
          // close us before the item's onClick fires.
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="sedon-assets-context-menu-title">Preview</div>
          {contextMenu.items.map((item, i) => (
            <button
              key={`${i}:${item.label}`}
              type="button"
              className="sedon-assets-context-menu-item"
              style={item.primary ? { fontWeight: 600 } : undefined}
              onClick={(e) => {
                e.stopPropagation();
                item.action();
                setContextMenu(null);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

// Per-Preview "pin" dropdown. Lets the user lock this Preview pane to a
// specific graph regardless of which graph the canvas is currently
// Every Preview pane is auto-pinned on mount (see the
// useEffect that calls setPanelPinnedGraph above), so the dropdown
// always shows a concrete graph. The list is just Main + every
// subgraph; selecting one repins this pane.
function PreviewPinDropdown({
  panelId,
  subgraphs,
  pinnedGraphId,
}: {
  panelId: string;
  subgraphs: ReadonlyArray<{ id: string; label: string }>;
  pinnedGraphId: string | undefined;
}) {
  const setPanelPinnedGraph = useLayoutStore((s) => s.setPanelPinnedGraph);
  const value = pinnedGraphId ?? 'main';
  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setPanelPinnedGraph(panelId, e.target.value);
  };
  // Detect a pin that points at a missing subgraph (deleted) so the
  // dropdown can flag it instead of silently snapping to main.
  const pinIsStale =
    pinnedGraphId !== undefined &&
    pinnedGraphId !== 'main' &&
    !subgraphs.find((s) => s.id === pinnedGraphId);
  return (
    <div className="sedon-preview-pin">
      <span className="sedon-preview-pin-label">View:</span>
      <select className="sedon-preview-pin-select" value={value} onChange={onChange}>
        <option value="main">Main</option>
        {subgraphs.map((sg) => (
          <option key={sg.id} value={sg.id}>{sg.label}</option>
        ))}
      </select>
      {pinIsStale && (
        <span className="sedon-preview-pin-stale" title="Pinned graph no longer exists">
          ⚠
        </span>
      )}
    </div>
  );
}
