import { useEffect, useRef } from 'react';
import type { Texture2DValue } from '../core/resources.js';
import blitShader from './blit.wgsl';
import { subscribeRender } from './render-bus.js';

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
  // Memoized bind group keyed on the source GPUTexture handle. Most
  // upstream nodes use `reusableTexture` which preserves the underlying
  // GPUTexture across edits even when the wrapping Texture2DValue
  // object is recreated each eval — so a fresh `value` prop with the
  // same `value.texture` handle should reuse the bind group instead of
  // creating one per edit. With one TexturePreview per node-with-a-
  // texture-output in a canvas, that's a lot of churn otherwise.
  const bindGroupRef = useRef<{ tex: GPUTexture; bg: GPUBindGroup } | null>(null);

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
      bindGroupRef.current = null;
    };
  }, [device]);

  // Stable draw via ref. Used by both the value-change effect (initial
  // paint, texture-handle swap) and the render-bus subscription (so a
  // colorize/blend node mutating its output GPUTexture in place pokes
  // every in-node TexturePreview to re-blit even when the wrapping
  // `value` prop is unchanged).
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const ctx = ctxRef.current;
    const format = formatRef.current;
    if (!ctx || !format) return;
    const { pipeline, sampler } = getBlit(device, format);
    let bindGroup = bindGroupRef.current;
    if (!bindGroup || bindGroup.tex !== value.texture) {
      bindGroup = {
        tex: value.texture,
        bg: device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: value.texture },
            { binding: 1, resource: sampler },
          ],
        }),
      };
      bindGroupRef.current = bindGroup;
    }
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
    pass.setBindGroup(0, bindGroup.bg);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };

  useEffect(() => {
    drawRef.current();
  }, [device, value]);

  useEffect(() => subscribeRender(() => drawRef.current()), []);

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
