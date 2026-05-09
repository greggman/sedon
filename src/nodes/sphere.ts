import type { NodeDef } from '../core/node-def.js';
import type { GeometryValue } from '../core/resources.js';
import { requireDevice } from '../core/resources.js';
import { generateSphere } from '../render/sphere.js';

export const sphereNode: NodeDef = {
  id: 'core/sphere',
  category: 'Geometry/Primitives',
  inputs: [
    { name: 'radius', type: 'Float', default: 1 },
    { name: 'segments', type: 'Int', default: 32 },
    { name: 'rings', type: 'Int', default: 16 },
  ],
  outputs: [{ name: 'geometry', type: 'Geometry' }],
  evaluate(ctx, inputs): { geometry: GeometryValue } {
    const device = requireDevice(ctx);
    const mesh = generateSphere(
      inputs.radius as number,
      inputs.segments as number,
      inputs.rings as number,
    );

    const positionBuffer = device.createBuffer({
      size: mesh.positions.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(positionBuffer, 0, mesh.positions as BufferSource);

    const normalBuffer = device.createBuffer({
      size: mesh.normals.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(normalBuffer, 0, mesh.normals as BufferSource);

    const uvBuffer = device.createBuffer({
      size: mesh.uvs.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uvBuffer, 0, mesh.uvs as BufferSource);

    const indexBuffer = device.createBuffer({
      size: mesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(indexBuffer, 0, mesh.indices as BufferSource);

    return {
      geometry: {
        positionBuffer,
        normalBuffer,
        uvBuffer,
        indexBuffer,
        indexCount: mesh.indices.length,
        indexFormat: 'uint32',
      },
    };
  },
};
