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

// Reverse-Z orthographic projection: maps view-space view.z = -near → clip.z = 1
// (near plane), view.z = -far → clip.z = 0 (far plane). Same depth convention as
// the perspective projection above so they can share one depth attachment.
//
// Use for the shadow pass: the light is treated as a directional camera with
// an orthographic frustum sized to cover the shadow extent.
export function orthographic(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): Mat4 {
  const m = new Float32Array(16);
  m[0]  = 2 / (right - left);
  m[5]  = 2 / (top - bottom);
  // Reverse-Z: clip.z = (view.z + far) / (far - near).
  m[10] = 1 / (far - near);
  m[12] = -(right + left) / (right - left);
  m[13] = -(top + bottom) / (top - bottom);
  m[14] = far / (far - near);
  m[15] = 1;
  return m;
}

// Right-handed lookAt: builds a world→view matrix where view +X = right,
// view +Y = up, view -Z = direction from eye toward target. Used to build
// the light's view matrix for the shadow pass.
export function lookAt(
  eye: [number, number, number],
  target: [number, number, number],
  up: [number, number, number],
): Mat4 {
  // forward = direction from eye toward target.
  let fx = target[0] - eye[0];
  let fy = target[1] - eye[1];
  let fz = target[2] - eye[2];
  const flen = Math.hypot(fx, fy, fz);
  fx /= flen; fy /= flen; fz /= flen;
  // right = forward × up (then normalize).
  let rx = fy * up[2] - fz * up[1];
  let ry = fz * up[0] - fx * up[2];
  let rz = fx * up[1] - fy * up[0];
  const rlen = Math.hypot(rx, ry, rz);
  rx /= rlen; ry /= rlen; rz /= rlen;
  // up = right × forward (orthonormalized).
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  // Rows of the rotation block are (right, up, -forward), stored in
  // column-major form. Translation column = -basis · eye (rotates eye to
  // origin in view space).
  const m = new Float32Array(16);
  m[0]  = rx;  m[1]  = ux;  m[2]  = -fx;
  m[4]  = ry;  m[5]  = uy;  m[6]  = -fy;
  m[8]  = rz;  m[9]  = uz;  m[10] = -fz;
  m[12] = -(rx * eye[0] + ry * eye[1] + rz * eye[2]);
  m[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  m[14] =  (fx * eye[0] + fy * eye[1] + fz * eye[2]);
  m[15] = 1;
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
