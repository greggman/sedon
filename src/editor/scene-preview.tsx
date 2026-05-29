import { useCallback, useEffect, useMemo, useRef } from 'react';
import { debug } from '../core/debug.js';
import { defaultLighting, type SceneValue } from '../core/resources.js';
import { frameScene } from '../render/frame-scene.js';
import {
  multiply,
  perspective,
  rotationX,
  rotationY,
  translation,
} from '../render/mat4.js';
import { gpuObjectId } from '../render/gpu-cache.js';
import { createSceneRenderer, type SceneRenderer } from '../render/scene.js';
import { animationTime, requestRender, subscribeRender } from './render-bus.js';
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
   * and `target` are overridden by the auto-frame fit.
   */
  camera: CameraState;
  size?: number;
  /**
   * When true, the canvas captures pointer drags (orbit yaw + pitch)
   * and wheel events (zoom distance). Defaults to false so thumbnail
   * callers (asset panel, in-node previews) stay non-interactive and
   * pointer events fall through to whatever's hosting them. The
   * editor's main Preview pane still owns its own richer camera
   * (pan, WASD, framing); this is the lightweight version for docs.
   */
  interactive?: boolean;
}

export function ScenePreview({
  device, scene, camera, size = 128, interactive = false,
}: ScenePreviewProps) {
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
  // cameraRef syncs from framedCamera ONLY when the memo identity
  // changes (scene swap, prop angle change). Pointer/wheel handlers
  // mutate cameraRef directly between those resets so user interaction
  // survives across re-renders that don't change the framing.
  const cameraRef = useRef<CameraState>(framedCamera);
  useEffect(() => {
    cameraRef.current = { ...framedCamera };
    requestRender();
  }, [framedCamera]);

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
  // Renderer lives across scene changes — same pattern as PreviewTile.
  // Without this, every eval-driven scene replacement would destroy +
  // recreate the depth + HDR + 6 bloom mip textures inside the
  // renderer, multiplied by however many asset thumbnails are
  // visible. Splitting create from setScene keeps those alive.
  useEffect(() => {
    const format = formatRef.current;
    if (!format) return;
    debug('[ScenePreview RENDERER CREATED]');
    const renderer = createSceneRenderer(device, format);
    rendererRef.current = renderer;
    return () => {
      debug('[ScenePreview RENDERER DESTROYED]');
      renderer.destroy();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [device]);

  useEffect(() => {
    debug(() => {
      const ent0 = scene.entities[0];
      const firstMaterial = ent0?.material;
      const matKind = firstMaterial?.kind;
      const matTextureId =
        firstMaterial && firstMaterial.kind === 'pbr' && firstMaterial.basecolor
          ? `tex#${gpuObjectId(firstMaterial.basecolor.texture as unknown as object)}`
          : 'n/a';
      return [
        '[ScenePreview setScene]',
        { entities: scene.entities.length, matKind, matTextureId },
      ].join(' ');
    });
    rendererRef.current?.setScene(scene);
  }, [device, scene]);

  // Stable draw function via ref. Used by both:
  //   • the scene/camera-change effect (initial paint + auto-frame
  //     refit), and
  //   • the render-bus subscription (so other consumers that mutate
  //     GPU textures in place can poke us to repaint without changing
  //     our `scene` reference).
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
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
    const colorTex = ctx.getCurrentTexture();
    colorTex.label = 'ScenePreview canvas';
    renderer.render({
      encoder,
      colorView: colorTex,
      size: [canvas.width, canvas.height],
      modelView,
      projection,
      cameraTarget: [cam.target[0], cam.target[1], cam.target[2]],
      lighting: defaultLighting(),
      time: animationTime(),
    });
    device.queue.submit([encoder.finish()]);
  };

  // Repaint on scene / camera changes — the existing fast-path.
  useEffect(() => {
    drawRef.current();
  }, [device, scene, framedCamera]);

  // Repaint on render-bus ticks. The bus fires when ANY canvas eval
  // finishes (see node-canvas.tsx) or when the Preview pane's eval
  // commits. That covers the case where a colorize/blend/normal-map
  // node deep inside `oak-leaf` mutated its output texture in place:
  // this ScenePreview's `scene` reference is unchanged (cache hit at
  // the root output node, or we're a passive consumer that didn't
  // re-eval) so the scene-change effect won't fire, but the GPU
  // resources visible through `scene` now hold new pixels. Drawing
  // is cheap when nothing changed — it submits the same render with
  // the same textures.
  useEffect(() => {
    return subscribeRender(() => drawRef.current());
  }, []);

  // Pointer-drag orbit + wheel zoom. Sensitivity matches the main
  // Preview pane (~0.4° per pixel for orbit, ~5% per wheel notch).
  // Pitch is clamped to (−π/2, π/2) so the camera can't roll over the
  // pole and look at itself upside down.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
  }, [interactive]);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const last = lastPointerRef.current;
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
    const cam = cameraRef.current;
    cam.yaw -= dx * 0.007;
    cam.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, cam.pitch + dy * 0.007));
    requestRender();
  }, [interactive]);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    lastPointerRef.current = null;
  }, [interactive]);
  const onWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    // React's `WheelEvent` is passive by default; the canvas's
    // touch-action: none style (below) prevents the page from
    // scrolling under us, so we don't need preventDefault here.
    const cam = cameraRef.current;
    // Clamp to a sensible range relative to the auto-frame distance
    // — too close and the near plane clips; too far and bloom/HDR
    // breaks down on tiny meshes.
    const newDist = cam.distance * (1 + e.deltaY * 0.001);
    cam.distance = Math.max(framedCamera.distance * 0.1, Math.min(framedCamera.distance * 10, newDist));
    requestRender();
  }, [interactive, framedCamera]);

  const dpr = window.devicePixelRatio || 1;
  return (
    <canvas
      ref={canvasRef}
      className="sedon-scene-preview"
      width={Math.round(size * dpr)}
      height={Math.round(size * dpr)}
      style={{
        width: size,
        height: size,
        // touch-action: none stops mobile/trackpad scroll from
        // hijacking our pointer drags. cursor reflects affordance.
        ...(interactive ? { touchAction: 'none', cursor: 'grab' } : {}),
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
    />
  );
}
