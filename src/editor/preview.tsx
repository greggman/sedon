import { useEffect, useRef, useState } from 'react';
import { evaluateGraph } from '../core/evaluate.js';
import type { GeometryValue, MaterialValue } from '../core/resources.js';
import { createCoreNodeRegistry } from '../nodes/index.js';
import { initWebGPU, type GpuContext } from '../render/device.js';
import { multiply, perspective, rotationX, rotationY, translation } from '../render/mat4.js';
import { createSceneRenderer } from '../render/scene.js';
import { useEditorStore } from './store.js';

const registry = createCoreNodeRegistry();

interface OrbitCamera {
  yaw: number;
  pitch: number;
  distance: number;
}

const DEFAULT_CAMERA: OrbitCamera = {
  yaw: 0,
  pitch: 0.4,
  distance: 3,
};

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [gpu, setGpu] = useState<GpuContext | null>(null);

  // Camera lives in a ref so the render loop reads fresh values without
  // restarting on every drag.
  const cameraRef = useRef<OrbitCamera>({ ...DEFAULT_CAMERA });

  const graph = useEditorStore((s) => s.graph);
  const rootNodeId = useEditorStore((s) => s.rootNodeId);
  const setEvalResult = useEditorStore((s) => s.setEvalResult);
  const setDevice = useEditorStore((s) => s.setDevice);

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
    let lastX = 0;
    let lastY = 0;

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      dragging = true;
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
      const sens = 0.005;
      cam.yaw += dx * sens;
      cam.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, cam.pitch + dy * sens));
    };
    const onPointerUp = (e: PointerEvent) => {
      dragging = false;
      canvas.releasePointerCapture(e.pointerId);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = cameraRef.current;
      const factor = Math.exp(e.deltaY * 0.001);
      cam.distance = Math.max(0.5, Math.min(50, cam.distance * factor));
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

      const geometry = result.outputs.geometry as GeometryValue;
      const material = result.outputs.material as MaterialValue;
      setEvalResult({ geometry, material, allOutputs: result.allOutputs });

      const renderer = createSceneRenderer(device, format, geometry, material);

      let depthTexture: GPUTexture | null = null;
      let lastWidth = 0;
      let lastHeight = 0;

      const frame = () => {
        if (cancelled) return;
        if (canvas.width !== lastWidth || canvas.height !== lastHeight) {
          depthTexture?.destroy();
          depthTexture = device.createTexture({
            size: [canvas.width, canvas.height],
            format: 'depth24plus',
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });
          lastWidth = canvas.width;
          lastHeight = canvas.height;
        }

        const aspect = canvas.width / canvas.height;
        const projection = perspective((60 * Math.PI) / 180, aspect, 0.1, 100);
        const cam = cameraRef.current;
        const modelView = multiply(
          multiply(translation(0, 0, -cam.distance), rotationX(cam.pitch)),
          rotationY(cam.yaw),
        );

        const encoder = device.createCommandEncoder();
        renderer.render({
          encoder,
          colorView: context.getCurrentTexture().createView(),
          depthView: depthTexture!.createView(),
          clearColor: { r: 0.06, g: 0.06, b: 0.08, a: 1 },
          modelView,
          projection,
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
  }, [gpu, graph, rootNodeId, setEvalResult]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          touchAction: 'none',
          cursor: 'grab',
        }}
      />
      {error !== null && (
        <div
          style={{
            position: 'absolute',
            top: '1rem',
            left: '1rem',
            right: '1rem',
            padding: '1rem',
            background: '#5a1a1a',
            border: '1px solid #a44',
            borderRadius: 4,
            whiteSpace: 'pre-wrap',
            fontFamily: 'monospace',
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
