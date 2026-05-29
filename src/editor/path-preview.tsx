import { useEffect, useRef } from 'react';
import type { PathValue } from '../core/resources.js';

// Top-down preview of a Path polyline. Drops the Y component and
// renders the XZ projection onto a 2D canvas, auto-framed to the
// path's bounding box. Doesn't need WebGPU — a polyline rendered with
// `stroke()` is more honest about what a Path actually is than
// shoehorning it through a fragment shader would be.
//
// Visuals:
//   • subtle background grid for spatial reference
//   • the path drawn as a thick translucent band the width of `path.width`
//   • the centreline overlaid on top
//   • each sample point as a small dot

interface PathPreviewProps {
  path: PathValue;
  size?: number;
}

export function PathPreview({ path, size = 256 }: PathPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Background card colour matches the docs preview chrome.
    ctx.fillStyle = '#22222a';
    ctx.fillRect(0, 0, size, size);

    if (path.count < 2) {
      ctx.fillStyle = '#888';
      ctx.font = '11px system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('(empty path)', size / 2, size / 2);
      return;
    }

    // Auto-frame: XZ bounds of all samples + the path's stroke half-
    // width on each side, so a thick path doesn't clip at the edges.
    let minX = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < path.count; i++) {
      const x = path.samples[i * 3]!;
      const z = path.samples[i * 3 + 2]!;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const halfW = path.width * 0.5;
    minX -= halfW; maxX += halfW;
    minZ -= halfW; maxZ += halfW;

    // Keep the projection square so a path running mostly along X
    // doesn't visually stretch into a thin line — pick the larger
    // extent and inflate the smaller one to match.
    const extentX = maxX - minX;
    const extentZ = maxZ - minZ;
    const extent = Math.max(extentX, extentZ, 0.001);
    const cx = (minX + maxX) * 0.5;
    const cz = (minZ + maxZ) * 0.5;
    const pad = 12;
    const drawSize = size - pad * 2;
    const scale = drawSize / extent;
    // World → canvas: world XZ centred on (cx, cz) maps to canvas (pad..size-pad).
    // Flip Z so +Z renders down (matches a top-down "looking from +Y" view).
    const toX = (x: number) => pad + drawSize * 0.5 + (x - cx) * scale;
    const toY = (z: number) => pad + drawSize * 0.5 + (z - cz) * scale;

    // Background grid: 1-world-unit cells, axis-aligned, soft.
    ctx.strokeStyle = '#2f2f38';
    ctx.lineWidth = 1;
    const gridFirstX = Math.ceil(minX);
    const gridLastX = Math.floor(maxX);
    for (let gx = gridFirstX; gx <= gridLastX; gx++) {
      ctx.beginPath();
      ctx.moveTo(toX(gx), pad);
      ctx.lineTo(toX(gx), size - pad);
      ctx.stroke();
    }
    const gridFirstZ = Math.ceil(minZ);
    const gridLastZ = Math.floor(maxZ);
    for (let gz = gridFirstZ; gz <= gridLastZ; gz++) {
      ctx.beginPath();
      ctx.moveTo(pad, toY(gz));
      ctx.lineTo(size - pad, toY(gz));
      ctx.stroke();
    }

    // Path band: full width, semi-transparent. Round joins/caps so
    // sharp control-point corners read as smooth rather than pointy.
    ctx.strokeStyle = 'rgba(136, 136, 170, 0.35)';
    ctx.lineWidth = Math.max(2, path.width * scale);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(toX(path.samples[0]!), toY(path.samples[2]!));
    for (let i = 1; i < path.count; i++) {
      ctx.lineTo(toX(path.samples[i * 3]!), toY(path.samples[i * 3 + 2]!));
    }
    ctx.stroke();

    // Centreline: thin, opaque white. Reads as the "where the path
    // is" guide even when the band's transparency washes out.
    ctx.strokeStyle = '#ebebee';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(toX(path.samples[0]!), toY(path.samples[2]!));
    for (let i = 1; i < path.count; i++) {
      ctx.lineTo(toX(path.samples[i * 3]!), toY(path.samples[i * 3 + 2]!));
    }
    ctx.stroke();

    // Sample-point dots, but only every Nth (the spline resampler
    // emits many — drawing them all would clutter the line). N tuned
    // so we always get roughly the same dot density regardless of
    // samples_per_segment.
    const skip = Math.max(1, Math.floor(path.count / 24));
    ctx.fillStyle = '#88a';
    for (let i = 0; i < path.count; i += skip) {
      const x = toX(path.samples[i * 3]!);
      const y = toY(path.samples[i * 3 + 2]!);
      ctx.beginPath();
      ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [path, size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: 'block' }}
    />
  );
}
