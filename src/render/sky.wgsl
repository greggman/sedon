// Fullscreen sky gradient. Drawn before any geometry, with no depth test
// and depthWriteEnabled=false, so the scene's depth + reverse-Z compare
// still works for actual geometry. The gradient is screen-space (top-of-
// screen to bottom-of-screen), not world-direction-based — simpler, and
// for our orbit-around-origin previews it reads as expected because the
// camera doesn't roll.

struct Sky {
  top: vec3f,
  bottom: vec3f,
};

@group(0) @binding(0) var<uniform> sky: Sky;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) screen_uv: vec2f,
};

// Standard fullscreen-triangle trick: 3 vertices cover the entire NDC
// rectangle. vertex_index 0,1,2 maps to corners (-1,-1), (3,-1), (-1,3).
@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  let x = f32((idx << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(idx & 2u) * 2.0 - 1.0;
  var out: VsOut;
  // Place at far-z under reverse-Z (z=0) so even if depth test is enabled
  // elsewhere the sky always loses to real geometry. We disable depth in
  // the pipeline anyway, but this keeps NDC sane.
  out.position = vec4f(x, y, 0.0, 1.0);
  // Map NDC y in [-1, 1] to a 0..1 screen-space gradient parameter where
  // 0 is the top of the screen and 1 is the bottom. WebGPU NDC y points up,
  // so screen-top is y=+1 → param 0.
  out.screen_uv = vec2f(x, y);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // t: 0 at the top of the screen, 1 at the bottom.
  let t = 0.5 - in.screen_uv.y * 0.5;
  let color = mix(sky.top, sky.bottom, t);
  return vec4f(color, 1.0);
}
