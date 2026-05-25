// Composite blit for the leaf-skeleton node's in-node preview. Takes
// the node's two texture outputs (shape + veins) and renders a single
// colorized image: dark background, off-white silhouette, warm-orange
// veins layered on top. The veins texture is already clipped to the
// leaf interior, so a straight mix in screen space is correct.
//
// Downstream consumers of leaf/skeleton still see the original two
// greyscale textures; this shader exists solely for the node preview.

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

@group(0) @binding(0) var shapeTex: texture_2d<f32>;
@group(0) @binding(1) var veinsTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

const BG = vec3f(0.102, 0.102, 0.122);   // #1a1a1f — matches app dark theme
const SHAPE = vec3f(0.310, 0.310, 0.310); // #7c7c7c — off-white silhouette
const VEIN = vec3f(1.000, 0.647, 0.149);  // #ffa526 — app accent (orange)

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let shapeAlpha = textureSample(shapeTex, samp, in.uv).a;
  let veinDensity = textureSample(veinsTex, samp, in.uv).r;
  var col = mix(BG, SHAPE, shapeAlpha);
  col = mix(col, VEIN, veinDensity);
  return vec4f(col, 1.0);
}
