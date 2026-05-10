import type { Texture2DValue } from '../core/resources.js';
import type { CpuMesh } from './mesh.js';

// Read back a heightfield's texture from the GPU and return its R channel as
// a [0, 1] Float32Array. Async because GPU readback requires waiting on a
// staging buffer to map. Texture is assumed to be rgba8unorm (the format used
// by every texture node).
export async function readHeightTexture(
  device: GPUDevice,
  texture: Texture2DValue,
): Promise<{ heights: Float32Array; width: number; height: number }> {
  const { width, height } = texture;
  // bytesPerRow must be a multiple of 256 for copyTextureToBuffer.
  const bytesPerRow = Math.ceil((width * 4) / 256) * 256;

  const staging = device.createBuffer({
    size: bytesPerRow * height,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture: texture.texture },
    { buffer: staging, bytesPerRow, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  );
  device.queue.submit([encoder.finish()]);

  await staging.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(staging.getMappedRange()).slice();
  staging.unmap();
  staging.destroy();

  const heights = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * bytesPerRow;
    const dstRow = y * width;
    for (let x = 0; x < width; x++) {
      // R channel only; remap 0..255 → 0..1.
      heights[dstRow + x] = bytes[rowOffset + x * 4]! / 255;
    }
  }

  return { heights, width, height };
}

// Bilinear sample of a [0,1] heights field at normalized (u, v).
export function sampleHeightfield01(
  heights: Float32Array,
  width: number,
  height: number,
  u: number,
  v: number,
): number {
  const x = Math.max(0, Math.min(1, u)) * (width - 1);
  const y = Math.max(0, Math.min(1, v)) * (height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const h00 = heights[y0 * width + x0]!;
  const h10 = heights[y0 * width + x1]!;
  const h01 = heights[y1 * width + x0]!;
  const h11 = heights[y1 * width + x1]!;
  const a = h00 + fx * (h10 - h00);
  const b = h01 + fx * (h11 - h01);
  return a + fy * (b - a);
}

interface HeightfieldToMeshParams {
  heights: Float32Array;
  width: number;
  height: number;
  worldSize: [number, number];
  heightRange: [number, number];
  divX: number;
  divZ: number;
}

// Convert a heights array to a tessellated XZ-plane mesh displaced by height.
// Plane is centered at origin; X axis spans [-w/2, +w/2], Z spans [-d/2, +d/2].
// Vertex normals are computed from local height gradients (central
// differences) for smooth shading. CCW winding from +Y so back-face culling
// drops the underside.
export function heightfieldToMesh(p: HeightfieldToMeshParams): CpuMesh {
  const { heights, width, height, worldSize, heightRange, divX, divZ } = p;
  const w = worldSize[0];
  const d = worldSize[1];
  const [hMin, hMax] = heightRange;
  const range = hMax - hMin;

  const numX = divX + 1;
  const numZ = divZ + 1;
  const numVerts = numX * numZ;

  const positions = new Float32Array(numVerts * 3);
  const normals = new Float32Array(numVerts * 3);
  const uvs = new Float32Array(numVerts * 2);

  let pi = 0;
  let ui = 0;
  for (let zi = 0; zi <= divZ; zi++) {
    const v = zi / divZ;
    for (let xi = 0; xi <= divX; xi++) {
      const u01 = xi / divX;
      const x = (u01 - 0.5) * w;
      const z = (v - 0.5) * d;
      const h = hMin + sampleHeightfield01(heights, width, height, u01, v) * range;

      positions[pi] = x;
      positions[pi + 1] = h;
      positions[pi + 2] = z;

      // Normal from central differences. Edge cells use one-sided differences
      // by clamping inside sampleHeightfield01.
      const uL = Math.max(0, u01 - 1 / divX);
      const uR = Math.min(1, u01 + 1 / divX);
      const vD = Math.max(0, v - 1 / divZ);
      const vU = Math.min(1, v + 1 / divZ);
      const hL = hMin + sampleHeightfield01(heights, width, height, uL, v) * range;
      const hR = hMin + sampleHeightfield01(heights, width, height, uR, v) * range;
      const hDz = hMin + sampleHeightfield01(heights, width, height, u01, vD) * range;
      const hUz = hMin + sampleHeightfield01(heights, width, height, u01, vU) * range;
      const tX = (uR - uL) * w;
      const tZ = (vU - vD) * d;
      const nx = -(hR - hL) * tZ;
      const ny = tX * tZ;
      const nz = -(hUz - hDz) * tX;
      const nlen = Math.hypot(nx, ny, nz) || 1;
      normals[pi] = nx / nlen;
      normals[pi + 1] = ny / nlen;
      normals[pi + 2] = nz / nlen;

      uvs[ui] = u01;
      uvs[ui + 1] = 1 - v;
      pi += 3;
      ui += 2;
    }
  }

  const indices = new Uint32Array(divX * divZ * 6);
  let i = 0;
  for (let zi = 0; zi < divZ; zi++) {
    for (let xi = 0; xi < divX; xi++) {
      const a = zi * numX + xi;
      const b = a + numX;
      indices[i++] = a;
      indices[i++] = b;
      indices[i++] = a + 1;
      indices[i++] = b;
      indices[i++] = b + 1;
      indices[i++] = a + 1;
    }
  }

  return { positions, normals, uvs, indices };
}
