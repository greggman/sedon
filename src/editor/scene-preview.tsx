import { useEffect, useMemo, useRef } from 'react';
import { defaultLighting, type SceneValue } from '../core/resources.js';
import { frameScene } from '../render/frame-scene.js';
import {
  multiply,
  perspective,
  rotationX,
  rotationY,
  translation,
} from '../render/mat4.js';
import { createSceneRenderer, type SceneRenderer } from '../render/scene.js';
import { usePopoutGeneration } from './popout-bus.js';
import type { CameraState } from './store.js';

const PREVIEW_FOV_Y = (60 * Math.PI) / 180;

// Thumbnail-sized Scene preview embedded inside a node. Mirrors what the
// main preview pane does but pinned to its own canvas + tiny size, so the
// user can tell at a glance which subgraph wrapper is which without
// drilling in. Render-on-demand via the shared render bus.
interface ScenePreviewProps {
  device: GPUDevice;
  scene: SceneValue;
  /**
   * Camera angles (yaw/pitch) to view from. Distance + target are
   * recomputed per-scene from the scene's bounding box so the preview
   * actually frames its content. Pass a saved-per-subgraph camera or a
   * sensible default — only its `yaw`/`pitch` are honored; `distance`
   * and `target` are overridden by the auto-frame fit. The preview never
   * mutates this — pointer interaction lives on the main pane only.
   */
  camera: CameraState;
  size?: number;
}

export function ScenePreview({ device, scene, camera, size = 128 }: ScenePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<GPUCanvasContext | null>(null);
  const formatRef = useRef<GPUTextureFormat | null>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  // Document the ctx is currently configured against. Used by the draw
  // path to detect cross-document moves (popout) and reconfigure
  // lazily. Same-document moves (DockView splits / group reflows)
  // leave the doc unchanged so we skip the dance entirely.
  const configuredDocRef = useRef<Document | null>(null);

  // Auto-frame the camera against the scene's AABB so wildly different
  // scene scales (a 100u tree vs a 0.1u gear) both fill the thumbnail.
  // Yaw/pitch from the caller are preserved; distance + target are
  // derived from the bounds.
  const framedCamera: CameraState = useMemo(() => {
    const fit = frameScene(scene, PREVIEW_FOV_Y);
    return {
      yaw: camera.yaw,
      pitch: camera.pitch,
      distance: fit.distance,
      target: fit.target,
    };
  }, [scene, camera.yaw, camera.pitch]);
  const cameraRef = useRef<CameraState>(framedCamera);
  cameraRef.current = framedCamera;

  // Configure the canvas's WebGPU context. Runs on mount per device.
  // We deliberately do NOT depend on popoutGen here — DockView splits
  // and group moves also bump that signal, and unconfiguring on every
  // bump produces a black flash for layout changes that don't actually
  // invalidate the swap chain. The draw fn below handles the real
  // cross-document case lazily by comparing canvas.ownerDocument
  // against `configuredDocRef`.
  const popoutGen = usePopoutGeneration();
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) return;
    const win = canvas.ownerDocument.defaultView ?? window;
    const format = win.navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: 'opaque' });
    ctxRef.current = ctx;
    formatRef.current = format;
    configuredDocRef.current = canvas.ownerDocument;
    return () => {
      try {
        ctx.unconfigure();
      } catch {
        // Context may already be detached (popout window closed); ignore.
      }
      ctxRef.current = null;
      formatRef.current = null;
      configuredDocRef.current = null;
    };
  }, [device]);

  // Build a fresh scene renderer when the scene changes. The SceneRenderer
  // pre-bakes pipelines + per-entity bind groups, so we cannot re-use it
  // across scenes — but it stays put across eval rounds when the scene
  // value is reference-equal. Format changes (popout to a different-
  // preferred-format window) are handled lazily inside the draw fn,
  // so popoutGen isn't a dep here.
  useEffect(() => {
    const format = formatRef.current;
    if (!format) return;
    rendererRef.current = createSceneRenderer(device, format, scene);
    return () => {
      rendererRef.current = null;
    };
  }, [device, scene]);

  // Single render on mount and whenever the scene / camera changes.
  // Deliberately NOT subscribed to the global render bus: thumbnails
  // have a fixed camera (no interactive controls), so the main pane's
  // pointer/WASD frames don't need to redraw them. Mirrors how
  // TexturePreview / MaterialPreview only redraw on their own input
  // changes.
  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      let ctx = ctxRef.current;
      let renderer = rendererRef.current;
      if (!canvas || !ctx || !renderer || canvas.width === 0 || canvas.height === 0) {
        return;
      }
      // Lazy popout recovery: if the canvas moved to a different
      // document since we configured (i.e. DockView popped this panel
      // into its own window), unconfigure the old context and rebuild
      // against the new document's navigator.gpu. The renderer must
      // also rebuild because its pipelines are bound to the canvas
      // format (which is window-dependent).
      if (configuredDocRef.current !== canvas.ownerDocument) {
        try { ctx.unconfigure(); } catch { /* already detached */ }
        const newCtx = canvas.getContext('webgpu');
        if (!newCtx) return;
        const win = canvas.ownerDocument.defaultView ?? window;
        const format = win.navigator.gpu.getPreferredCanvasFormat();
        newCtx.configure({ device, format, alphaMode: 'opaque' });
        ctxRef.current = newCtx;
        formatRef.current = format;
        configuredDocRef.current = canvas.ownerDocument;
        rendererRef.current = createSceneRenderer(device, format, scene);
        ctx = newCtx;
        renderer = rendererRef.current;
      }
      const cam = cameraRef.current;
      const aspect = canvas.width / canvas.height;
      const projection = perspective(PREVIEW_FOV_Y, aspect, 0.1, Math.max(200, cam.distance * 4));
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
        colorView: ctx.getCurrentTexture().createView(),
        size: [canvas.width, canvas.height],
        modelView,
        projection,
        cameraTarget: [cam.target[0], cam.target[1], cam.target[2]],
        lighting: defaultLighting(),
      });
      device.queue.submit([encoder.finish()]);
    };
    draw();
  }, [device, scene, framedCamera, popoutGen]);

  const dpr = window.devicePixelRatio || 1;
  return (
    <canvas
      ref={canvasRef}
      className="sedon-scene-preview"
      width={Math.round(size * dpr)}
      height={Math.round(size * dpr)}
      style={{ width: size, height: size }}
    />
  );
}
