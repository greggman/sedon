// Minimal column-major 4x4 matrix helpers. Matrices are 16-element Float32Arrays.

export type Mat4 = Float32Array;

export function identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

// Reverse-Z perspective: maps view-space depth zNear → NDC z = 1, zFar → 0.
// Paired with `depthCompare: 'greater'` and `depthClearValue: 0`. The win is
// precision: floating-point depth distributes precision logarithmically near
// 0, and the perspective divide also concentrates samples near the far plane,
// so reverse-Z aligns the two and gives roughly uniform precision across the
// frustum (no z-fighting on distant geometry).
//
// For zFar = Infinity the matrix becomes the "infinite far reverse-Z" form,
// where m[10] = 0 and m[14] = zNear — clip.z = zNear, w = -view.z, so
// ndc.z = zNear/p which never quite reaches 0 but stays well-behaved.
export function perspective(fovYRadians: number, aspect: number, zNear: number, zFar: number): Mat4 {
  const m = new Float32Array(16);
  const f = Math.tan(Math.PI * 0.5 - 0.5 * fovYRadians);

  m[0]  = f / aspect;
  m[5]  = f;
  m[11] = -1;

  if (Number.isFinite(zFar)) {
    const rangeInv = 1 / (zFar - zNear);
    m[10] = zNear * rangeInv;
    m[14] = zFar * zNear * rangeInv;
  } else {
    m[10] = 0;
    m[14] = zNear;
  }

  return m;
}

export function translation(x: number, y: number, z: number): Mat4 {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
}

export function rotationY(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = identity();
  m[0] = c;  m[2] = s;
  m[8] = -s; m[10] = c;
  return m;
}

export function rotationX(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = identity();
  m[5] = c;  m[6] = s;
  m[9] = -s; m[10] = c;
  return m;
}

export function rotationZ(rad: number): Mat4 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const m = identity();
  m[0] = c;  m[1] = s;
  m[4] = -s; m[5] = c;
  return m;
}

// out = a * b (column-major)
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        sum += a[row + k * 4]! * b[k + col * 4]!;
      }
      out[row + col * 4] = sum;
    }
  }
  return out;
}
