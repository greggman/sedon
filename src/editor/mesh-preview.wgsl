// Barycentric-coordinate wireframe preview. Each input vertex gets a
// per-vertex barycentric of (1,0,0) | (0,1,0) | (0,0,1) chosen by
// `vertex_index % 3` — which works because the host expands the indexed
// mesh into a non-indexed triangle-list before drawing, so every three
// consecutive vertices in the buffer form one triangle. The fragment
// shader then picks the minimum of the three barycentric components
// (which equals the distance to the nearest edge) and uses fwidth-based
// anti-aliasing to draw a clean line, regardless of view distance.

struct Uniforms {
  mvp: mat4x4f,
  back_color: vec4f,
  front_color: vec4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) bary: vec3f,
};

@vertex
fn vs_main(
  @builtin(vertex_index) vid: u32,
  @location(0) pos: vec3f,
) -> VSOut {
  // Pick the barycentric corner from the vertex's slot within its
  // triangle. Indices 0 → (1,0,0), 1 → (0,1,0), 2 → (0,0,1).
  var bary: vec3f;
  let slot = vid % 3u;
  if (slot == 0u) {
    bary = vec3f(1.0, 0.0, 0.0);
  } else if (slot == 1u) {
    bary = vec3f(0.0, 1.0, 0.0);
  } else {
    bary = vec3f(0.0, 0.0, 1.0);
  }

  var out: VSOut;
  out.clip = u.mvp * vec4f(pos, 1.0);
  out.bary = bary;
  return out;
}

@fragment
fn fs_main(in: VSOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  // Distance to nearest edge, in barycentric space. fwidth measures the
  // per-pixel screen-space derivative, so dividing by it scales `d` into
  // pixel units — the line width then reads as a constant screen-space
  // thickness regardless of how far the triangle is from the camera.
  let d = min(min(in.bary.x, in.bary.y), in.bary.z);
  let aa_width = fwidth(d) * 1.5;
  // 1 at the edge, 0 in the interior, with a soft falloff over aa_width.
  let edge = 1.0 - smoothstep(0.0, aa_width, d);
  if (edge < 0.5) { discard; }
  let rgb = select(u.back_color.rgb, u.front_color.rgb, front);
  return vec4f(rgb * edge, edge);
}
