import { initWebGPU } from './render/device.js';
import { generateSphere } from './render/sphere.js';
import { createSpherePipeline } from './render/pipeline.js';
import { multiply, perspective, rotationX, rotationY, translation } from './render/mat4.js';
import shaderCode from './render/shader.wgsl';

function showError(message: string) {
  const el = document.getElementById('error');
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
  }
  console.error(message);
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
  const pipeline = createSpherePipeline(device, format, shaderCode);

  const sphere = generateSphere(1, 64, 32);

  // Cast to BufferSource: TS 5.7+'s ArrayBufferLike parameterization on TypedArrays
  // doesn't match @webgpu/types' GPUAllowSharedBufferSource. Runtime is fine.
  const writeBuf = (buf: GPUBuffer, offset: number, data: ArrayBufferView) =>
    device.queue.writeBuffer(buf, offset, data as BufferSource);

  const positionBuffer = device.createBuffer({
    size: sphere.positions.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  writeBuf(positionBuffer, 0, sphere.positions);

  const normalBuffer = device.createBuffer({
    size: sphere.normals.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  writeBuf(normalBuffer, 0, sphere.normals);

  const indexBuffer = device.createBuffer({
    size: sphere.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  writeBuf(indexBuffer, 0, sphere.indices);

  const uniformBuffer = device.createBuffer({
    size: 128, // two mat4x4<f32>
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

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
    const proj = perspective((60 * Math.PI) / 180, aspect, 0.1, 100);
    const modelView = multiply(
      multiply(translation(0, 0, -3), rotationX(0.4)),
      rotationY(t * 0.5),
    );

    writeBuf(uniformBuffer, 0, modelView);
    writeBuf(uniformBuffer, 64, proj);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.08, g: 0.08, b: 0.1, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: depthTexture!.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, positionBuffer);
    pass.setVertexBuffer(1, normalBuffer);
    pass.setIndexBuffer(indexBuffer, 'uint32');
    pass.drawIndexed(sphere.indices.length);
    pass.end();
    device.queue.submit([encoder.finish()]);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch((err) => {
  showError(err instanceof Error ? `${err.message}\n\n${err.stack ?? ''}` : String(err));
});
