import { useEffect, useRef } from 'react';
import type { Texture2DValue } from '../core/resources.js';
import compositeShader from './leaf-skeleton-preview.wgsl';
import { subscribeRender } from './render-bus.js';

// Node-only composite preview for `leaf/skeleton`. The node has two
// Texture2D outputs (shape + veins); the generic TexturePreview only
// shows the first, so the user can't see where veins land relative to
// the silhouette. This component blits both textures into one canvas
// with the app-accent palette (off-white shape, warm-orange veins).
//
// Downstream graph wiring is unaffected — the actual node outputs are
// still the two separate greyscale textures. This is purely about what
// renders inside the node's preview slot.

interface CompositeCache {
  pipeline: GPURenderPipeline;
  format: GPUTextureFormat;
  sampler: GPUSampler;
}

const cacheByDevice = new WeakMap<GPUDevice, CompositeCache>();

function getComposite(device: GPUDevice, format: GPUTextureFormat): CompositeCache {
  const cached = cacheByDevice.get(device);
  if (cached && cached.format === format) return cached;
  const module = device.createShaderModule({ code: compositeShader });
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
  const fresh: CompositeCache = { pipeline, format, sampler };
  cacheByDevice.set(device, fresh);
  return fresh;
}

interface LeafSkeletonPreviewProps {
  device: GPUDevice;
  shape: Texture2DValue;
  veins: Texture2DValue;
  size?: number;
}

export function LeafSkeletonPreview({ device, shape, veins, size = 128 }: LeafSkeletonPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<GPUCanvasContext | null>(null);
  const formatRef = useRef<GPUTextureFormat | null>(null);
  // Memoized bind group keyed on the source GPUTexture handle pair.
  // leaf/skeleton uses reusableTexture for both outputs, so successive
  // edits typically preserve both handles and we can re-blit without
  // re-allocating the bind group.
  const bindGroupRef = useRef<{
    shapeTex: GPUTexture;
    veinsTex: GPUTexture;
    bg: GPUBindGroup;
  } | null>(null);

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

  // Stable draw via ref. Both the value-change effect and the
  // render-bus subscription call this — the latter handles upstream
  // in-place edits that don't replace the wrapping Texture2DValue.
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const ctx = ctxRef.current;
    const format = formatRef.current;
    if (!ctx || !format) return;
    const { pipeline, sampler } = getComposite(device, format);
    let bindGroup = bindGroupRef.current;
    if (
      !bindGroup
      || bindGroup.shapeTex !== shape.texture
      || bindGroup.veinsTex !== veins.texture
    ) {
      bindGroup = {
        shapeTex: shape.texture,
        veinsTex: veins.texture,
        bg: device.createBindGroup({
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: shape.texture },
            { binding: 1, resource: veins.texture },
            { binding: 2, resource: sampler },
          ],
        }),
      };
      bindGroupRef.current = bindGroup;
    }
    const encoder = device.createCommandEncoder();
    const colorTex = ctx.getCurrentTexture();
    colorTex.label = 'LeafSkeletonPreview canvas';
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: colorTex,
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
  }, [device, shape, veins]);

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
