import { useEffect, useRef } from 'react';
import type { Texture2DValue } from '../core/resources.js';
import autoLevelShader from './texture-auto-level.wgsl';
import blitShader from './blit.wgsl';
import { subscribeRender } from './render-bus.js';

// Whether a format carries values outside [0, 1] in the natural display
// sense (HDR colour, heightfields in metres, signed normal data, etc.).
// The plain blit saturates these to a flat block; we route them through
// the min/max reduction + leveling blit instead.
function isAutoLevelFormat(format: GPUTextureFormat): boolean {
  // Any float storage — rgba16float is the one Sedon authors today,
  // but a future rgba32float would Just Work through the same path.
  return format.includes('float');
}

interface PlainBlitCache {
  pipeline: GPURenderPipeline;
  format: GPUTextureFormat;
  sampler: GPUSampler;
}

interface AutoLevelCache {
  resetPipeline: GPUComputePipeline;
  reducePipeline: GPUComputePipeline;
  blitPipeline: GPURenderPipeline;
  format: GPUTextureFormat;
  sampler: GPUSampler;
}

// One cache per device per output format. The output format is the
// canvas's preferred format (set in TexturePreview's mount effect); it
// changes effectively never, so this WeakMap rarely sees more than one
// entry per device.
const plainCacheByDevice = new WeakMap<GPUDevice, PlainBlitCache>();
const autoLevelCacheByDevice = new WeakMap<GPUDevice, AutoLevelCache>();

function getPlainBlit(device: GPUDevice, format: GPUTextureFormat): PlainBlitCache {
  const cached = plainCacheByDevice.get(device);
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
  const fresh: PlainBlitCache = { pipeline, format, sampler };
  plainCacheByDevice.set(device, fresh);
  return fresh;
}

function getAutoLevel(device: GPUDevice, format: GPUTextureFormat): AutoLevelCache {
  const cached = autoLevelCacheByDevice.get(device);
  if (cached && cached.format === format) return cached;
  const module = device.createShaderModule({ code: autoLevelShader });
  const resetPipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'reset' },
  });
  const reducePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'reduce' },
  });
  const blitPipeline = device.createRenderPipeline({
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
  const fresh: AutoLevelCache = { resetPipeline, reducePipeline, blitPipeline, format, sampler };
  autoLevelCacheByDevice.set(device, fresh);
  return fresh;
}

interface TexturePreviewProps {
  device: GPUDevice;
  value: Texture2DValue;
  /**
   * Square size in CSS px. Mutually exclusive with `width` / `height`;
   * defaults to 128 when none are provided. Use the explicit
   * `width` / `height` pair for non-square canvases (e.g. a flexible
   * popup backdrop).
   */
  size?: number;
  width?: number;
  height?: number;
}

interface AutoLevelResources {
  tex: GPUTexture;
  buffer: GPUBuffer;
  resetBindGroup: GPUBindGroup;
  reduceBindGroup: GPUBindGroup;
  blitBindGroup: GPUBindGroup;
}

interface PlainResources {
  tex: GPUTexture;
  blitBindGroup: GPUBindGroup;
}

export function TexturePreview({ device, value, size, width, height }: TexturePreviewProps) {
  const w = width ?? size ?? 128;
  const h = height ?? size ?? 128;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<GPUCanvasContext | null>(null);
  const formatRef = useRef<GPUTextureFormat | null>(null);
  // Two per-source-texture caches, picked based on whether the source
  // format needs auto-leveling. Most upstream nodes use `reusableTexture`
  // which preserves the underlying GPUTexture across edits even when the
  // wrapping Texture2DValue object is recreated each eval — so a fresh
  // `value` prop with the same `value.texture` handle should reuse the
  // resources instead of allocating per edit. With one TexturePreview per
  // node-with-a-texture-output in a canvas, that's a lot of churn
  // otherwise.
  const autoLevelResRef = useRef<AutoLevelResources | null>(null);
  const plainResRef = useRef<PlainResources | null>(null);

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
      autoLevelResRef.current?.buffer.destroy();
      autoLevelResRef.current = null;
      plainResRef.current = null;
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
    const canvasFormat = formatRef.current;
    if (!ctx || !canvasFormat) return;

    const encoder = device.createCommandEncoder();
    const colorTex = ctx.getCurrentTexture();
    colorTex.label = 'TexturePreview canvas';

    if (isAutoLevelFormat(value.format)) {
      const cache = getAutoLevel(device, canvasFormat);
      let res = autoLevelResRef.current;
      if (!res || res.tex !== value.texture) {
        // New source texture: destroy the previous buffer (if any) and
        // build a fresh pair of bind groups bound to the new texture.
        autoLevelResRef.current?.buffer.destroy();
        const buffer = device.createBuffer({
          size: 8,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        });
        const resetBindGroup = device.createBindGroup({
          layout: cache.resetPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 1, resource: buffer },
          ],
        });
        const reduceBindGroup = device.createBindGroup({
          layout: cache.reducePipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: value.texture },
            { binding: 1, resource: buffer },
          ],
        });
        const blitBindGroup = device.createBindGroup({
          layout: cache.blitPipeline.getBindGroupLayout(0),
          entries: [
            { binding: 2, resource: value.texture },
            { binding: 3, resource: cache.sampler },
            { binding: 4, resource: buffer },
          ],
        });
        res = { tex: value.texture, buffer, resetBindGroup, reduceBindGroup, blitBindGroup };
        autoLevelResRef.current = res;
      }

      // Reset sentinels + reduce in one compute pass. Doing the reset
      // here (instead of via writeBuffer) keeps everything inside the
      // encoder so the ordering is unambiguous.
      const cpass = encoder.beginComputePass();
      cpass.setPipeline(cache.resetPipeline);
      cpass.setBindGroup(0, res.resetBindGroup);
      cpass.dispatchWorkgroups(1);
      cpass.setPipeline(cache.reducePipeline);
      cpass.setBindGroup(0, res.reduceBindGroup);
      cpass.dispatchWorkgroups(
        Math.ceil(value.width / 8),
        Math.ceil(value.height / 8),
      );
      cpass.end();

      const rpass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: colorTex,
            clearValue: [0, 0, 0, 1],
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      rpass.setPipeline(cache.blitPipeline);
      rpass.setBindGroup(0, res.blitBindGroup);
      rpass.draw(3);
      rpass.end();
    } else {
      const cache = getPlainBlit(device, canvasFormat);
      let res = plainResRef.current;
      if (!res || res.tex !== value.texture) {
        const blitBindGroup = device.createBindGroup({
          layout: cache.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: value.texture },
            { binding: 1, resource: cache.sampler },
          ],
        });
        res = { tex: value.texture, blitBindGroup };
        plainResRef.current = res;
      }
      const rpass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: colorTex,
            clearValue: [0, 0, 0, 1],
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      rpass.setPipeline(cache.pipeline);
      rpass.setBindGroup(0, res.blitBindGroup);
      rpass.draw(3);
      rpass.end();
    }

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
      width={Math.round(w * dpr)}
      height={Math.round(h * dpr)}
      style={{ width: w, height: h }}
    />
  );
}
