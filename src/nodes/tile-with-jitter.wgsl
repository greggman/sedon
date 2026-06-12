struct Params {
  // tile divisions across the output (cells x, cells y).
  divisions: vec2f,
  // 0..1: how much each tile may be offset within its cell.
  position_jitter: f32,
  // 0..1: how much each tile may be rotated. 1 = full ±π.
  rotation_jitter: f32,
  // 0..1: how much each tile's size may vary around 1.
  scale_jitter: f32,
  // 0..1: how much each tile's hue may shift. 0 = no shift.
  hue_jitter: f32,
  // hash seed.
  seed: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) i: u32) -> VsOut {
  let x = f32(i & 1u) * 4.0 - 1.0;
  let y = f32(i >> 1u) * 4.0 - 1.0;
  var out: VsOut;
  out.position = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return out;
}

fn hash21(p: vec2f, salt: f32) -> f32 {
  return fract(sin(dot(p + salt, vec2f(127.1, 311.7))) * 43758.5453123);
}

fn rgb_to_hsv(c: vec3f) -> vec3f {
  let K = vec4f(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  let p = mix(vec4f(c.bg, K.wz), vec4f(c.gb, K.xy), step(c.b, c.g));
  let q = mix(vec4f(p.xyw, c.r), vec4f(c.r, p.yzx), step(p.x, c.r));
  let d = q.x - min(q.w, q.y);
  let e = 1.0e-10;
  return vec3f(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

fn hsv_to_rgb(c: vec3f) -> vec3f {
  let K = vec4f(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  let p = abs(fract(vec3f(c.x) + K.xyz) * 6.0 - vec3f(K.w));
  return c.z * mix(vec3f(K.x), clamp(p - vec3f(K.x), vec3f(0.0), vec3f(1.0)), c.y);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Which tile we're in.
  let scaled = in.uv * params.divisions;
  let cell = floor(scaled);
  // Local coord within the cell, in [0, 1].
  let cell_uv = fract(scaled);

  // Three different hashes for three different per-tile params.
  let h_pos_x = hash21(cell, params.seed +  0.31);
  let h_pos_y = hash21(cell, params.seed + 11.71);
  let h_rot   = hash21(cell, params.seed + 23.39);
  let h_scale = hash21(cell, params.seed + 37.13);
  let h_hue   = hash21(cell, params.seed + 53.91);

  // Inverse the per-tile transform: the cell_uv is the *output* point
  // inside the cell; we ask "what point on the stamp maps here?".
  // Centre on the cell middle so rotation/scale happen around the
  // stamp centre.
  var p = cell_uv - 0.5;

  // Inverse position jitter — shift the stamp by jitter, so the
  // sample point shifts opposite.
  let pos_jitter = vec2f(h_pos_x - 0.5, h_pos_y - 0.5) * params.position_jitter;
  p = p - pos_jitter;

  // Inverse rotation.
  let angle = (h_rot - 0.5) * params.rotation_jitter * 6.28318530717958647692;
  let c = cos(-angle);
  let s = sin(-angle);
  p = vec2f(c * p.x - s * p.y, s * p.x + c * p.y);

  // Inverse scale. Jitter > 0 makes some tiles smaller (sample point
  // closer to centre, stamp appears bigger). We clamp 1+jitter to
  // avoid division blow-up.
  let scl = max(1.0 + (h_scale - 0.5) * params.scale_jitter * 2.0, 0.05);
  p = p / scl;

  // Back to [0, 1] sample uv on the source stamp.
  let sample_uv = p + 0.5;

  var c4 = textureSample(src, samp, sample_uv);

  if (params.hue_jitter > 0.0) {
    var hsv = rgb_to_hsv(c4.rgb);
    hsv.x = fract(hsv.x + (h_hue - 0.5) * params.hue_jitter);
    c4 = vec4f(hsv_to_rgb(hsv), c4.a);
  }
  return c4;
}
