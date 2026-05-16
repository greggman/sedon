import { useEffect, useMemo, useRef, useState } from 'react';
import type { Graph } from '../core/graph.js';
import { sweepCache } from '../core/eval-cache.js';
import { evaluateGraph } from '../core/evaluate.js';
import { defaultLighting, type LightingValue } from '../core/resources.js';
import { acquireGpuDevice, type GpuDevice } from '../render/device.js';
import { multiply, rotationX, rotationY } from '../render/mat4.js';
import { useLayoutStore } from './layout-store.js';
import { PreviewTile } from './preview-tile.js';
import { synthesizeTiles, type PreviewTileSpec } from './preview-synth.js';
import { useRegistry } from './registry.js';
import { requestRender } from './render-bus.js';
import { useEditorStore, type CameraState } from './store.js';

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
const HANDLED_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'shift']);

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
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [gpu, setGpu] = useState<GpuDevice | null>(null);

  const cameraRef = useRef<OrbitCamera>(cloneCamera(DEFAULT_CAMERA));
  const keysRef = useRef<Set<string>>(new Set());
  // Kicked by keydown to start the WASD motion rAF when it isn't already
  // running. Filled in by the motion-loop effect below; default no-op so
  // pre-mount keydown is a no-op rather than a crash.
  const motionStartRef = useRef<() => void>(() => {});

  // Mirror `effectiveGraphId` into a ref so input handlers (mounted once)
  // always read the current value without us tearing down + re-binding
  // listeners on every pin change.
  const effectiveGraphIdRef = useRef<string>('main');

  // Resolve which graph this Preview is showing. Unpinned panels follow
  // `currentEditingId` (legacy behavior); pinned ones lock to a specific
  // graph independently. The eval below runs against THIS graph, not
  // necessarily the one the user is currently editing.
  const pinnedGraphId = useLayoutStore((s) =>
    panelId ? s.pinnedGraphIds[panelId] : undefined,
  );
  const currentEditingId = useEditorStore((s) => s.currentEditingId);
  const effectiveGraphId = pinnedGraphId ?? currentEditingId;
  const isActive = effectiveGraphId === currentEditingId;

  const activeGraph = useEditorStore((s) => s.graph);
  const activeRootNodeId = useEditorStore((s) => s.rootNodeId);
  const mainGraph = useEditorStore((s) => s.mainGraph);
  const mainRootNodeId = useEditorStore((s) => s.mainRootNodeId);
  const subgraphs = useEditorStore((s) => s.subgraphs);
  const setEvalResult = useEditorStore((s) => s.setEvalResult);
  const setDevice = useEditorStore((s) => s.setDevice);
  const evalCache = useEditorStore((s) => s.evalCache);
  const registry = useRegistry();

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

  // Acquire the GPU device once. Canvases are configured per-tile against
  // this shared device.
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
      setDevice(null);
    };
  }, [setDevice]);

  // Wrapper-level input. Every drag/wheel/key event lands here regardless
  // of which tile the pointer is over, so we don't duplicate handlers per
  // tile. The wrapper itself is the focus target for keyboard input —
  // pointerdown explicitly focuses it so WASD works after a click.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    let dragging = false;
    let panning = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      wrapper.focus();
      dragging = true;
      panning = e.metaKey || e.ctrlKey;
      lastX = e.clientX;
      lastY = e.clientY;
      wrapper.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const cam = cameraRef.current;
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
      if (!dragging) return;
      dragging = false;
      panning = false;
      try {
        wrapper.releasePointerCapture(e.pointerId);
      } catch {
        // ignore — already released
      }
      // Save under the panel's effective graph id, NOT the global
      // currentEditingId — so a pinned Forest preview saves to
      // cameras['main'] even while the user is editing a leaf subgraph
      // in another panel.
      const id = effectiveGraphIdRef.current;
      useEditorStore.getState().saveCameraFor(id, cloneCamera(cameraRef.current));
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = cameraRef.current;
      const factor = Math.exp(e.deltaY * 0.001);
      cam.distance = Math.max(0.5, Math.min(250, cam.distance * factor));
      const id = effectiveGraphIdRef.current;
      useEditorStore.getState().saveCameraFor(id, cloneCamera(cameraRef.current));
      requestRender();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (!HANDLED_KEYS.has(k)) return;
      e.preventDefault();
      keysRef.current.add(k);
      if (MOVEMENT_KEYS.has(k)) motionStartRef.current();
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
        useEditorStore.getState().saveCameraFor(id, cloneCamera(cameraRef.current));
      }
    };
    const onBlur = () => {
      if (keysRef.current.size === 0) return;
      keysRef.current.clear();
      const id = effectiveGraphIdRef.current;
      useEditorStore.getState().saveCameraFor(id, cloneCamera(cameraRef.current));
    };

    wrapper.addEventListener('pointerdown', onPointerDown);
    wrapper.addEventListener('pointermove', onPointerMove);
    wrapper.addEventListener('pointerup', onPointerUp);
    wrapper.addEventListener('pointercancel', onPointerUp);
    wrapper.addEventListener('wheel', onWheel, { passive: false });
    wrapper.addEventListener('keydown', onKeyDown);
    wrapper.addEventListener('keyup', onKeyUp);
    wrapper.addEventListener('blur', onBlur);

    return () => {
      wrapper.removeEventListener('pointerdown', onPointerDown);
      wrapper.removeEventListener('pointermove', onPointerMove);
      wrapper.removeEventListener('pointerup', onPointerUp);
      wrapper.removeEventListener('pointercancel', onPointerUp);
      wrapper.removeEventListener('wheel', onWheel);
      wrapper.removeEventListener('keydown', onKeyDown);
      wrapper.removeEventListener('keyup', onKeyUp);
      wrapper.removeEventListener('blur', onBlur);
    };
  }, []);

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
  const cameras = useEditorStore((s) => s.cameras);
  const prevContextRef = useRef<string | null>(null);
  const prevCamerasRef = useRef<typeof cameras | null>(null);
  useEffect(() => {
    effectiveGraphIdRef.current = effectiveGraphId;
    const prevId = prevContextRef.current;
    const prevCameras = prevCamerasRef.current;
    const idChanged = prevId !== effectiveGraphId;
    const camerasChanged = prevCameras !== cameras;
    if (!idChanged && !camerasChanged) return;
    if (idChanged && prevId !== null) {
      useEditorStore
        .getState()
        .saveCameraFor(prevId, cloneCamera(cameraRef.current));
    }
    const stored = cameras[effectiveGraphId];
    cameraRef.current = stored ? cloneCamera(stored) : cloneCamera(DEFAULT_CAMERA);
    prevContextRef.current = effectiveGraphId;
    prevCamerasRef.current = cameras;
    // The camera ref was mutated outside React; request a render so tiles
    // pick up the new viewpoint without waiting for the next input event.
    requestRender();
  }, [effectiveGraphId, cameras]);

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
  useEffect(() => {
    if (!gpu) return;
    let cancelled = false;
    (async () => {
      const touched = new Set<string>();
      let result;
      try {
        result = await evaluateGraph(graph, registry, {
          rootNodeId,
          context: { device: gpu.device },
          cache: evalCache,
          touched,
        });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(e);
        setError(msg);
        return;
      }
      if (cancelled) return;
      // Sweep AFTER consuming `result.outputs` — destroying a texture
      // before synthesizeTiles reads it would be a use-after-destroy.
      // We've already used the outputs by the time we get here.
      sweepCache(evalCache, touched);
      const nextLighting =
        (result.outputs.lighting as LightingValue | undefined) ?? defaultLighting();
      const nextTiles = synthesizeTiles(gpu.device, rootDef, result.outputs, nextLighting);
      // For backward compat with the in-node previews and anything else
      // reading evalResult.scene, surface the first tile's scene (or an
      // empty scene if none). Only the panel viewing the ACTIVE graph
      // writes back — pinned panels eval their own graphs but mustn't
      // overwrite the active eval that drives node-thumbnail data.
      if (isActive) {
        const firstScene = nextTiles[0]?.scene ?? { entities: [] };
        setEvalResult({ scene: firstScene, allOutputs: result.allOutputs });
      }
      setTiles(nextTiles);
      setError(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [gpu, graph, rootNodeId, rootDef, registry, evalCache, setEvalResult, isActive]);

  return (
    <div
      className="sedon-preview-pane"
      ref={wrapperRef}
      tabIndex={0}
    >
      {panelId && (
        <PreviewPinDropdown
          panelId={panelId}
          subgraphs={subgraphs}
          pinnedGraphId={pinnedGraphId}
          activeId={currentEditingId}
        />
      )}
      <div className="sedon-preview-grid">
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
            />
          ))}
      </div>
      {error !== null && <div className="sedon-preview-error">{error}</div>}
    </div>
  );
}

// Per-Preview "pin" dropdown. Lets the user lock this Preview pane to a
// specific graph regardless of which graph the canvas is currently
// editing. "Active (current)" reverts to follow-active behavior.
function PreviewPinDropdown({
  panelId,
  subgraphs,
  pinnedGraphId,
  activeId,
}: {
  panelId: string;
  subgraphs: ReadonlyArray<{ id: string; label: string }>;
  pinnedGraphId: string | undefined;
  activeId: string;
}) {
  const setPanelPinnedGraph = useLayoutStore((s) => s.setPanelPinnedGraph);
  const value = pinnedGraphId ?? '__auto__';
  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    setPanelPinnedGraph(panelId, v === '__auto__' ? undefined : v);
  };
  // Detect a pin that points at a missing subgraph (deleted) so the
  // dropdown can flag it instead of silently snapping to active.
  const pinIsStale =
    pinnedGraphId !== undefined &&
    pinnedGraphId !== 'main' &&
    !subgraphs.find((s) => s.id === pinnedGraphId);
  return (
    <div className="sedon-preview-pin">
      <span className="sedon-preview-pin-label">View:</span>
      <select className="sedon-preview-pin-select" value={value} onChange={onChange}>
        <option value="__auto__">
          Active{pinnedGraphId === undefined ? '' : ''} ({activeId === 'main' ? 'Main' : activeId})
        </option>
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
