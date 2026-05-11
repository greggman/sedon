import { useEffect, useRef, useState } from 'react';
import { evaluateGraph } from '../core/evaluate.js';
import { defaultLighting, type LightingValue, type SceneValue } from '../core/resources.js';
import { initWebGPU, type GpuContext } from '../render/device.js';
import { multiply, perspective, rotationX, rotationY, translation } from '../render/mat4.js';
import { createSceneRenderer } from '../render/scene.js';
import { useRegistry } from './registry.js';
import { useEditorStore, type CameraState } from './store.js';

// Camera math: orbit around `target` at `distance`, oriented by yaw/pitch.
//   modelView = translate(0, 0, -distance)
//             * rotateX(pitch)
//             * rotateY(yaw)
//             * translate(-target)
// Mouse drag rotates yaw/pitch. Cmd/Ctrl+drag pans the target along the
// camera's local right/up axes. Scroll zooms (changes distance).
//
// WASD/QE keyboard nav (when canvas has focus): W/S walk forward/back along
// camera-forward projected to the XZ plane, A/D strafe along camera-right
// (already horizontal — yaw-only basis has no Y). Q/E move the target on
// world up/down. Shift multiplies speed. Speed scales with `distance` so
// motion feels right at any zoom — fast across the forest, slow up close.
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [gpu, setGpu] = useState<GpuContext | null>(null);

  // Camera lives in a ref so the render loop reads fresh values without
  // re-rendering on every drag. Per-graph camera state is mirrored in the
  // store on drag-end and context switch so navigating subgraphs preserves
  // each one's framing.
  const cameraRef = useRef<OrbitCamera>(cloneCamera(DEFAULT_CAMERA));

  // Held keys for WASD/QE nav, read each frame by the render loop. Cleared
  // on canvas blur so a held key doesn't "stick" when focus moves away.
  const keysRef = useRef<Set<string>>(new Set());

  const graph = useEditorStore((s) => s.graph);
  const rootNodeId = useEditorStore((s) => s.rootNodeId);
  const currentEditingId = useEditorStore((s) => s.currentEditingId);
  const setEvalResult = useEditorStore((s) => s.setEvalResult);
  const setDevice = useEditorStore((s) => s.setDevice);
  const registry = useRegistry();

  // Init WebGPU once on mount.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    let cancelled = false;
    initWebGPU(canvas)
      .then((ctx) => {
        if (cancelled) return;
        setGpu(ctx);
        setDevice(ctx.device);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(e);
        setError(msg);
      });

    return () => {
      cancelled = true;
      observer.disconnect();
      setDevice(null);
    };
  }, [setDevice]);

  // Wire up orbit camera input on the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let dragging = false;
    let panning = false; // Locked at pointerdown by Cmd/Ctrl state
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      // Focus the canvas so subsequent keydowns route here. Click-focus
      // doesn't show a focus ring in modern browsers (focus-visible), so
      // this is invisible UX.
      canvas.focus();
      dragging = true;
      panning = e.metaKey || e.ctrlKey;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const cam = cameraRef.current;

      if (panning) {
        // Camera-local right/up in world space — derived from yaw/pitch.
        // The modelView is translate(-target) → rotY(yaw) → rotX(pitch);
        // its inverse rotation gives the camera basis in world space.
        const cy = Math.cos(cam.yaw);
        const sy = Math.sin(cam.yaw);
        const cp = Math.cos(cam.pitch);
        const sp = Math.sin(cam.pitch);
        const rightX = cy, rightY = 0, rightZ = -sy;
        const upX = -sy * sp, upY = cp, upZ = cy * sp;
        // Scale pan by distance so it feels constant in screen-space
        // regardless of zoom.
        const panSens = 0.0025 * cam.distance;
        const px = -dx * panSens; // drag right → target moves left → scene scrolls right
        const py =  dy * panSens; // drag down  → target moves up   → scene scrolls down
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
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore — already released.
      }
      // Persist the current camera into the store under the active editing
      // id so it survives a graph switch. Read currentEditingId fresh at
      // commit time (the effect's closure may have a stale value if id
      // changed mid-drag, which can't actually happen since switching
      // requires a click on the toolbar, ending this drag first).
      const id = useEditorStore.getState().currentEditingId;
      useEditorStore.getState().saveCameraFor(id, cloneCamera(cameraRef.current));
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = cameraRef.current;
      const factor = Math.exp(e.deltaY * 0.001);
      cam.distance = Math.max(0.5, Math.min(250, cam.distance * factor));
      // Same per-context save as drag-end. Zoom is also "user adjustment
      // worth remembering."
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
      // Save the camera once all movement keys are released. Shift alone
      // doesn't move the camera, so a stray Shift release shouldn't
      // trigger a redundant save.
      let stillMoving = false;
      keysRef.current.forEach((held) => {
        if (MOVEMENT_KEYS.has(held)) stillMoving = true;
      });
      if (!stillMoving) {
        const id = useEditorStore.getState().currentEditingId;
        useEditorStore.getState().saveCameraFor(id, cloneCamera(cameraRef.current));
      }
    };
    // If focus leaves the canvas mid-key, the keyup event goes elsewhere
    // and our key would otherwise "stick" — clear on blur to avoid a
    // runaway camera the next time the canvas regains focus.
    const onBlur = () => {
      if (keysRef.current.size === 0) return;
      keysRef.current.clear();
      const id = useEditorStore.getState().currentEditingId;
      useEditorStore.getState().saveCameraFor(id, cloneCamera(cameraRef.current));
    };

    canvas.tabIndex = 0;
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('blur', onBlur);

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('blur', onBlur);
    };
  }, []);

  // Camera load/save: fires on context switch (load that context's camera)
  // AND on cameras-map replacement (which happens when a demo or file load
  // resets the project state — we want the demo's initial framing to
  // apply even if currentEditingId stayed 'main'). Drag-end saves through
  // saveCameraFor → cameras changes too, but the loaded value equals what
  // was just saved so the reload is a no-op.
  const cameras = useEditorStore((s) => s.cameras);
  const prevContextRef = useRef<string | null>(null);
  const prevCamerasRef = useRef<typeof cameras | null>(null);
  useEffect(() => {
    const prevId = prevContextRef.current;
    const prevCameras = prevCamerasRef.current;
    const idChanged = prevId !== currentEditingId;
    const camerasChanged = prevCameras !== cameras;
    if (!idChanged && !camerasChanged) return;

    // Save the outgoing context's camera if we're actually switching
    // contexts. Skip on first mount (prevId null) and on cameras-only
    // changes (the outgoing camera is already in the store).
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

  // On graph change (and once GPU is up), re-evaluate and run the render loop.
  useEffect(() => {
    if (!gpu) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { device, context, format } = gpu;
    let cancelled = false;
    let rafId = 0;

    (async () => {
      let result;
      try {
        result = await evaluateGraph(graph, registry, {
          rootNodeId,
          context: { device },
        });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        console.error(e);
        setError(msg);
        return;
      }
      // Drop the result if a newer eval has been kicked off while we were
      // awaiting (graph mutated again).
      if (cancelled) return;

      // Scene defaults to an empty entity list when the eval root produced
      // nothing (e.g. viewing a subgraph whose preview chain isn't wired
      // yet). Renderer draws sky + nothing else, no crash.
      const scene = (result.outputs.scene as SceneValue | undefined) ?? { entities: [] };
      // Lighting is optional — older graphs without an Output node that
      // declares it fall back to the previous hardcoded values.
      const lighting = (result.outputs.lighting as LightingValue | undefined) ?? defaultLighting();
      setEvalResult({ scene, allOutputs: result.allOutputs });

      const renderer = createSceneRenderer(device, format, scene);

      let depthTexture: GPUTexture | null = null;
      let lastWidth = 0;
      let lastHeight = 0;
      let lastFrameTime = performance.now();

      const frame = () => {
        if (cancelled) return;
        if (canvas.width !== lastWidth || canvas.height !== lastHeight) {
          depthTexture?.destroy();
          depthTexture = device.createTexture({
            size: [canvas.width, canvas.height],
            format: 'depth32float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });
          lastWidth = canvas.width;
          lastHeight = canvas.height;
        }

        // Frame delta time, clamped so a long suspension (tab switch) doesn't
        // teleport the camera on resume.
        const now = performance.now();
        const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
        lastFrameTime = now;

        const cam = cameraRef.current;
        const keys = keysRef.current;
        if (keys.size > 0) {
          // Speed scales with distance: zoomed-out means traversing a large
          // scene, zoomed-in means inspecting up close. Sprint is 3x.
          const sprint = keys.has('shift') ? 3 : 1;
          const speed = cam.distance * 0.5 * sprint * dt;
          const cy = Math.cos(cam.yaw);
          const sy = Math.sin(cam.yaw);
          // Camera-right is already horizontal (yaw-only). Camera-forward
          // projected to XZ is up × right = (-sy, 0, -cy); we drop the Y
          // term so W/S walk along the ground regardless of pitch. The
          // minus-sy is load-bearing: rotationY here rotates +X→+Z (not
          // the textbook right-handed convention), so a naive +sy is
          // mirrored as soon as you yaw off zero.
          const rightX = cy, rightZ = -sy;
          const fwdX = -sy, fwdZ = -cy;
          let dx = 0, dy = 0, dz = 0;
          if (keys.has('w')) { dx += fwdX; dz += fwdZ; }
          if (keys.has('s')) { dx -= fwdX; dz -= fwdZ; }
          if (keys.has('d')) { dx += rightX; dz += rightZ; }
          if (keys.has('a')) { dx -= rightX; dz -= rightZ; }
          if (keys.has('e')) { dy += 1; }
          if (keys.has('q')) { dy -= 1; }
          // Normalize diagonal motion so a W+D press isn't sqrt(2) faster
          // than W alone.
          const len = Math.hypot(dx, dy, dz);
          if (len > 0) {
            const k = speed / len;
            cam.target[0] += dx * k;
            cam.target[1] += dy * k;
            cam.target[2] += dz * k;
          }
        }

        const aspect = canvas.width / canvas.height;
        const projection = perspective((60 * Math.PI) / 180, aspect, 0.1, 100);
        // modelView = trans(0,0,-distance) * rotX(pitch) * rotY(yaw) * trans(-target)
        // Translating by -target first puts the orbit pivot at the origin so
        // pitch/yaw rotate around it, not around world origin.
        const modelView = multiply(
          multiply(
            multiply(translation(0, 0, -cam.distance), rotationX(cam.pitch)),
            rotationY(cam.yaw),
          ),
          translation(-cam.target[0], -cam.target[1], -cam.target[2]),
        );

        const encoder = device.createCommandEncoder();
        renderer.render({
          encoder,
          colorView: context.getCurrentTexture().createView(),
          depthView: depthTexture!.createView(),
          modelView,
          projection,
          lighting,
        });
        device.queue.submit([encoder.finish()]);
        rafId = requestAnimationFrame(frame);
      };
      rafId = requestAnimationFrame(frame);
      setError(null);
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [gpu, graph, rootNodeId, setEvalResult, registry]);

  return (
    <div className="sedon-preview-pane">
      <canvas ref={canvasRef} className="sedon-preview-canvas" />
      {error !== null && <div className="sedon-preview-error">{error}</div>}
    </div>
  );
}
