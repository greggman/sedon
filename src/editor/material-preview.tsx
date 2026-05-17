import { useEffect, useRef, useState } from 'react';
import type { GeometryValue, MaterialValue } from '../core/resources.js';
import { defaultLighting, identityTint } from '../core/resources.js';
import { generateCube } from '../render/cube.js';
import { identity, multiply, perspective, rotationX, rotationY, translation } from '../render/mat4.js';
import { destroyGeometry, uploadMeshToGpu } from '../render/mesh.js';
import { createSceneRenderer, type SceneRenderer } from '../render/scene.js';
import { generateSphere } from '../render/sphere.js';

// MaterialPreview wraps (mesh + material) into a single-entity Scene with an
// identity transform, to feed the Scene-based renderer.

type Shape = 'sphere' | 'cube';

interface MaterialPreviewProps {
  device: GPUDevice;
  material: MaterialValue;
  size?: number;
}

export function MaterialPreview({ device, material, size = 128 }: MaterialPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<GPUCanvasContext | null>(null);
  const formatRef = useRef<GPUTextureFormat | null>(null);
  const rendererRef = useRef<SceneRenderer | null>(null);
  const geometryRef = useRef<GeometryValue | null>(null);
  const cameraRef = useRef({ yaw: 0, pitch: 0.4, distance: 3 });

  const [shape, setShape] = useState<Shape>('sphere');

  // Configure context once per device.
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

  // Pointer handlers (set up once on mount) call renderRef.current() to
  // re-render after camera updates. The render-install effect below
  // installs the real function; until then it's a no-op.
  const renderRef = useRef<() => void>(() => {});

  // The SceneRenderer is device+format-stable. Creating + destroying it
  // on every material edit was destroying 8+ GPU textures (depth + HDR
  // + 6 bloom mips) per edit per visible preview — a single material
  // slider scrub was producing dozens of allocations. Now it's one
  // renderer for the lifetime of the device.
  useEffect(() => {
    const format = formatRef.current;
    if (!format) return;
    const renderer = createSceneRenderer(device, format);
    rendererRef.current = renderer;
    return () => {
      renderer.destroy();
      if (rendererRef.current === renderer) rendererRef.current = null;
    };
  }, [device]);

  // Geometry is shape-dependent. The mesh + GPU buffers stay alive
  // across material edits — only changing the sphere/cube toggle
  // reallocates them.
  useEffect(() => {
    const mesh = shape === 'sphere' ? generateSphere(1, 32, 16) : generateCube(1.4);
    const geometry = uploadMeshToGpu(device, mesh);
    geometryRef.current = geometry;
    return () => {
      destroyGeometry(geometry);
      if (geometryRef.current === geometry) geometryRef.current = null;
    };
  }, [device, shape]);

  // Push the (geometry + material) scene into the renderer and install
  // the render fn. Only this effect fires on a material edit; the
  // renderer keeps all its GPU resources.
  useEffect(() => {
    const renderer = rendererRef.current;
    const geometry = geometryRef.current;
    if (!renderer || !geometry) return;
    renderer.setScene({
      entities: [{ geometry, material, transform: identity(), tint: identityTint() }],
    });

    const render = () => {
      const ctx = ctxRef.current;
      const canvas = canvasRef.current;
      if (!ctx || !canvas) return;

      const cam = cameraRef.current;
      const aspect = canvas.width / canvas.height;
      const projection = perspective((60 * Math.PI) / 180, aspect, 0.1, 100);
      const modelView = multiply(
        multiply(translation(0, 0, -cam.distance), rotationX(cam.pitch)),
        rotationY(cam.yaw),
      );

      // In-node previews use the default lighting / atmospheric sky.
      // The atmosphere is sun-driven now, so we can't tint to a neutral
      // dark background by overriding sky colors — the material sphere
      // sits against the same physical sky as the main preview. Future
      // option: add a "background override" path that bypasses the
      // atmosphere shader for in-node previews.
      const previewLighting = defaultLighting();

      const encoder = device.createCommandEncoder();
      renderer.render({
        encoder,
        colorView: ctx.getCurrentTexture(),
        size: [canvas.width, canvas.height],
        modelView,
        projection,
        cameraTarget: [0, 0, 0], // node previews orbit a fixed origin
        lighting: previewLighting,
      });
      device.queue.submit([encoder.finish()]);
    };

    renderRef.current = render;
    render();
    return () => {
      renderRef.current = () => {};
    };
  }, [device, material, shape]);

  // Wire orbit camera input on the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
      e.stopPropagation();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      const cam = cameraRef.current;
      cam.yaw += dx * 0.01;
      cam.pitch = Math.max(
        -Math.PI / 2 + 0.01,
        Math.min(Math.PI / 2 - 0.01, cam.pitch + dy * 0.01),
      );
      renderRef.current();
    };
    const onPointerUp = (e: PointerEvent) => {
      dragging = false;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore — pointer may already have been released.
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const cam = cameraRef.current;
      const factor = Math.exp(e.deltaY * 0.001);
      cam.distance = Math.max(0.5, Math.min(50, cam.distance * factor));
      renderRef.current();
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, []);

  const dpr = window.devicePixelRatio || 1;

  return (
    <div className="nodrag nopan sedon-material-preview">
      <canvas
        ref={canvasRef}
        className="sedon-material-preview-canvas"
        width={Math.round(size * dpr)}
        height={Math.round(size * dpr)}
        style={{ width: size, height: size }}
      />
      <div className="sedon-material-preview-toggle">
        <button
          type="button"
          onClick={() => setShape('sphere')}
          className={`sedon-material-preview-shape${shape === 'sphere' ? ' sedon-material-preview-shape--active' : ''}`}
          title="Show sphere"
        >
          ●
        </button>
        <button
          type="button"
          onClick={() => setShape('cube')}
          className={`sedon-material-preview-shape${shape === 'cube' ? ' sedon-material-preview-shape--active' : ''}`}
          title="Show cube"
        >
          ■
        </button>
      </div>
    </div>
  );
}
