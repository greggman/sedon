import type { Texture2DValue } from '../core/resources.js';
import type { CpuMesh } from './mesh.js';

// Read back a heightfield texture from the GPU. R channel is decoded
// into a Float32Array of heights — already in world units (metres),
// no remap required (texture-map-range upstream is what scales [0,1]
// noise into real altitudes). Supports both rgba8unorm (heights live
// in [0, 1]) and rgba16float (the typical terrain-authoring format).
//
// Async because GPU readback requires waiting on a staging buffer to map.
export async function readHeightTexture(
  device: GPUDevice,
  texture: Texture2DValue,
): Promise<{ heights: Float32Array; width: number; height: number }> {
  const { width, height, format } = texture;
  const bytesPerPixel =
    format === 'rgba16float' ? 8 :
    format === 'rgba8unorm' ? 4 :
    -1;
  if (bytesPerPixel < 0) {
    throw new Error(`readHeightTexture: unsupported format ${format}`);
  }
  // bytesPerRow must be a multiple of 256 for copyTextureToBuffer.
  const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;

  const staging = device.createBuffer({
    label: 'heightfield-readback-staging',
    size: bytesPerRow * height,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const encoder = device.createCommandEncoder({ label: 'heightfield-readback' });
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
  if (format === 'rgba8unorm') {
    for (let y = 0; y < height; y++) {
      const rowOffset = y * bytesPerRow;
      const dstRow = y * width;
      for (let x = 0; x < width; x++) {
        // R channel only; remap 0..255 → 0..1.
        heights[dstRow + x] = bytes[rowOffset + x * 4]! / 255;
      }
    }
  } else {
    // rgba16float — decode the R channel as IEEE 754 half-float.
    const u16 = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
    const u16PerRow = bytesPerRow >> 1;
    for (let y = 0; y < height; y++) {
      const rowOffset = y * u16PerRow;
      const dstRow = y * width;
      for (let x = 0; x < width; x++) {
        heights[dstRow + x] = halfToFloat(u16[rowOffset + x * 4]!);
      }
    }
  }

  return { heights, width, height };
}

// IEEE 754 binary16 → binary32 decoder.
function halfToFloat(h: number): number {
  const sign = (h & 0x8000) >> 15;
  const exp = (h & 0x7C00) >> 10;
  const frac = h & 0x03FF;
  if (exp === 0) {
    if (frac === 0) return sign ? -0 : 0;
    return (sign ? -1 : 1) * Math.pow(2, -14) * (frac / 1024);
  }
  if (exp === 0x1F) {
    return frac === 0
      ? (sign ? -Infinity : Infinity)
      : NaN;
  }
  return (sign ? -1 : 1) * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

// Bilinear sample of a heights field at normalized (u, v). Values are
// passed through as-is (the caller provides them in whatever units
// they want — metres for the new model, [0, 1] for legacy rgba8unorm
// sources).
export function sampleHeightfield(
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
  divX: number;
  divZ: number;
}

// Convert a heights array (in world units, metres) to a tessellated
// XZ-plane mesh displaced by height. Plane is centered at origin;
// X axis spans [-w/2, +w/2], Z spans [-d/2, +d/2]. Vertex normals are
// computed from local height gradients (central differences) for
// smooth shading. CCW winding from +Y so back-face culling drops the
// underside.
export function heightfieldToMesh(p: HeightfieldToMeshParams): CpuMesh {
  const { heights, width, height, worldSize, divX, divZ } = p;
  const w = worldSize[0];
  const d = worldSize[1];

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
      const h = sampleHeightfield(heights, width, height, u01, v);

      positions[pi] = x;
      positions[pi + 1] = h;
      positions[pi + 2] = z;

      // Normal from central differences. Edge cells use one-sided differences
      // by clamping inside sampleHeightfield.
      const uL = Math.max(0, u01 - 1 / divX);
      const uR = Math.min(1, u01 + 1 / divX);
      const vD = Math.max(0, v - 1 / divZ);
      const vU = Math.min(1, v + 1 / divZ);
      const hL = sampleHeightfield(heights, width, height, uL, v);
      const hR = sampleHeightfield(heights, width, height, uR, v);
      const hDz = sampleHeightfield(heights, width, height, u01, vD);
      const hUz = sampleHeightfield(heights, width, height, u01, vU);
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
