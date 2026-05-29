import { useEffect, useRef } from 'react';
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
  size?: number;
}

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
      targets: [{ format }],
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

export function MeshPreview({ device, geometry, size = 256 }: MeshPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) return;
    const format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({ device, format, alphaMode: 'opaque' });

    const mesh = geometry.mesh;
    if (!mesh || mesh.indices.length === 0) {
      // GPU-only meshes (compute-built grass, etc.) don't carry CPU
      // data — bail. The docs preview falls back to a "no preview"
      // message; rendering a single clear frame here would just flash
      // an empty box for a moment.
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
    const vertexCount = mesh.indices.length;

    const vbuf = device.createBuffer({
      size: expanded.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(vbuf, 0, expanded as BufferSource);

    // Auto-frame: position the camera along (1, 0.7, 1) at 2.4× the
    // mesh's bounding-sphere radius. Looking back at the centre, fov=45°.
    const { center, radius } = aabb(mesh.positions);
    const dist = radius * 2.4;
    const dir: [number, number, number] = [1, 0.7, 1];
    const dlen = Math.hypot(dir[0], dir[1], dir[2]);
    const eye: [number, number, number] = [
      center[0] + (dir[0] / dlen) * dist,
      center[1] + (dir[1] / dlen) * dist,
      center[2] + (dir[2] / dlen) * dist,
    ];
    const view = lookAt(eye, center, [0, 1, 0]);
    const aspect = canvas.width / canvas.height;
    const near = Math.max(0.01, radius * 0.05);
    const far = dist + radius * 4;
    const proj = perspective((45 * Math.PI) / 180, aspect, near, far);
    const mvp = multiply(proj, view);

    // Uniform layout: mat4 mvp (64B), vec4 bg (16B), vec4 line (16B).
    const uniformData = new Float32Array(24);
    uniformData.set(mvp, 0);
    uniformData.set([0.13, 0.13, 0.15, 1], 16); // bg — matches the docs preview card
    uniformData.set([0.92, 0.92, 0.96, 1], 20); // line — soft off-white

    const ubuf = device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(ubuf, 0, uniformData as BufferSource);

    const pipeline = getPipeline(device, format);
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: ubuf } }],
    });

    const depth = device.createTexture({
      size: [canvas.width, canvas.height],
      format: 'depth32float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });

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
        depthClearValue: 0, // reverse-Z: clear to far
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, vbuf);
    pass.draw(vertexCount);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return () => {
      vbuf.destroy();
      ubuf.destroy();
      depth.destroy();
    };
  }, [device, geometry, size]);

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{ width: size, height: size, display: 'block' }}
    />
  );
}
