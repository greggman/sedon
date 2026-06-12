struct Params {
  // pixel size in uv units (1 / resolution). Lets the 3×3 Sobel
  // sample neighbouring pixels at the right offset for any input size.
  pixel_size: vec2f,
  // edge intensity multiplier. 1 = raw Sobel magnitude.
  intensity: f32,
  // 0 = greyscale magnitude on rgb; 1 = signed gradient stored as
  // (dx, dy, 0) — useful as a normal-map direction source.
  mode: f32,
  edge_color: vec4f,
  bg_color: vec4f,
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

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let dx = vec2f(params.pixel_size.x, 0.0);
  let dy = vec2f(0.0, params.pixel_size.y);

  // 3×3 Sobel: sample neighbours, take per-axis weighted differences.
  let tl = luma(textureSample(src, samp, in.uv - dx - dy).rgb);
  let tc = luma(textureSample(src, samp, in.uv      - dy).rgb);
  let tr = luma(textureSample(src, samp, in.uv + dx - dy).rgb);
  let ml = luma(textureSample(src, samp, in.uv - dx     ).rgb);
  let mr = luma(textureSample(src, samp, in.uv + dx     ).rgb);
  let bl = luma(textureSample(src, samp, in.uv - dx + dy).rgb);
  let bc = luma(textureSample(src, samp, in.uv      + dy).rgb);
  let br = luma(textureSample(src, samp, in.uv + dx + dy).rgb);

  let gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  let gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);

  let mode = i32(params.mode + 0.5);
  if (mode == 1) {
    // Signed gradient mode: pack (dx, dy) into rg, leave b/a as
    // mid-grey / 1 for normal-map style consumers.
    let g = vec2f(gx, gy) * params.intensity;
    return vec4f(g * 0.5 + 0.5, 0.5, 1.0);
  }

  let mag = clamp(sqrt(gx * gx + gy * gy) * params.intensity, 0.0, 1.0);
  return mix(params.bg_color, params.edge_color, mag);
}
