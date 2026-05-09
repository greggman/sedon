import { evaluateGraph } from './core/evaluate.js';
import { addEdge, addNode, createGraph } from './core/graph.js';
import type { GeometryValue, MaterialValue } from './core/resources.js';
import { createCoreNodeRegistry } from './nodes/index.js';
import { initWebGPU } from './render/device.js';
import { multiply, perspective, rotationX, rotationY, translation } from './render/mat4.js';
import { createSceneRenderer } from './render/scene.js';

function showError(message: string) {
  const el = document.getElementById('error');
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
  }
  console.error(message);
}

function buildPocGraph() {
  const g = createGraph();
  const fg = addNode(g, 'core/color', { inputValues: { value: [0.05, 0.05, 0.1, 1] } });
  const bg = addNode(g, 'core/color', { inputValues: { value: [0.95, 0.85, 0.4, 1] } });
  const grid = addNode(g, 'core/grid', { inputValues: { divisions: [12, 12], line_width: 0.06 } });
  const material = addNode(g, 'core/material');
  const sphere = addNode(g, 'core/sphere', { inputValues: { radius: 1, segments: 64, rings: 32 } });
  const output = addNode(g, 'core/output');

  addEdge(g, { node: fg.id, socket: 'color' }, { node: grid.id, socket: 'fg' });
  addEdge(g, { node: bg.id, socket: 'color' }, { node: grid.id, socket: 'bg' });
  addEdge(g, { node: grid.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
  addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: output.id, socket: 'geometry' });
  addEdge(g, { node: material.id, socket: 'material' }, { node: output.id, socket: 'material' });

  return { graph: g, outputId: output.id };
}

async function main() {
  const canvasEl = document.getElementById('canvas');
  if (!(canvasEl instanceof HTMLCanvasElement)) {
    throw new Error('canvas element not found');
  }
  const canvas = canvasEl;

  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  };
  resize();
  window.addEventListener('resize', resize);

  const { device, context, format } = await initWebGPU(canvas);

  // Build and evaluate the POC graph once. Phase 3 will add re-eval on edits.
  const registry = createCoreNodeRegistry();
  const { graph, outputId } = buildPocGraph();
  const result = evaluateGraph(graph, registry, {
    rootNodeId: outputId,
    context: { device },
  });
  const geometry = result.outputs.geometry as GeometryValue;
  const material = result.outputs.material as MaterialValue;

  const renderer = createSceneRenderer(device, format, geometry, material);

  let depthTexture: GPUTexture | null = null;
  let lastWidth = 0;
  let lastHeight = 0;
  const start = performance.now();

  function frame() {
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
      clearColor: { r: 0.08, g: 0.08, b: 0.1, a: 1 },
      modelView,
      projection,
    });
    device.queue.submit([encoder.finish()]);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((err) => {
  showError(err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err));
});
