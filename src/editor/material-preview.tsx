import { useEffect, useRef, useState } from 'react';
import type { GeometryValue, MaterialValue } from '../core/resources.js';
import { defaultLighting, identityTint } from '../core/resources.js';
import { generateCube } from '../render/cube.js';
import { identity, multiply, perspective, rotationX, rotationY, translation } from '../render/mat4.js';
import { destroyGeometry, uploadMeshToGpu } from '../render/mesh.js';
import { createSceneRenderer, type SceneRenderer } from '../render/scene.js';
import { generateSphere } from '../render/sphere.js';
import { usePopoutGeneration } from './popout-bus.js';

// MaterialPreview wraps (mesh + material) into a single-entity Scene with an
// identity transform, to feed the Scene-based renderer.

type Shape = 'sphere' | 'cube';

interface MaterialPreviewProps {
  device: GPUDevice;
  material: MaterialValue;
  size?: number;
}

interface RenderResources {
  renderer: SceneRenderer;
  geometry: GeometryValue;
}

export function MaterialPreview({ device, material, size = 128 }: MaterialPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<GPUCanvasContext | null>(null);
  const formatRef = useRef<GPUTextureFormat | null>(null);
  const resourcesRef = useRef<RenderResources | null>(null);
  const cameraRef = useRef({ yaw: 0, pitch: 0.4, distance: 3 });
  const configuredDocRef = useRef<Document | null>(null);

  const [shape, setShape] = useState<Shape>('sphere');

  // Configure context. Cross-document reconfig (popout) is handled
  // lazily inside the render function below so same-document layout
  // changes (DockView splits) don't trigger an unconfigure+reconfigure
  // dance that flashes the canvas black.
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
        // ignore: context detached after popout window closed
      }
      ctxRef.current = null;
      formatRef.current = null;
      configuredDocRef.current = null;
    };
  }, [device]);

  // Pointer handlers (set up once on mount) call renderRef.current() to
  // re-render after camera updates. The geometry effect installs the real
  // function; until then it's a no-op.
  const renderRef = useRef<() => void>(() => {});

  // Build geometry + scene renderer + render function when shape or material
  // changes. The render function is installed BEFORE the initial render() call
  // so the first frame paints — that was the previous bug (the function
  // wasn't installed until a separate effect that ran later).
  useEffect(() => {
    const format = formatRef.current;
    if (!format) return;

    const mesh = shape === 'sphere' ? generateSphere(1, 32, 16) : generateCube(1.4);
    const geometry = uploadMeshToGpu(device, mesh);
    const renderer = createSceneRenderer(device, format, {
      entities: [{ geometry, material, transform: identity(), tint: identityTint() }],
    });
    resourcesRef.current = { renderer, geometry };

    const render = () => {
      let ctx = ctxRef.current;
      const canvas = canvasRef.current;
      let r = resourcesRef.current;
      if (!ctx || !r || !canvas) return;

      // Lazy popout recovery: if the canvas reparented to a different
      // document, the existing swap chain + format-bound pipelines are
      // stale. Reconfigure against the new document and rebuild the
      // renderer (which holds format-bound pipelines).
      if (configuredDocRef.current !== canvas.ownerDocument) {
        try { ctx.unconfigure(); } catch { /* already detached */ }
        const win = canvas.ownerDocument.defaultView ?? window;
        const fresh = canvas.getContext('webgpu');
        if (!fresh) return;
        const newFormat = win.navigator.gpu.getPreferredCanvasFormat();
        fresh.configure({ device, format: newFormat, alphaMode: 'opaque' });
        ctxRef.current = fresh;
        formatRef.current = newFormat;
        configuredDocRef.current = canvas.ownerDocument;
        const rebuiltRenderer = createSceneRenderer(device, newFormat, {
          entities: [{ geometry, material, transform: identity(), tint: identityTint() }],
        });
        resourcesRef.current = { renderer: rebuiltRenderer, geometry };
        ctx = fresh;
        r = resourcesRef.current;
      }

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
      r.renderer.render({
        encoder,
        colorView: ctx.getCurrentTexture().createView(),
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
      destroyGeometry(geometry);
      resourcesRef.current = null;
      renderRef.current = () => {};
    };
  }, [device, material, shape, popoutGen]);

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
