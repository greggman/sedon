// Procedural grass blade-card texture. Renders `bladeCount` tapered,
// slightly-leaning blades across the card with an alpha silhouette
// (A = 1 inside a blade, 0 between) and a base→tip colour gradient with
// per-blade value jitter + a soft center-to-edge round. Designed as a
// `core/grass` card: the alpha is what the grass shader cross-cuts, so
// blades read as individual leaves rather than solid quads.
//
// UV: matches the fullscreen-triangle convention (v=0 at the top of the
// image). The blade TIP is at the top, so height = 1 - uv.y (0 at the
// rooted base, 1 at the tip).

struct Params {
  baseColor: vec4f,
  tipColor: vec4f,
  cfg: vec4f,        // bladeCount, width, lean, seed
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

fn hash1(n: f32) -> f32 {
  return fract(sin(n * 127.1 + 311.7) * 43758.5453);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let count = max(1.0, floor(p.cfg.x));
  let widthMul = p.cfg.y;
  let leanMul = p.cfg.z;
  let seed = p.cfg.w;
  let height = clamp(1.0 - in.uv.y, 0.0, 1.0);

  // Antialias band ~1.5 texels wide (assumes the texture is sampled at
  // roughly 1:1; smoothstep over a small constant is plenty for a card).
  let aa = 0.006;

  var bestAlpha = 0.0;
  var bestShade = 1.0;
  let n = u32(count);
  for (var i = 0u; i < n; i = i + 1u) {
    let fi = f32(i);
    let r0 = hash1(fi + seed * 17.0);
    let r1 = hash1(fi + seed * 17.0 + 5.0);
    let r2 = hash1(fi + seed * 17.0 + 9.0);

    // Even slot across the card + small jitter so blades aren't a
    // perfect comb.
    let slot = (fi + 0.5) / count;
    let cx0 = slot + (r0 - 0.5) * (0.6 / count);
    // Lean: tip drifts sideways with height² (rooted base, swept tip).
    let lean = (r1 - 0.5) * 2.0 * leanMul;
    let cx = cx0 + lean * height * height;

    // Taper: half-width at base shrinks to ~0 at the tip. Per-blade
    // width variation via r2.
    let baseHalf = (0.42 / count) * widthMul * (0.7 + 0.6 * r2);
    let half = baseHalf * (1.0 - height * 0.92);
    // Round the very base so blades don't read as hard rectangles.
    let baseRound = smoothstep(0.0, 0.05, height);
    let effHalf = half * mix(0.6, 1.0, baseRound);

    let dx = abs(in.uv.x - cx);
    let a = smoothstep(effHalf, effHalf - aa, dx);
    if (a > bestAlpha) {
      bestAlpha = a;
      // Center→edge shading (rounder look) × slight per-blade value.
      let edge = 1.0 - clamp(dx / max(effHalf, 1e-4), 0.0, 1.0);
      bestShade = (0.78 + 0.22 * edge) * (0.85 + 0.3 * r0);
    }
  }

  let col = mix(p.baseColor.rgb, p.tipColor.rgb, height) * bestShade;
  return vec4f(col, bestAlpha);
}
