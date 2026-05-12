import { useEffect, useMemo, useRef, useState } from 'react';
import { evaluateGraph } from '../core/evaluate.js';
import { defaultLighting, type LightingValue } from '../core/resources.js';
import { acquireGpuDevice, type GpuDevice } from '../render/device.js';
import { multiply, rotationX, rotationY } from '../render/mat4.js';
import { PreviewTile } from './preview-tile.js';
import { synthesizeTiles, type PreviewTileSpec } from './preview-synth.js';
import { useRegistry } from './registry.js';
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

export function Preview() {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [gpu, setGpu] = useState<GpuDevice | null>(null);

  const cameraRef = useRef<OrbitCamera>(cloneCamera(DEFAULT_CAMERA));
  const keysRef = useRef<Set<string>>(new Set());

  const graph = useEditorStore((s) => s.graph);
  const rootNodeId = useEditorStore((s) => s.rootNodeId);
  const currentEditingId = useEditorStore((s) => s.currentEditingId);
  const setEvalResult = useEditorStore((s) => s.setEvalResult);
  const setDevice = useEditorStore((s) => s.setDevice);
  const registry = useRegistry();

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
      const id = useEditorStore.getState().currentEditingId;
      useEditorStore.getState().saveCameraFor(id, cloneCamera(cameraRef.current));
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = cameraRef.current;
      const factor = Math.exp(e.deltaY * 0.001);
      cam.distance = Math.max(0.5, Math.min(250, cam.distance * factor));
      const id = useEditorStore.getState().currentEditingId;
      useEditorStore.getState().saveCameraFor(id, cloneCamera(cameraRef.current));
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (!HANDLED_KEYS.has(k)) return;
      e.preventDefault();
      keysRef.current.add(k);
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
        const id = useEditorStore.getState().currentEditingId;
        useEditorStore.getState().saveCameraFor(id, cloneCamera(cameraRef.current));
      }
    };
    const onBlur = () => {
      if (keysRef.current.size === 0) return;
      keysRef.current.clear();
      const id = useEditorStore.getState().currentEditingId;
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

  // Master rAF: process WASD motion every frame so all tiles see the
  // updated camera on their own render loops. Tiles don't process WASD
  // themselves — that would mean N tiles each adding motion N times.
  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    let lastFrameTime = performance.now();
    const frame = () => {
      if (cancelled) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
      lastFrameTime = now;
      const cam = cameraRef.current;
      const keys = keysRef.current;
      if (keys.size > 0) {
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
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  // Camera load/save on context switch — preserves per-graph framing as
  // the user drills into / out of subgraphs.
  const cameras = useEditorStore((s) => s.cameras);
  const prevContextRef = useRef<string | null>(null);
  const prevCamerasRef = useRef<typeof cameras | null>(null);
  useEffect(() => {
    const prevId = prevContextRef.current;
    const prevCameras = prevCamerasRef.current;
    const idChanged = prevId !== currentEditingId;
    const camerasChanged = prevCameras !== cameras;
    if (!idChanged && !camerasChanged) return;
    if (idChanged && prevId !== null) {
      useEditorStore
        .getState()
        .saveCameraFor(prevId, cloneCamera(cameraRef.current));
    }
    const stored = cameras[currentEditingId];
    cameraRef.current = stored ? cloneCamera(stored) : cloneCamera(DEFAULT_CAMERA);
    prevContextRef.current = currentEditingId;
    prevCamerasRef.current = cameras;
  }, [currentEditingId, cameras]);

  // Look up the root node's def — we need its declared output list to
  // map values back to socket names + types when synthesizing tiles.
  const rootDef = useMemo(() => {
    const node = graph.nodes.find((n) => n.id === rootNodeId);
    return node ? registry.get(node.kind) : undefined;
  }, [graph, rootNodeId, registry]);

  // Evaluate the graph and synthesize one tile per renderable output.
  useEffect(() => {
    if (!gpu) return;
    let cancelled = false;
    (async () => {
      let result;
      try {
        result = await evaluateGraph(graph, registry, {
          rootNodeId,
          context: { device: gpu.device },
        });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(e);
        setError(msg);
        return;
      }
      if (cancelled) return;
      const nextLighting =
        (result.outputs.lighting as LightingValue | undefined) ?? defaultLighting();
      const nextTiles = synthesizeTiles(gpu.device, rootDef, result.outputs, nextLighting);
      // For backward compat with the in-node previews and anything else
      // reading evalResult.scene, surface the first tile's scene (or an
      // empty scene if none).
      const firstScene = nextTiles[0]?.scene ?? { entities: [] };
      setEvalResult({ scene: firstScene, allOutputs: result.allOutputs });
      setTiles(nextTiles);
      setError(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [gpu, graph, rootNodeId, rootDef, registry, setEvalResult]);

  return (
    <div
      className="sedon-preview-pane"
      ref={wrapperRef}
      tabIndex={0}
    >
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
