// Flat-preview background — a gray checkerboard drawn behind plane
// previews for textures and heightfields. Replaces the atmosphere
// sky shader in flat-preview mode; scene.ts picks one or the other
// per draw. No uniforms (the pattern is purely screen-space), so the
// pipeline uses 'auto' layout with an empty bind group.
//
// The two grays are linear-space values chosen to display as roughly
// sRGB 0.45 / 0.55 once composite re-encodes — visible enough that
// transparent / unsampled pixels read clearly against them, but not
// distracting enough to compete with the asset being inspected.

struct VsOut {
  @builtin(position) position: vec4f,
};

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VsOut {
  // Same fullscreen-triangle trick as sky.wgsl.
  let x = f32((idx << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(idx & 2u) * 2.0 - 1.0;
  var out: VsOut;
  out.position = vec4f(x, y, 0.0, 1.0);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // 24-pixel cells in screen space (@builtin(position).xy is pixel
  // coords on a swapchain-sized canvas; for downsampled HDR targets
  // it's the HDR-target pixel grid, which is what we want anyway).
  let cell = floor(in.position.xy / 24.0);
  let phase = (cell.x + cell.y) - 2.0 * floor((cell.x + cell.y) * 0.5);
  let gray = mix(0.16, 0.26, phase);
  return vec4f(vec3f(gray), 1.0);
}
