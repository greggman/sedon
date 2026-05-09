import { useEffect, useRef, useState } from 'react';
import { evaluateGraph } from '../core/evaluate.js';
import type { GeometryValue, MaterialValue } from '../core/resources.js';
import { createCoreNodeRegistry } from '../nodes/index.js';
import { initWebGPU, type GpuContext } from '../render/device.js';
import { multiply, perspective, rotationX, rotationY, translation } from '../render/mat4.js';
import { createSceneRenderer } from '../render/scene.js';
import { useEditorStore } from './store.js';

const registry = createCoreNodeRegistry();

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [gpu, setGpu] = useState<GpuContext | null>(null);

  const graph = useEditorStore((s) => s.graph);
  const rootNodeId = useEditorStore((s) => s.rootNodeId);
  const setEvalResult = useEditorStore((s) => s.setEvalResult);

  // 1. Initialize WebGPU exactly once when the canvas is mounted.
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
        if (!cancelled) setGpu(ctx);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(e);
        setError(msg);
      });

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, []);

  // 2. On graph change (and once GPU is up), re-evaluate and run the render loop.
  useEffect(() => {
    if (!gpu) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const { device, context, format } = gpu;
    let cancelled = false;
    let rafId = 0;

    try {
      const result = evaluateGraph(graph, registry, {
        rootNodeId,
        context: { device },
      });
      const geometry = result.outputs.geometry as GeometryValue;
      const material = result.outputs.material as MaterialValue;
      setEvalResult({ geometry, material });

      const renderer = createSceneRenderer(device, format, geometry, material);

      let depthTexture: GPUTexture | null = null;
      let lastWidth = 0;
      let lastHeight = 0;
      const start = performance.now();

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

        const t = (performance.now() - start) / 1000;
        const aspect = canvas.width / canvas.height;
        const projection = perspective((60 * Math.PI) / 180, aspect, 0.1, 100);
        const modelView = multiply(
          multiply(translation(0, 0, -3), rotationX(0.4)),
          rotationY(t * 0.5),
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(e);
      setError(msg);
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [gpu, graph, rootNodeId, setEvalResult]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
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
