// 2D curve sampler. Authors a polyline through control points with
// per-point handle types (AUTO / CORNER / FREE / ALIGNED) and emits a
// sampled polyline in the XY plane (z = 0 for every output sample).
// Consumers like `core/lathe` and `core/extrude-on-path` take the
// polyline as their profile / cross-section input.
//
// Why a separate node from `path/spline`:
//   • `path/spline` does uniform Catmull-Rom across every control
//     point — every point is "smooth." That's fine for road / river
//     authoring where there are no kinks. It's the wrong default for
//     a turned-leg silhouette where you WANT sharp transitions
//     between bulges + smooth curves between them.
//   • This sampler honours per-point handle types: AUTO points get
//     Catmull-Rom-style auto-tangents; CORNER points get zero-length
//     tangents (a kink); FREE / ALIGNED points use explicit user-
//     authored tangent handles like Blender / Houdini / Illustrator.
//   • Output is the existing `Path` type with z = 0, so the same
//     downstream consumers (`core/lathe`, `core/extrude-on-path`)
//     accept it natively.
//
// Data shape: each control point is a numeric tuple
//   `[x, handleType, y, leftDx, leftDy, rightDx, rightDy]`.
// This 7-number per-anchor layout is a strict extension of the
// previous `[x, handleType, y]` form — indices 0..2 are unchanged so
// the existing 2D point-list editor's "horizontal=index 0, vertical=
// index 2" convention still applies, and old saved data (3-number
// tuples) parses identically. The trailing four numbers are the
// left- and right-handle DELTAS from the anchor (in world units).
// They're consulted only when handleType is FREE or ALIGNED — AUTO
// and CORNER ignore them and recompute (or zero) the tangents on the
// fly, so converting a point from AUTO to FREE doesn't snap the
// curve the moment the user toggles the type.

export const HANDLE_AUTO = 0;
export const HANDLE_CORNER = 1;
export const HANDLE_FREE = 2;
export const HANDLE_ALIGNED = 3;

// Back-compat alias: the original constant exported by this module
// was `HANDLE_SMOOTH`. Same numeric code (0) — keep the name available
// for any callers we haven't migrated yet.
export const HANDLE_SMOOTH = HANDLE_AUTO;

export interface Curve2DPoint {
  x: number;
  y: number;
  handleType: number;
  // Per-anchor explicit handle deltas. Used by FREE / ALIGNED; the
  // sampler IGNORES these for AUTO (recomputes Catmull-Rom) and CORNER
  // (forces zero). Always stored relative to the anchor. Optional so
  // AUTO / CORNER points (which never need them) can be constructed
  // without boilerplate — `readCurve2DPoints` always emits all four.
  leftDx?: number;
  leftDy?: number;
  rightDx?: number;
  rightDy?: number;
}

export interface Curve2DOptions {
  samplesPerSegment?: number;
  /** When true, the last point connects back to the first as a closed
   *  loop. */
  closed?: boolean;
}

function normaliseHandleType(raw: number): number {
  if (raw === HANDLE_CORNER) return HANDLE_CORNER;
  if (raw === HANDLE_FREE) return HANDLE_FREE;
  if (raw === HANDLE_ALIGNED) return HANDLE_ALIGNED;
  return HANDLE_AUTO;
}

function safeNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Read a `Vec3[]`-style inputValue (the shape the `point-list` widget
 * stores) into `Curve2DPoint`s. Tuple order is
 * `[x, handleType, y, leftDx, leftDy, rightDx, rightDy]` — indices
 * 0..2 match the editor's 3-number convention; 3..6 (handle deltas)
 * are optional and default to 0 for back-compat with the original
 * 3-number tuples.
 */
export function readCurve2DPoints(value: unknown): Curve2DPoint[] {
  if (!Array.isArray(value)) return [];
  const out: Curve2DPoint[] = [];
  for (const p of value) {
    if (!Array.isArray(p) || p.length < 3) continue;
    const x = safeNum(p[0]);
    const y = safeNum(p[2]);
    const handleType = normaliseHandleType(safeNum(p[1]));
    const leftDx = safeNum(p[3]);
    const leftDy = safeNum(p[4]);
    const rightDx = safeNum(p[5]);
    const rightDy = safeNum(p[6]);
    out.push({ x, y, handleType, leftDx, leftDy, rightDx, rightDy });
  }
  return out;
}

/**
 * Sample the curve into a polyline. Output samples include the start
 * and end points exactly (no clipping at the seam in open curves).
 *
 * Algorithm: every inter-point segment is a cubic Bezier where:
 *   • B0 = anchor a
 *   • B1 = a + a.rightHandle
 *   • B2 = b + b.leftHandle (handle delta points BACK from anchor b)
 *   • B3 = anchor b
 * For AUTO points, the handles are recomputed Catmull-Rom-style:
 * right = (next - prev) / 6, left = -right. For CORNER points both
 * handles collapse to zero (degenerates the Bezier into a straight
 * line into the corner — the visible "kink" the user wants). For FREE
 * and ALIGNED points the stored deltas are used verbatim — the
 * sampler doesn't enforce the ALIGNED collinearity constraint; that's
 * the editor's job at drag time.
 */
export function sampleCurve2D(
  points: ReadonlyArray<Curve2DPoint>,
  options: Curve2DOptions = {},
): Float32Array {
  const samplesPerSegment = Math.max(1, Math.floor(options.samplesPerSegment ?? 16));
  const closed = options.closed ?? false;
  const n = points.length;
  if (n < 2) return new Float32Array(0);

  // Neighbour lookup with end-clamp for open curves, wrap for closed.
  const neighbour = (i: number, direction: 1 | -1): Curve2DPoint => {
    if (closed) return points[((i + direction) % n + n) % n]!;
    if (i + direction < 0) return points[0]!;
    if (i + direction >= n) return points[n - 1]!;
    return points[i + direction]!;
  };

  // Per-anchor resolved handle deltas. The fields stored on the
  // Curve2DPoint are the authored values; for AUTO / CORNER we
  // OVERRIDE them here so the sampler doesn't have to branch in the
  // segment loop.
  const resolved: { lx: number; ly: number; rx: number; ry: number }[] = [];
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    if (p.handleType === HANDLE_CORNER) {
      resolved.push({ lx: 0, ly: 0, rx: 0, ry: 0 });
      continue;
    }
    if (p.handleType === HANDLE_FREE || p.handleType === HANDLE_ALIGNED) {
      resolved.push({
        lx: p.leftDx ?? 0, ly: p.leftDy ?? 0,
        rx: p.rightDx ?? 0, ry: p.rightDy ?? 0,
      });
      continue;
    }
    // AUTO (default): Catmull-Rom-style tangent. (next - prev) / 6 — the
    // /2 is the Catmull-Rom velocity, the further /3 converts that
    // parametric tangent into the Bezier control-point delta. The
    // LEFT handle is the same magnitude in the opposite direction so
    // the curve passes smoothly through the anchor.
    const prev = neighbour(i, -1);
    const next = neighbour(i, +1);
    const rx = (next.x - prev.x) / 6;
    const ry = (next.y - prev.y) / 6;
    resolved.push({ lx: -rx, ly: -ry, rx, ry });
  }

  const segments = closed ? n : n - 1;
  const totalSamples = segments * samplesPerSegment + (closed ? 0 : 1);
  const out = new Float32Array(totalSamples * 3);
  let cursor = 0;
  for (let s = 0; s < segments; s++) {
    const a = points[s]!;
    const b = points[(s + 1) % n]!;
    const ar = resolved[s]!;
    const bl = resolved[(s + 1) % n]!;
    // B1 = a + a's right handle. B2 = b + b's left handle (the left
    // handle ALREADY points back from the anchor in our convention,
    // so we add, not subtract).
    const b1x = a.x + ar.rx;
    const b1y = a.y + ar.ry;
    const b2x = b.x + bl.lx;
    const b2y = b.y + bl.ly;
    for (let i = 0; i < samplesPerSegment; i++) {
      const t = i / samplesPerSegment;
      const u = 1 - t;
      const u2 = u * u;
      const u3 = u2 * u;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = u3 * a.x + 3 * u2 * t * b1x + 3 * u * t2 * b2x + t3 * b.x;
      const y = u3 * a.y + 3 * u2 * t * b1y + 3 * u * t2 * b2y + t3 * b.y;
      out[cursor]     = x;
      out[cursor + 1] = y;
      out[cursor + 2] = 0;
      cursor += 3;
    }
  }
  if (!closed) {
    // Emit the final endpoint exactly (otherwise we'd stop one step
    // short because the inner loop runs t < 1).
    const last = points[n - 1]!;
    out[cursor]     = last.x;
    out[cursor + 1] = last.y;
    out[cursor + 2] = 0;
  }
  return out;
}

/**
 * Compute the resolved-on-the-fly handle deltas for an anchor that's
 * in AUTO mode, given its neighbours. Exposed so the editor can show
 * faint preview handles for AUTO points (matching what the sampler
 * uses) and so the type-cycle UI can "bake" the current AUTO handles
 * into stored FREE / ALIGNED deltas without a visible jump.
 */
export function autoHandleDeltas(
  prev: { x: number; y: number },
  next: { x: number; y: number },
): { leftDx: number; leftDy: number; rightDx: number; rightDy: number } {
  const rx = (next.x - prev.x) / 6;
  const ry = (next.y - prev.y) / 6;
  return { leftDx: -rx, leftDy: -ry, rightDx: rx, rightDy: ry };
}
