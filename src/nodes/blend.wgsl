struct Params {
  factor: f32,
  // 0=mix, 1=add, 2=multiply, 3=screen, 4=overlay, 5=difference,
  // 6=color-dodge, 7=color-burn, 8=lighten (max), 9=darken (min),
  // 10=subtract, 11=soft-light, 12=hard-light.
  mode: f32,
};

// Photoshop's overlay: multiply below 0.5, screen above. Continuous at
// the seam.
fn overlay_ch(a: f32, b: f32) -> f32 {
  if (a < 0.5) {
    return 2.0 * a * b;
  }
  return 1.0 - 2.0 * (1.0 - a) * (1.0 - b);
}

fn soft_light_ch(a: f32, b: f32) -> f32 {
  // Photoshop's soft-light (the "(1-2b)" formulation).
  if (b < 0.5) {
    return a - (1.0 - 2.0 * b) * a * (1.0 - a);
  }
  let d = select(
    ((16.0 * a - 12.0) * a + 4.0) * a,
    sqrt(a),
    a > 0.25,
  );
  return a + (2.0 * b - 1.0) * (d - a);
}

fn hard_light_ch(a: f32, b: f32) -> f32 {
  // Symmetric to overlay but driven by b: multiply when b<0.5, screen
  // when b>0.5.
  if (b < 0.5) {
    return 2.0 * a * b;
  }
  return 1.0 - 2.0 * (1.0 - a) * (1.0 - b);
}

fn color_dodge_ch(a: f32, b: f32) -> f32 {
  // a / (1 - b), guarded against divide-by-zero.
  if (b >= 0.999) {
    return 1.0;
  }
  return min(a / (1.0 - b), 1.0);
}

fn color_burn_ch(a: f32, b: f32) -> f32 {
  if (b <= 0.001) {
    return 0.0;
  }
  return 1.0 - min((1.0 - a) / b, 1.0);
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var tex_a: texture_2d<f32>;
@group(0) @binding(2) var tex_b: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

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

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let a = textureSample(tex_a, samp, in.uv);
  let b = textureSample(tex_b, samp, in.uv);

  // Branch on a uniform value keeps control flow uniform across the
  // wave, so the texture samples above stay valid. saturate() clamps
  // ADD's result so values can't blow up beyond 1 in rgba8unorm.
  let mode = i32(params.mode + 0.5);
  if (mode == 1) {
    // Add: a + b × factor. factor=1 is plain saturation-add; factor<1
    // gates how much b contributes.
    return saturate(a + b * params.factor);
  }
  if (mode == 2) {
    // Multiply: a × mix(1, b, factor). factor=1 is plain multiply;
    // factor<1 weakens b's contribution (closer to passing a through).
    return a * mix(vec4f(1.0), b, params.factor);
  }
  if (mode == 3) {
    // Screen: 1 − (1 − a)(1 − b × factor). Brightens — opposite of
    // multiply.
    let b_scaled = b * params.factor;
    return vec4f(1.0) - (vec4f(1.0) - a) * (vec4f(1.0) - b_scaled);
  }
  if (mode == 4) {
    // Overlay: per-channel multiply/screen split at 0.5 of base.
    let blended = vec4f(
      overlay_ch(a.r, b.r),
      overlay_ch(a.g, b.g),
      overlay_ch(a.b, b.b),
      a.a,
    );
    return mix(a, blended, params.factor);
  }
  if (mode == 5) {
    // Difference: |a − b|. Symmetric, useful for diffs/compares.
    return mix(a, abs(a - b), params.factor);
  }
  if (mode == 6) {
    // Color dodge: brightens; classic "glow" feel from b lifting a.
    let blended = vec4f(
      color_dodge_ch(a.r, b.r),
      color_dodge_ch(a.g, b.g),
      color_dodge_ch(a.b, b.b),
      a.a,
    );
    return mix(a, blended, params.factor);
  }
  if (mode == 7) {
    // Color burn: darkens; deep shadow effect.
    let blended = vec4f(
      color_burn_ch(a.r, b.r),
      color_burn_ch(a.g, b.g),
      color_burn_ch(a.b, b.b),
      a.a,
    );
    return mix(a, blended, params.factor);
  }
  if (mode == 8) {
    // Lighten: per-channel max(a, b).
    return mix(a, max(a, b), params.factor);
  }
  if (mode == 9) {
    // Darken: per-channel min(a, b).
    return mix(a, min(a, b), params.factor);
  }
  if (mode == 10) {
    // Subtract: a − b × factor, clamped.
    return saturate(a - b * params.factor);
  }
  if (mode == 11) {
    // Soft light: like overlay but gentler — good for tone-mapping.
    let blended = vec4f(
      soft_light_ch(a.r, b.r),
      soft_light_ch(a.g, b.g),
      soft_light_ch(a.b, b.b),
      a.a,
    );
    return mix(a, blended, params.factor);
  }
  if (mode == 12) {
    // Hard light: overlay driven by b, harsher contrast.
    let blended = vec4f(
      hard_light_ch(a.r, b.r),
      hard_light_ch(a.g, b.g),
      hard_light_ch(a.b, b.b),
      a.a,
    );
    return mix(a, blended, params.factor);
  }
  // Default (mix): standard linear interpolation.
  return mix(a, b, params.factor);
}
