import { useCallback, useEffect, useRef } from 'react';
import type { GeometryValue } from '../core/resources.js';
import { lookAt, multiply, perspective } from '../render/mat4.js';
import wireframeShader from './mesh-preview.wgsl';

// Small static preview of a Geometry mesh, rendered as a wireframe. Used
// by the docs page so any node that outputs a Geometry has something
// visual in the preview pane.
//
// Wireframe via barycentrics: in the vertex shader, each vertex within a
// triangle gets a barycentric coordinate of (1,0,0) | (0,1,0) | (0,0,1)
// based on its position within the triangle (vertex_index % 3). The
// fragment shader interpolates those, then the minimum of the three is
// the distance to the nearest edge — fwidth + smoothstep gives a clean
// pixel-aligned line.
//
// Caveat: the trick relies on every triangle having distinct vertices,
// so we expand the indexed mesh into a non-indexed triangle list at
// mount. The resulting buffer is up to 3× the size of the original
// positions buffer, but we only build it for the preview — the source
// geometry stays indexed for the editor's main canvas.

interface MeshPreviewProps {
  device: GPUDevice;
  geometry: GeometryValue;
  /**
   * When true, the canvas captures pointer drags (orbit yaw + pitch
   * around the mesh centre) and wheel events (zoom distance). Defaults
   * to false so callers that just want a static snapshot stay
   * non-interactive.
   */
  interactive?: boolean;
}

// The canvas always fills its parent container — a ResizeObserver
// keeps the drawing buffer (and the depth texture) in sync with the
// CSS box. Callers that want a fixed size wrap us in a sized div.

interface PipelineCache {
  pipeline: GPURenderPipeline;
  format: GPUTextureFormat;
}
const pipelineByDevice = new WeakMap<GPUDevice, PipelineCache>();

function getPipeline(device: GPUDevice, format: GPUTextureFormat): GPURenderPipeline {
  const cached = pipelineByDevice.get(device);
  if (cached && cached.format === format) return cached.pipeline;
  const module = device.createShaderModule({ code: wireframeShader });
  const pipeline = device.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
        },
      ],
    },
    fragment: {
      module,
      entryPoint: 'fs_main',
      targets: [{
        format,
        blend: {
          color: {
            srcFactor: 'one',
            dstFactor: 'one-minus-src-alpha'
          },
          alpha: {
            srcFactor: 'one',
            dstFactor: 'one-minus-src-alpha'
          },
        },
      }],
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: {
      // Reverse-Z to match the rest of the project. The depth attachment
      // clears to 0 (= far) and the pass uses `greater` so nearer
      // fragments win. Without depth, back-facing triangles would draw
      // their edges over front-facing ones and the silhouette would
      // look like a confused tangle.
      format: 'depth32float',
      depthWriteEnabled: true,
      depthCompare: 'greater',
    },
  });
  pipelineByDevice.set(device, { pipeline, format });
  return pipeline;
}

// Expand an indexed triangle-list mesh into a non-indexed one. Output
// has `indices.length` vertices; every three consecutive vertices form
// a triangle that originally referenced indices[i], indices[i+1],
// indices[i+2].
function expandIndexed(positions: Float32Array, indices: Uint32Array): Float32Array {
  const out = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i++) {
    const src = indices[i]! * 3;
    const dst = i * 3;
    out[dst]     = positions[src]!;
    out[dst + 1] = positions[src + 1]!;
    out[dst + 2] = positions[src + 2]!;
  }
  return out;
}

// Axis-aligned bounding box from a positions buffer. Used to pick a
// camera distance that frames the whole mesh regardless of authored
// scale — a 0.1m wisp and a 200m terrain both render full-canvas.
function aabb(positions: Float32Array): { center: [number, number, number]; radius: number } {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const dx = maxX - cx, dy = maxY - cy, dz = maxZ - cz;
  const radius = Math.max(0.001, Math.hypot(dx, dy, dz));
  return { center: [cx, cy, cz], radius };
}

export function MeshPreview({
  device, geometry, interactive = false,
}: MeshPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<GPUCanvasContext | null>(null);
  const formatRef = useRef<GPUTextureFormat | null>(null);
  const vbufRef = useRef<GPUBuffer | null>(null);
  const ubufRef = useRef<GPUBuffer | null>(null);
  const depthRef = useRef<GPUTexture | null>(null);
  const bindGroupRef = useRef<GPUBindGroup | null>(null);
  const vertexCountRef = useRef(0);
  // Camera state — angles and a base auto-fit distance. User drag
  // mutates yaw/pitch; wheel scales `distScale` against the base.
  // Reset whenever a new geometry mounts so the preview re-frames.
  const centerRef = useRef<[number, number, number]>([0, 0, 0]);
  const radiusRef = useRef(1);
  const yawRef = useRef(0);
  const pitchRef = useRef(0);
  const distScaleRef = useRef(1);

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

  // Stable draw function that reads from camera refs each call. Used
  // both by the geometry-change effect (initial paint) and by the
  // gesture handlers below (orbit / zoom).
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const canvas = canvasRef.current;
    const ctx = ctxRef.current;
    const format = formatRef.current;
    const vbuf = vbufRef.current;
    const ubuf = ubufRef.current;
    const depth = depthRef.current;
    const bindGroup = bindGroupRef.current;
    if (!canvas || !ctx || !format || !vbuf || !ubuf || !depth || !bindGroup) return;

    const radius = radiusRef.current;
    const center = centerRef.current;
    const yaw = yawRef.current;
    const pitch = pitchRef.current;
    const baseDist = radius * 2.4;
    const dist = baseDist * distScaleRef.current;
    // Eye position from yaw/pitch around the mesh centre. yaw=0,
    // pitch=0 looks down -Z; matches the auto-frame's old (1, 0.7, 1)
    // direction when yaw and pitch are seeded from atan2 below.
    const ex = center[0] + dist * Math.cos(pitch) * Math.sin(yaw);
    const ey = center[1] + dist * Math.sin(pitch);
    const ez = center[2] + dist * Math.cos(pitch) * Math.cos(yaw);
    const view = lookAt([ex, ey, ez], center, [0, 1, 0]);
    const aspect = canvas.width / canvas.height;
    const near = Math.max(0.01, radius * 0.05);
    const far = dist + radius * 4;
    const proj = perspective((45 * Math.PI) / 180, aspect, near, far);
    const mvp = multiply(proj, view);

    const uniformData = new Float32Array(24);
    uniformData.set(mvp, 0);
    uniformData.set([0.25, 0.5, 1, 1], 16);
    uniformData.set([0.25, 1, 0.5, 1], 20);
    device.queue.writeBuffer(ubuf, 0, uniformData as BufferSource);

    const pipeline = getPipeline(device, format);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: ctx.getCurrentTexture().createView(),
        loadOp: 'clear',
        storeOp: 'store',
        clearValue: [0.13, 0.13, 0.15, 1],
      }],
      depthStencilAttachment: {
        view: depth.createView(),
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vbuf);
    pass.draw(vertexCountRef.current);
    pass.end();
    device.queue.submit([encoder.finish()]);
  };

  // Build resources + reset camera on geometry / size change. The
  // device-context effect above must have run first; we rely on its
  // refs being populated.
  useEffect(() => {
    const ctx = ctxRef.current;
    const format = formatRef.current;
    if (!ctx || !format) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const mesh = geometry.mesh;
    if (!mesh || mesh.indices.length === 0) {
      // GPU-only meshes (compute-built grass, etc.) don't carry CPU
      // data — bail. Caller's UI typically replaces us with a
      // "no preview" fallback; render a single clear frame so we
      // don't flash stale pixels.
      const enc = device.createCommandEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: ctx.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0.13, 0.13, 0.15, 1],
        }],
      });
      pass.end();
      device.queue.submit([enc.finish()]);
      return;
    }

    const expanded = expandIndexed(mesh.positions, mesh.indices);
    vertexCountRef.current = mesh.indices.length;

    const vbuf = device.createBuffer({
      size: expanded.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vbuf, 0, expanded as BufferSource);
    vbufRef.current = vbuf;

    const ubuf = device.createBuffer({
      size: 24 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    ubufRef.current = ubuf;

    const pipeline = getPipeline(device, format);
    bindGroupRef.current = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: ubuf } }],
    });

    const depth = device.createTexture({
      size: [canvas.width, canvas.height],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    depthRef.current = depth;

    // Auto-frame camera. The original viewing angle was the unit
    // direction (1, 0.7, 1) from the centre, which in yaw/pitch is
    // atan2(1, 1) ≈ 0.785 and atan2(0.7, √2) ≈ 0.46. Seed the camera
    // refs with those so the initial paint looks identical to v1.
    const { center, radius } = aabb(mesh.positions);
    centerRef.current = center;
    radiusRef.current = radius;
    yawRef.current = Math.atan2(1, 1);
    pitchRef.current = Math.atan2(0.7, Math.SQRT2);
    distScaleRef.current = 1;

    drawRef.current();

    return () => {
      vbuf.destroy();
      ubuf.destroy();
      depth.destroy();
      if (vbufRef.current === vbuf) vbufRef.current = null;
      if (ubufRef.current === ubuf) ubufRef.current = null;
      if (depthRef.current === depth) depthRef.current = null;
      bindGroupRef.current = null;
    };
  }, [device, geometry]);

  // Pointer-drag orbit + wheel zoom. Sensitivity matches ScenePreview's
  // interactive mode. Pitch clamped just inside (−π/2, π/2) to avoid
  // gimbal flip at the poles.
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
  }, [interactive]);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const last = lastPointerRef.current;
    if (!last) return;
    const dx = e.clientX - last.x;
    const dy = e.clientY - last.y;
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
    yawRef.current -= dx * 0.007;
    pitchRef.current = Math.max(
      -Math.PI / 2 + 0.01,
      Math.min(Math.PI / 2 - 0.01, pitchRef.current - dy * 0.007),
    );
    drawRef.current();
  }, [interactive]);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!interactive) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    lastPointerRef.current = null;
  }, [interactive]);
  // Track CSS box changes via ResizeObserver, resize the drawing
  // buffer to match, recreate the depth texture at the new
  // dimensions (the reverse-Z pass needs depth sized to the colour
  // attachment), then redraw. The projection's aspect is recomputed
  // from canvas.width / canvas.height each draw so it adapts
  // automatically.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.max(1, Math.round(entry.contentRect.width * dpr));
      const h = Math.max(1, Math.round(entry.contentRect.height * dpr));
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      // Depth texture must match the colour attachment dimensions.
      const oldDepth = depthRef.current;
      depthRef.current = device.createTexture({
        size: [w, h],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      });
      oldDepth?.destroy();
      drawRef.current();
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [device]);

  // Wheel handler attached as a NATIVE DOM listener with
  // `{ passive: false }` so preventDefault() actually works. React's
  // onWheel registers a passive listener by default; calling
  // preventDefault from inside it is silently ignored, so the docs
  // page would scroll under the user's cursor while they tried to
  // zoom the preview.
  useEffect(() => {
    if (!interactive) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      const next = distScaleRef.current * (1 + e.deltaY * 0.001);
      distScaleRef.current = Math.max(0.1, Math.min(10, next));
      drawRef.current();
    };
    canvas.addEventListener('wheel', onWheelNative, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', onWheelNative);
    };
  }, [interactive]);

  return (
    <canvas
      ref={canvasRef}
      // 1×1 initial buffer; the ResizeObserver brings it to the
      // actual CSS box on the first frame.
      width={1}
      height={1}
      style={{
        width: '100%',
        height: '100%',
        display: 'block',
        // touch-action: none stops mobile/trackpad scroll from
        // hijacking our pointer drags. cursor reflects affordance.
        ...(interactive ? { touchAction: 'none', cursor: 'grab' } : {}),
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
