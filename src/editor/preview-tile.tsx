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
import type { CameraState } from './store.js';

interface PreviewTileProps {
  gpu: GpuDevice;
  scene: SceneValue;
  lighting: LightingValue;
  /** Shared camera ref — every tile reads the same one so dragging any tile rotates them all in sync. */
  cameraRef: React.MutableRefObject<CameraState>;
  /** Small label rendered over the corner of the canvas (the output socket name). */
  label: string;
}

// One renderable preview. Owns its own canvas, GPU context, depth texture
// and scene renderer; reads the shared camera each frame so dragging in
// any tile (or moving via WASD) updates every tile uniformly. All input
// handling lives in the parent Preview's wrapper div — tile canvases are
// pure render targets.
export function PreviewTile({ gpu, scene, lighting, cameraRef, label }: PreviewTileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<GPUCanvasContext | null>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  const depthRef = useRef<GPUTexture | null>(null);

  // Configure context once per (canvas, device) pair, plus a DPR-aware
  // resize observer so the backing buffer tracks CSS size.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    };
    resize();
    const obs = new ResizeObserver(resize);
    obs.observe(canvas);
    ctxRef.current = configureCanvas(canvas, gpu);
    return () => {
      obs.disconnect();
      ctxRef.current = null;
      depthRef.current?.destroy();
      depthRef.current = null;
    };
  }, [gpu]);

  // Build a scene renderer whenever the synthesized scene changes. New
  // scene every eval, but reference-equal across frames so the renderer
  // stays put between eval boundaries.
  useEffect(() => {
    rendererRef.current = createSceneRenderer(gpu.device, gpu.format, scene);
    return () => {
      rendererRef.current = null;
    };
  }, [gpu, scene]);

  // rAF loop. Reads shared camera each frame — the parent's master rAF
  // mutates it from WASD input, and pointer drags on the wrapper update
  // it directly. We always redraw (no dirty flag): drag motion and the
  // continuous WASD path both want fresh frames.
  useEffect(() => {
    let raf = 0;
    let cancelled = false;
    let lastW = 0;
    let lastH = 0;
    const frame = () => {
      if (cancelled) return;
      raf = requestAnimationFrame(frame);
      const canvas = canvasRef.current;
      const ctx = ctxRef.current;
      const renderer = rendererRef.current;
      if (!canvas || !ctx || !renderer || canvas.width === 0 || canvas.height === 0) {
        return;
      }
      if (canvas.width !== lastW || canvas.height !== lastH) {
        depthRef.current?.destroy();
        depthRef.current = gpu.device.createTexture({
          size: [canvas.width, canvas.height],
          format: 'depth32float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        lastW = canvas.width;
        lastH = canvas.height;
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
        colorView: ctx.getCurrentTexture().createView(),
        depthView: depthRef.current!.createView(),
        modelView,
        projection,
        cameraTarget: [cam.target[0], cam.target[1], cam.target[2]],
        lighting,
      });
      gpu.device.queue.submit([encoder.finish()]);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [gpu, cameraRef, lighting]);

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
