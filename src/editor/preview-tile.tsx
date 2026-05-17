import { useEffect, useRef } from 'react';
import type { LightingValue, SceneValue } from '../core/resources.js';
import { configureCanvas, type GpuDevice } from '../render/device.js';
import {
  multiply,
  perspective,
  rotationX,
  rotationY,
  translation,
} from '../render/mat4.js';
import { createSceneRenderer, type SceneRenderer } from '../render/scene.js';
import { requestRender, subscribeRender } from './render-bus.js';
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
}

// One renderable preview. Owns its own canvas, GPU context, depth texture
// and scene renderer; reads the shared camera each frame so dragging in
// any tile (or moving via WASD) updates every tile uniformly. All input
// handling lives in the parent Preview's wrapper div — tile canvases are
// pure render targets.
export function PreviewTile({ gpu, scene, lighting, cameraRef, label, flatPreview }: PreviewTileProps) {
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
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
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

  // Build a scene renderer whenever the synthesized scene changes. New
  // scene every eval, but reference-equal across frames so the renderer
  // stays put between eval boundaries. Format-change rebuilds (popout
  // to a different-preferred-format window) are handled inside the
  // draw fn rather than via popoutGen here.
  useEffect(() => {
    rendererRef.current = createSceneRenderer(gpu.device, gpu.format, scene);
    return () => {
      rendererRef.current = null;
    };
  }, [gpu, scene]);

  // Render-on-demand. The render closure captures current scene / lighting
  // / flatPreview by being recreated whenever those change; that recreated
  // closure is then registered with the render bus AND invoked once so the
  // first frame paints. Camera mutation, WASD motion, resize, and eval
  // boundaries all funnel through `requestRender()`.
  //
  // The SceneRenderer owns depth + HDR + bloom intermediates internally
  // and (re)allocates them when we hand it a new size — we just pass
  // canvas.width/height each render.
  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      let ctx = ctxRef.current;
      let renderer = rendererRef.current;
      if (!canvas || !ctx || !renderer || canvas.width === 0 || canvas.height === 0) {
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
        rendererRef.current = createSceneRenderer(gpu.device, format, scene);
        ctx = fresh;
        renderer = rendererRef.current;
      }
      const cam = cameraRef.current;
      const aspect = canvas.width / canvas.height;
      const projection = perspective((60 * Math.PI) / 180, aspect, 0.1, 100);
      // modelView = trans(0,0,-distance) * rotX(pitch) * rotY(yaw) * trans(-target)
      const modelView = multiply(
        multiply(
          multiply(translation(0, 0, -cam.distance), rotationX(cam.pitch)),
          rotationY(cam.yaw),
        ),
        translation(-cam.target[0], -cam.target[1], -cam.target[2]),
      );
      const encoder = gpu.device.createCommandEncoder();
      renderer.render({
        encoder,
        colorView: ctx.getCurrentTexture(),
        size: [canvas.width, canvas.height],
        modelView,
        projection,
        cameraTarget: [cam.target[0], cam.target[1], cam.target[2]],
        lighting,
        flatPreview,
      });
      gpu.device.queue.submit([encoder.finish()]);
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
    </div>
  );
}
