import { useEffect, useRef } from 'react';
import type { Texture2DValue } from '../core/resources.js';
import blitShader from './blit.wgsl';

interface BlitCache {
  pipeline: GPURenderPipeline;
  format: GPUTextureFormat;
  sampler: GPUSampler;
}

const cacheByDevice = new WeakMap<GPUDevice, BlitCache>();

function getBlit(device: GPUDevice, format: GPUTextureFormat): BlitCache {
  const cached = cacheByDevice.get(device);
  if (cached && cached.format === format) return cached;
  const module = device.createShaderModule({ code: blitShader });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module },
    fragment: { module, targets: [{ format }] },
  });
  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const fresh: BlitCache = { pipeline, format, sampler };
  cacheByDevice.set(device, fresh);
  return fresh;
}

interface TexturePreviewProps {
  device: GPUDevice;
  value: Texture2DValue;
  size?: number;
}

export function TexturePreview({ device, value, size = 128 }: TexturePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<GPUCanvasContext | null>(null);
  const formatRef = useRef<GPUTextureFormat | null>(null);

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

  // Blit whenever the source texture changes.
  useEffect(() => {
    const ctx = ctxRef.current;
    const format = formatRef.current;
    if (!ctx || !format) return;
    const { pipeline, sampler } = getBlit(device, format);
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: value.texture },
        { binding: 1, resource: sampler },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: ctx.getCurrentTexture(),
          clearValue: [0, 0, 0, 1],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  }, [device, value]);

  const dpr = window.devicePixelRatio || 1;
  return (
    <canvas
      ref={canvasRef}
      className="sedon-texture-preview"
      width={Math.round(size * dpr)}
      height={Math.round(size * dpr)}
      style={{ width: size, height: size }}
    />
  );
}
