// Procedural path/road mask. Draws a single meandering path across the
// texture and returns a grayscale coverage mask. By default it's
// INVERTED (white everywhere EXCEPT the path) so you can multiply it
// straight into a density map to carve the path bare:
//   grassDensity = coverageNoise × pathMask   →   no grass on the path.
// Flip `invert` to get white-on-path (1 on the path, 0 off) for the
// road surface itself.

struct Params {
  cfg0: vec4f, // angle(rad), offset(0..1 across), width, waviness(amplitude)
  cfg1: vec4f, // waveScale(freq), softness(edge AA), invert(>0.5), pad
};
@group(0) @binding(0) var<uniform> p: Params;

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  let x = f32(i & 1u) * 4.0 - 1.0;
  let y = f32(i >> 1u) * 4.0 - 1.0;
  var o: VsOut;
  o.pos = vec4f(x, y, 0.0, 1.0);
  o.uv = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return o;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let angle = p.cfg0.x;
  let offset = p.cfg0.y;
  let width = p.cfg0.z;
  let waviness = p.cfg0.w;
  let waveScale = p.cfg1.x;
  let softness = max(p.cfg1.y, 1e-4);
  let invert = p.cfg1.z;

  // Rotate UV about the center so the path can run at any angle. `across`
  // is the axis perpendicular to the path; `along` runs down its length.
  let c = cos(angle);
  let s = sin(angle);
  let q = in.uv - vec2f(0.5, 0.5);
  let across = q.x * c - q.y * s + 0.5;
  let along = q.x * s + q.y * c + 0.5;

  // Meandering centerline + distance to it.
  let cx = offset + waviness * sin(along * waveScale * 6.2831853);
  let dist = abs(across - cx);
  let onPath = 1.0 - smoothstep(width - softness, width, dist);

  let v = mix(onPath, 1.0 - onPath, step(0.5, invert));
  return vec4f(v, v, v, 1.0);
}
