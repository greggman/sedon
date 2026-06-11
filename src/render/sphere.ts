export interface SphereMesh {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  indices: Uint32Array;
}

/**
 * Generate a (partial-range) UV-sphere mesh.
 *
 * Convention:
 *   • Y axis is up. The north pole is at (0, +radius, 0).
 *   • Longitude θ runs 0..2π around the equator (Y-axis as pole).
 *   • Latitude  φ runs −π/2..+π/2 with −π/2 at the south pole and
 *     +π/2 at the north pole — the standard geographic convention.
 *
 * Defaults reproduce a closed full sphere. Restricting any of the
 * four range fields trims that quadrant off; with `cap: true` (the
 * default) the resulting top + bottom open boundaries are closed
 * with flat triangle-fan discs (or pie slices, when longitude is
 * also windowed). The longitude-side boundaries are LEFT OPEN even
 * when `cap` is true — they're rarely useful as flat planes (the
 * common "fruit slice" look wants the inside visible).
 */
export interface GenerateSphereOpts {
  radius: number;
  /** Longitudinal subdivisions across the windowed θ range. */
  segments: number;
  /** Latitudinal subdivisions across the windowed φ range. */
  rings: number;
  /** Start of the longitude window, radians. Default 0. */
  longitudeStart?: number;
  /** End of the longitude window, radians. Default 2π (full circle). */
  longitudeEnd?: number;
  /** Start of the latitude window, radians (−π/2 = south pole). Default −π/2. */
  latitudeStart?: number;
  /** End of the latitude window, radians (+π/2 = north pole). Default +π/2. */
  latitudeEnd?: number;
  /**
   * Close the windowed top and bottom open boundaries with flat
   * caps. Defaults to true. When the latitude range covers the
   * full sphere there's no top/bottom boundary to close so this
   * flag is moot. Longitude-side boundaries are never capped.
   */
  cap?: boolean;
}

export function generateSphere(opts: GenerateSphereOpts): SphereMesh {
  const radius = opts.radius;
  const segments = Math.max(2, Math.floor(opts.segments));
  const rings = Math.max(2, Math.floor(opts.rings));
  const lonStart = opts.longitudeStart ?? 0;
  const lonEnd = opts.longitudeEnd ?? 2 * Math.PI;
  const latStart = opts.latitudeStart ?? -Math.PI / 2;
  const latEnd = opts.latitudeEnd ?? Math.PI / 2;
  const cap = opts.cap ?? true;

  // Translate astronomical latitude (south → north) into the engine's
  // φ-from-north convention so the existing vertex layout (top ring
  // = first row) stays unchanged. φ = π/2 − latitude.
  const phiTop = Math.PI / 2 - latEnd;     // small φ → top
  const phiBottom = Math.PI / 2 - latStart; // large φ → bottom
  const phiSpan = phiBottom - phiTop;
  const lonSpan = lonEnd - lonStart;

  const fullLongitude = lonSpan >= 2 * Math.PI - 1e-9;
  const needTopCap = cap && phiTop > 1e-6;
  const needBottomCap = cap && phiBottom < Math.PI - 1e-6;
  // Slice caps close the longitude-side openings when the wedge is
  // partial. Each slice cap lies in a half-plane at θ = θ_start (or
  // θ_end) containing the Y axis, bounded by the great-circle arc on
  // the sphere and the Y-axis chord between the cap's top and bottom.
  const needSliceCaps = cap && !fullLongitude;

  const sideVertCount = (rings + 1) * (segments + 1);
  // Top / bottom caps each contribute one centre vertex + (segments+1)
  // rim vertices when present. We share the rim positions with the
  // surface for tighter geometry, but caps use their OWN vertices so
  // the seam between sphere and cap stays sharp (normals flip from
  // outward-radial on the surface to flat ±Y on the cap).
  const topCapV = needTopCap ? 1 + (segments + 1) : 0;
  const bottomCapV = needBottomCap ? 1 + (segments + 1) : 0;
  // Each slice cap: (rings+1) arc-duplicate vertices + (rings+1) axis
  // vertices. Two slice caps (start and end).
  const sliceCapV = needSliceCaps ? 2 * 2 * (rings + 1) : 0;
  const totalV = sideVertCount + topCapV + bottomCapV + sliceCapV;

  const positions = new Float32Array(totalV * 3);
  const normals = new Float32Array(totalV * 3);
  const uvs = new Float32Array(totalV * 2);

  let p = 0;
  let u = 0;
  for (let r = 0; r <= rings; r++) {
    const phi = phiTop + (phiSpan * r) / rings;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    for (let s = 0; s <= segments; s++) {
      // For a full longitude sweep, modulo so the seam aligns with
      // itself (matches the original code's compute-normals
      // accommodation). For a partial sweep, NO modulo — the
      // endpoints are meant to be distinct positions on a wedge.
      const rawTheta = lonStart + (lonSpan * s) / segments;
      const theta = fullLongitude
        ? rawTheta % (2 * Math.PI)
        : rawTheta;
      const x = sinPhi * Math.cos(theta);
      const y = cosPhi;
      const z = sinPhi * Math.sin(theta);
      positions[p] = x * radius;
      positions[p + 1] = y * radius;
      positions[p + 2] = z * radius;
      normals[p] = x;
      normals[p + 1] = y;
      normals[p + 2] = z;
      uvs[u] = s / segments;
      uvs[u + 1] = r / rings;
      p += 3;
      u += 2;
    }
  }

  // Indices. Surface stays the same as before — CCW from outside so
  // back-face culling drops the inside. Caps are triangle fans from
  // a centre vertex.
  const sideIndexCount = rings * segments * 6;
  const topCapIndexCount = needTopCap ? segments * 3 : 0;
  const bottomCapIndexCount = needBottomCap ? segments * 3 : 0;
  // Each slice cap: rings × 2 quads → rings × 6 indices.
  const sliceCapIndexCount = needSliceCaps ? 2 * rings * 6 : 0;
  const indices = new Uint32Array(sideIndexCount + topCapIndexCount + bottomCapIndexCount + sliceCapIndexCount);
  let i = 0;
  const stride = segments + 1;
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = r * stride + s;
      const b = a + stride;
      indices[i++] = a;
      indices[i++] = a + 1;
      indices[i++] = b;
      indices[i++] = a + 1;
      indices[i++] = b + 1;
      indices[i++] = b;
    }
  }

  // Top cap: triangle fan centred at (0, radius·cos(phiTop), 0) facing
  // +Y. Rim vertices are copies of the first ring's positions but with
  // a flat +Y normal so the cap shades as a clean disc.
  let vCursor = sideVertCount;
  if (needTopCap) {
    const yTop = radius * Math.cos(phiTop);
    const centreIdx = vCursor;
    positions[centreIdx * 3] = 0;
    positions[centreIdx * 3 + 1] = yTop;
    positions[centreIdx * 3 + 2] = 0;
    normals[centreIdx * 3] = 0;
    normals[centreIdx * 3 + 1] = 1;
    normals[centreIdx * 3 + 2] = 0;
    uvs[centreIdx * 2] = 0.5;
    uvs[centreIdx * 2 + 1] = 0.5;
    for (let s = 0; s <= segments; s++) {
      const rimIdx = vCursor + 1 + s;
      const ringIdx = 0 * stride + s; // top ring of the surface
      positions[rimIdx * 3] = positions[ringIdx * 3]!;
      positions[rimIdx * 3 + 1] = yTop;
      positions[rimIdx * 3 + 2] = positions[ringIdx * 3 + 2]!;
      normals[rimIdx * 3] = 0;
      normals[rimIdx * 3 + 1] = 1;
      normals[rimIdx * 3 + 2] = 0;
      uvs[rimIdx * 2] = 0.5 + (positions[ringIdx * 3]! / radius) * 0.5;
      uvs[rimIdx * 2 + 1] = 0.5 + (positions[ringIdx * 3 + 2]! / radius) * 0.5;
    }
    // Wind (centre, rim_{s+1}, rim_s) → +Y face normal (matches the
    // declared +Y vertex normal). Reverse of this would back-face-cull
    // the cap when viewed from above.
    for (let s = 0; s < segments; s++) {
      indices[i++] = centreIdx;
      indices[i++] = vCursor + 1 + s + 1;
      indices[i++] = vCursor + 1 + s;
    }
    vCursor += topCapV;
  }

  // Bottom cap: fan facing −Y. Wound opposite the top so it's CCW from
  // below.
  if (needBottomCap) {
    const yBottom = radius * Math.cos(phiBottom);
    const centreIdx = vCursor;
    positions[centreIdx * 3] = 0;
    positions[centreIdx * 3 + 1] = yBottom;
    positions[centreIdx * 3 + 2] = 0;
    normals[centreIdx * 3] = 0;
    normals[centreIdx * 3 + 1] = -1;
    normals[centreIdx * 3 + 2] = 0;
    uvs[centreIdx * 2] = 0.5;
    uvs[centreIdx * 2 + 1] = 0.5;
    for (let s = 0; s <= segments; s++) {
      const rimIdx = vCursor + 1 + s;
      const ringIdx = rings * stride + s; // bottom ring
      positions[rimIdx * 3] = positions[ringIdx * 3]!;
      positions[rimIdx * 3 + 1] = yBottom;
      positions[rimIdx * 3 + 2] = positions[ringIdx * 3 + 2]!;
      normals[rimIdx * 3] = 0;
      normals[rimIdx * 3 + 1] = -1;
      normals[rimIdx * 3 + 2] = 0;
      uvs[rimIdx * 2] = 0.5 + (positions[ringIdx * 3]! / radius) * 0.5;
      uvs[rimIdx * 2 + 1] = 0.5 - (positions[ringIdx * 3 + 2]! / radius) * 0.5;
    }
    // Wind (centre, rim_s, rim_{s+1}) → −Y face normal (matches the
    // declared −Y vertex normal).
    for (let s = 0; s < segments; s++) {
      indices[i++] = centreIdx;
      indices[i++] = vCursor + 1 + s;
      indices[i++] = vCursor + 1 + s + 1;
    }
    vCursor += bottomCapV;
  }

  // Slice caps: close the open boundary at θ = lonStart and θ = lonEnd
  // when longitude is partial. Each cap lies in the half-plane at
  // its θ containing the Y axis. We duplicate the arc vertices (so
  // the cap can have its own flat normal) and pair them with axis
  // vertices on the Y axis at the same Y level. Each "strip" between
  // successive rings is two triangles forming a quad
  // (arc_r, arc_{r+1}, axis_{r+1}, axis_r).
  //
  // Winding flips between start and end so each cap's face normal
  // matches the outward direction (which points to lower θ for the
  // start cap, higher θ for the end cap).
  if (needSliceCaps) {
    addSliceCap(
      'start',
      lonStart,
      radius,
      phiTop, phiSpan, rings,
      positions, normals, uvs,
      vCursor, indices, i,
    );
    const startOut = vCursor + 2 * (rings + 1);
    i += rings * 6;
    addSliceCap(
      'end',
      lonEnd,
      radius,
      phiTop, phiSpan, rings,
      positions, normals, uvs,
      startOut, indices, i,
    );
    i += rings * 6;
  }

  return { positions, normals, uvs, indices };
}

// Build one slice cap. Lays out 2*(rings+1) vertices starting at
// `vBase`: first (rings+1) arc vertices duplicated from the sphere
// surface at θ = theta (with flat outward normal), then (rings+1)
// axis vertices on the Y axis at matching Y levels. Writes rings × 2
// triangles (= rings × 6 indices) starting at `iBase`.
function addSliceCap(
  side: 'start' | 'end',
  theta: number,
  radius: number,
  phiTop: number,
  phiSpan: number,
  rings: number,
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  vBase: number,
  indices: Uint32Array,
  iBase: number,
): void {
  // Outward normal. Tangent along the slice plane in the XZ plane
  // is (cosθ, 0, sinθ); the start-side outward is that rotated 90°
  // clockwise around Y → (sinθ, 0, −cosθ). The end-side outward is
  // the opposite.
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  const nx = side === 'start' ? st : -st;
  const nz = side === 'start' ? -ct : ct;

  for (let r = 0; r <= rings; r++) {
    const phi = phiTop + (phiSpan * r) / rings;
    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    // Arc vertex (duplicates the sphere surface position).
    const arcIdx = vBase + r;
    positions[arcIdx * 3]     = radius * sinPhi * ct;
    positions[arcIdx * 3 + 1] = radius * cosPhi;
    positions[arcIdx * 3 + 2] = radius * sinPhi * st;
    normals[arcIdx * 3]     = nx;
    normals[arcIdx * 3 + 1] = 0;
    normals[arcIdx * 3 + 2] = nz;
    // Map UV: u runs 0 (at axis) to 1 (at sphere surface), v runs
    // 0..1 over the latitude range. arc verts are at u=1.
    uvs[arcIdx * 2]     = 1;
    uvs[arcIdx * 2 + 1] = r / rings;
    // Axis vertex on the Y axis at the matching Y.
    const axisIdx = vBase + (rings + 1) + r;
    positions[axisIdx * 3]     = 0;
    positions[axisIdx * 3 + 1] = radius * cosPhi;
    positions[axisIdx * 3 + 2] = 0;
    normals[axisIdx * 3]     = nx;
    normals[axisIdx * 3 + 1] = 0;
    normals[axisIdx * 3 + 2] = nz;
    uvs[axisIdx * 2]     = 0;
    uvs[axisIdx * 2 + 1] = r / rings;
  }

  let i = iBase;
  for (let r = 0; r < rings; r++) {
    const arc0 = vBase + r;
    const arc1 = vBase + r + 1;
    const axis0 = vBase + (rings + 1) + r;
    const axis1 = vBase + (rings + 1) + r + 1;
    if (side === 'start') {
      // (arc0, arc1, axis1) and (arc0, axis1, axis0) → face normal in
      // the start-side outward direction.
      indices[i++] = arc0;
      indices[i++] = arc1;
      indices[i++] = axis1;
      indices[i++] = arc0;
      indices[i++] = axis1;
      indices[i++] = axis0;
    } else {
      // Opposite winding for end side.
      indices[i++] = arc0;
      indices[i++] = axis1;
      indices[i++] = arc1;
      indices[i++] = arc0;
      indices[i++] = axis0;
      indices[i++] = axis1;
    }
  }
}
