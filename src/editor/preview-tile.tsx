import { useEffect, useRef } from 'react';
import { debug } from '../core/debug.js';
import type { LightingValue, SceneValue } from '../core/resources.js';
import { configureCanvas, type GpuDevice } from '../render/device.js';
import { gpuObjectId } from '../render/gpu-cache.js';
import {
  multiply,
  orthographic,
  perspective,
  rotationX,
  rotationY,
  translation,
} from '../render/mat4.js';
import { createSceneRenderer, type SceneRenderer } from '../render/scene.js';
import { CameraGizmos } from './camera-gizmos.js';
import { animationTime, currentForceSerial, requestRender, subscribeRender } from './render-bus.js';
import type { CameraState } from './store.js';

interface PreviewTileProps {
  gpu: GpuDevice;
  scene: SceneValue;
  lighting: LightingValue;
  /** Shared camera ref — every tile reads the same one so dragging any tile rotates them all in sync. */
  cameraRef: React.MutableRefObject<CameraState>;
  /** Small label rendered over the corner of the canvas (the output socket name). */
  label: string;
  /** Asset-inspection mode: checkerboard backdrop, no tonemap. */
  flatPreview: boolean;
  /**
   * Optional registration for GPU picking. Called once with this tile's
   * canvas + SceneRenderer when the tile mounts (or when either changes
   * across a popout / device swap), and once with `null` on unmount.
   * The parent Preview's "F = frame" key handler looks at which tile
   * the cursor is over and drives pickAt against its renderer.
   */
  onTileReady?: (info: { canvas: HTMLCanvasElement; renderer: SceneRenderer } | null) => void;
  /**
   * Persist the current camera (called by the gizmo overlay when a
   * drag or click finishes). Mirrors the commitCamera calls the parent
   * Preview makes from its canvas pointer/keyboard handlers.
   */
  onCameraCommit: () => void;
}

// One renderable preview. Owns its own canvas, GPU context, depth texture
// and scene renderer; reads the shared camera each frame so dragging in
// any tile (or moving via WASD) updates every tile uniformly. All input
// handling lives in the parent Preview's wrapper div — tile canvases are
// pure render targets.
export function PreviewTile({ gpu, scene, lighting, cameraRef, label, flatPreview, onTileReady, onCameraCommit }: PreviewTileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<GPUCanvasContext | null>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  // Document the ctx is currently configured against. Used by the draw
  // path to lazy-reconfigure when the canvas reparents to a different
  // window (popout). Same-document layout changes (splits, group
  // reflows) don't touch this so we skip the unconfigure dance that
  // would otherwise flash black on every DockView event.
  const configuredDocRef = useRef<Document | null>(null);

  // Configure context once per (canvas, device) pair, plus a DPR-aware
  // resize observer so the backing buffer tracks CSS size. Resizes
  // request a fresh render — the canvas is now blank until we draw into
  // it, since we no longer paint every frame unconditionally.
  //
  // Cross-document reconfig (popout) is handled inside the draw fn, not
  // here.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const win = canvas.ownerDocument.defaultView ?? window;
    const dpr = win.devicePixelRatio || 1;
    const resize = () => {
      const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      // Guard same-size writes. Assigning canvas.width (or .height)
      // CLEARS the canvas's backbuffer, even when the value is
      // unchanged. ResizeObserver fires unconditionally on subtree
      // layout changes, so an unguarded write here black-frames the
      // canvas every layout tick. Render-on-demand then leaves the
      // canvas blank until the next non-resize redraw.
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      requestRender();
    };
    resize();
    const ResizeObs = win.ResizeObserver ?? ResizeObserver;
    const obs = new ResizeObs(resize);
    obs.observe(canvas);
    ctxRef.current = configureCanvas(canvas, gpu);
    configuredDocRef.current = canvas.ownerDocument;
    return () => {
      obs.disconnect();
      try {
        ctxRef.current?.unconfigure();
      } catch {
        // ignore: detached if popout window closed first
      }
      ctxRef.current = null;
      configuredDocRef.current = null;
    };
  }, [gpu]);

  // Build the SceneRenderer once per (device, format). The renderer
  // owns its pipelines, samplers, shadow texture, depth/HDR/bloom
  // intermediates, scene/sky/shadow uniform buffers — all of which
  // are scene-independent and shouldn't churn on every material edit.
  // The per-scene batch list is pushed in via the separate setScene
  // effect below. Destroy cleans up the per-canvas-size intermediates
  // (depth + HDR + bloom mips) on unmount to avoid GPU memory leaks.
  useEffect(() => {
    const renderer = createSceneRenderer(gpu.device, gpu.format);
    rendererRef.current = renderer;
    // Hand the renderer to the parent so the F-key/right-click pick
    // path can call `pickAt` against this specific tile. Canvas ref is
    // populated by the JSX further down on first commit, so this
    // effect runs after both refs are live.
    const canvas = canvasRef.current;
    if (onTileReady && canvas) onTileReady({ canvas, renderer });
    return () => {
      if (onTileReady) onTileReady(null);
      renderer.destroy();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [gpu, onTileReady]);

  // Push the latest synthesized scene into the renderer. Just rebuilds
  // batches (per-entity instance buffers + per-material bind groups);
  // everything else in the renderer stays alive between calls.
  useEffect(() => {
    debug(() => {
      const summary = scene.entities.map((e, i) => {
        const g = e.geometry as { positionBuffer?: object; indexCount: number };
        const posId = g.positionBuffer ? gpuObjectId(g.positionBuffer) : '?';
        const mat = e.material as { kind: string; basecolor?: { texture: object } };
        const baseId = mat.basecolor ? gpuObjectId(mat.basecolor.texture) : '?';
        return `[${i}] pos#${posId} idx=${g.indexCount} base#${baseId}`;
      }).join(' ');
      return `[PreviewTile setScene] label="${label}" entities=${scene.entities.length} ${summary}`;
    });
    rendererRef.current?.setScene(scene);
  }, [gpu, scene, label]);

  // Render-on-demand. The render closure captures current scene / lighting
  // / flatPreview by being recreated whenever those change; that recreated
  // closure is then registered with the render bus AND invoked once so the
  // first frame paints. Camera mutation, WASD motion, resize, and eval
  // boundaries all funnel through `requestRender()`.
  //
  // The SceneRenderer owns depth + HDR + bloom intermediates internally
  // and (re)allocates them when we hand it a new size — we just pass
  // canvas.width/height each render.
  // Per-tile dirty short-circuit. Without this, every requestRender()
  // call from anywhere in the editor causes EVERY subscribed preview
  // tile to redraw — at 30+ tiles, the editor melts.
  const lastDrawRef = useRef({
    scene: null as SceneValue | null,
    yaw: Number.NaN, pitch: Number.NaN, distance: Number.NaN,
    tx: Number.NaN, ty: Number.NaN, tz: Number.NaN,
    width: 0, height: 0,
    time: Number.NaN,
    forceSerial: -1,
    mode: '' as '' | 'persp' | 'ortho',
    orthoHeight: Number.NaN,
  });
  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      let ctx = ctxRef.current;
      let renderer = rendererRef.current;
      if (!canvas || !ctx || !renderer || canvas.width === 0 || canvas.height === 0) {
        return;
      }
      const cam = cameraRef.current;
      const t = animationTime();
      const fs = currentForceSerial();
      const last = lastDrawRef.current;
      const camMode = cam.mode ?? 'persp';
      const camOrthoH = cam.orthoHeight ?? Number.NaN;
      if (
        last.scene === scene
        && last.yaw === cam.yaw
        && last.pitch === cam.pitch
        && last.distance === cam.distance
        && last.tx === cam.target[0]
        && last.ty === cam.target[1]
        && last.tz === cam.target[2]
        && last.width === canvas.width
        && last.height === canvas.height
        && last.time === t
        && last.forceSerial === fs
        && last.mode === camMode
        && (last.orthoHeight === camOrthoH || (Number.isNaN(last.orthoHeight) && Number.isNaN(camOrthoH)))
      ) {
        return;
      }
      // Lazy popout recovery: if the canvas moved to a different
      // document, the existing swap chain is invalid. Reconfigure
      // against the new document's navigator.gpu and rebuild the
      // renderer (its pipelines are bound to the canvas format which
      // is window-scoped).
      if (configuredDocRef.current !== canvas.ownerDocument) {
        try { ctx.unconfigure(); } catch { /* already detached */ }
        const win = canvas.ownerDocument.defaultView ?? window;
        const format = win.navigator.gpu.getPreferredCanvasFormat();
        const fresh = canvas.getContext('webgpu');
        if (!fresh) return;
        fresh.configure({ device: gpu.device, format, alphaMode: 'premultiplied' });
        ctxRef.current = fresh;
        configuredDocRef.current = canvas.ownerDocument;
        // Format may have changed across the popout, so the renderer
        // built against the old format is stale. Destroy + rebuild and
        // re-push the current scene.
        renderer?.destroy();
        const next = createSceneRenderer(gpu.device, format);
        next.setScene(scene);
        rendererRef.current = next;
        ctx = fresh;
        renderer = next;
      }
      debug(() => `[PreviewTile draw] label="${label}" yaw=${cam.yaw.toFixed(3)} pitch=${cam.pitch.toFixed(3)} dist=${cam.distance.toFixed(3)} target=[${cam.target.map((v) => v.toFixed(2)).join(',')}]`);
      const aspect = canvas.width / canvas.height;
      // zFar scales with orbit distance so the far plane never clips
      // the scene back. Reverse-Z + depth32float keeps precision fine
      // out to many km; the `max(200, …)` floor keeps tiny camera
      // distances from collapsing the depth budget to nothing.
      // Matches scene-preview.tsx's adaptive formula.
      const fovY = (60 * Math.PI) / 180;
      const zFar = Math.max(200, cam.distance * 4);
      // Ortho frustum is centred on the optical axis (target sits in
      // the middle of the view), with height locked to orthoHeight so
      // pixel scale only changes when the user dollies. Width tracks
      // aspect. If orthoHeight wasn't initialised yet, derive it from
      // the perspective frustum at the target plane so the flip is
      // continuous.
      const projection =
        cam.mode === 'ortho'
          ? (() => {
              const h = (cam.orthoHeight ?? cam.distance * 2 * Math.tan(fovY / 2)) / 2;
              const w = h * aspect;
              return orthographic(-w, w, -h, h, -zFar, zFar);
            })()
          : perspective(fovY, aspect, 0.1, zFar);
      // modelView = trans(0,0,-distance) * rotX(pitch) * rotY(yaw) * trans(-target)
      const modelView = multiply(
        multiply(
          multiply(translation(0, 0, -cam.distance), rotationX(cam.pitch)),
          rotationY(cam.yaw),
        ),
        translation(-cam.target[0], -cam.target[1], -cam.target[2]),
      );
      const encoder = gpu.device.createCommandEncoder({ label: 'preview-tile-encoder' });
      const colorTex = ctx.getCurrentTexture();
      colorTex.label = `PreviewTile canvas "${label}"`;
      renderer.render({
        encoder,
        colorView: colorTex,
        size: [canvas.width, canvas.height],
        modelView,
        projection,
        cameraTarget: [cam.target[0], cam.target[1], cam.target[2]],
        lighting,
        flatPreview,
        time: t,
      });
      gpu.device.queue.submit([encoder.finish()]);
      last.scene = scene;
      last.yaw = cam.yaw;
      last.pitch = cam.pitch;
      last.distance = cam.distance;
      last.tx = cam.target[0];
      last.ty = cam.target[1];
      last.tz = cam.target[2];
      last.width = canvas.width;
      last.height = canvas.height;
      last.time = t;
      last.forceSerial = fs;
      last.mode = camMode;
      last.orthoHeight = camOrthoH;
    };
    const unsubscribe = subscribeRender(draw);
    // Initial paint for this scene/lighting/flatPreview combination.
    // Coalesced into a single rAF with any other tiles' initial draws.
    requestRender();
    return unsubscribe;
  }, [gpu, scene, cameraRef, lighting, flatPreview]);

  return (
    <div className="sedon-preview-tile">
      {/* The host div is the absolute-positioned layout box; the canvas
       * inside it sizes via percentages against the host. Going through a
       * non-replaced wrapper avoids the "auto width/height on absolute
       * replaced element falls back to intrinsic" rule, which otherwise
       * causes the canvas's backing buffer (the intrinsic dimensions) to
       * feed back into the layout — doubling every resize tick. */}
      <div className="sedon-preview-canvas-host">
        <canvas ref={canvasRef} className="sedon-preview-canvas" />
      </div>
      <div className="sedon-preview-tile-label">{label}</div>
      <CameraGizmos cameraRef={cameraRef} onCommit={onCameraCommit} />
    </div>
  );
}
