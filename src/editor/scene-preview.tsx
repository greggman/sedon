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

  // Configure the canvas's WebGPU context once per device.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) return;
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: 'opaque' });
    ctxRef.current = ctx;
    formatRef.current = format;
    return () => {
      ctx.unconfigure();
      ctxRef.current = null;
      formatRef.current = null;
    };
  }, [device]);

  // Build a fresh scene renderer when the scene changes. The SceneRenderer
  // pre-bakes pipelines + per-entity bind groups, so we cannot re-use it
  // across scenes — but it stays put across eval rounds when the scene
  // value is reference-equal.
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
      const ctx = ctxRef.current;
      const renderer = rendererRef.current;
      if (!canvas || !ctx || !renderer || canvas.width === 0 || canvas.height === 0) {
        return;
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
        colorView: ctx.getCurrentTexture(),
        size: [canvas.width, canvas.height],
        modelView,
        projection,
        cameraTarget: [cam.target[0], cam.target[1], cam.target[2]],
        lighting: defaultLighting(),
      });
      device.queue.submit([encoder.finish()]);
    };
    draw();
  }, [device, scene, framedCamera]);

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
