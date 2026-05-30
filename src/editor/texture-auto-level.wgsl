// Auto-leveling preview blit for rgba16float (and any other float-format)
// source textures. Two stages share one buffer:
//
//   reduce — compute pass walks the source texture, atomic-mins/maxes the
//            per-texel min(R,G,B) / max(R,G,B) into a 2-element storage
//            buffer. Per-workgroup shared-memory atomics first, then ONE
//            global atomic per workgroup, so contention stays bounded.
//
//   level  — fullscreen render pass reads the same buffer (now holding
//            the final ordered-u32 min/max), decodes back to f32 inline,
//            and remaps each sampled texel to [0, 1] for display.
//
// Float atomics aren't a WebGPU thing, so we bit-encode each f32 into an
// ordered u32: monotonically-increasing function whose integer ordering
// matches the float ordering. atomicMin/Max on the ordered u32s then
// computes the float min/max with no precision loss vs. fixed-point.
// (Positives: flip sign bit so they sort above negatives. Negatives:
// invert all bits so larger-magnitude negatives sort smaller.)

fn floatToOrdered(x: f32) -> u32 {
  let bits = bitcast<u32>(x);
  // Sign bit set ⇒ negative ⇒ invert all bits.
  // Sign bit clear ⇒ positive ⇒ flip sign bit.
  return select(bits | 0x80000000u, ~bits, (bits & 0x80000000u) != 0u);
}

fn orderedToFloat(x: u32) -> f32 {
  // Inverse of floatToOrdered.
  return select(bitcast<f32>(~x), bitcast<f32>(x & 0x7FFFFFFFu), (x & 0x80000000u) != 0u);
}

// ----- Reduction pass -------------------------------------------------
// Each module-scope binding is module-unique even though WGSL's
// per-entry-point reachability rule would let us reuse numbers across
// the two stages. Distinct slots make the auto-layout debugging
// straightforward and side-step any conservative validator that flags
// collisions before reachability is checked.

@group(0) @binding(0) var redSrc: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> minMax: array<atomic<u32>, 2>;

// Reset the global min/max to sentinels. One thread total. Dispatched
// each draw before the reduction so previous-frame state can't bias
// the new computation. (Doing this in a compute pass instead of
// writeBuffer avoids any subtle queue-ordering surprise — the reset
// and the reduce serialize naturally within the same encoder.)
@compute @workgroup_size(1, 1, 1)
fn reset(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x == 0u && gid.y == 0u) {
    atomicStore(&minMax[0], 0xFFFFFFFFu);
    atomicStore(&minMax[1], 0x00000000u);
  }
}

var<workgroup> wgMin: atomic<u32>;
var<workgroup> wgMax: atomic<u32>;

@compute @workgroup_size(8, 8, 1)
fn reduce(
  @builtin(global_invocation_id) gid: vec3u,
  @builtin(local_invocation_index) lidx: u32,
) {
  if (lidx == 0u) {
    // Sentinels: max-possible (so any atomicMin wins) and min-possible
    // (so any atomicMax wins) in ordered-u32 space.
    atomicStore(&wgMin, 0xFFFFFFFFu);
    atomicStore(&wgMax, 0x00000000u);
  }
  workgroupBarrier();

  let dims = textureDimensions(redSrc, 0);
  if (gid.x < dims.x && gid.y < dims.y) {
    let rgba = textureLoad(redSrc, vec2i(i32(gid.x), i32(gid.y)), 0);
    // Shared scale across RGB so chromatic content keeps its colour
    // ratios after leveling: lo = darkest channel anywhere, hi =
    // brightest channel anywhere.
    let lo = min(rgba.r, min(rgba.g, rgba.b));
    let hi = max(rgba.r, max(rgba.g, rgba.b));
    // Skip non-finite samples — one stray NaN or ±Inf would otherwise
    // poison min/max and compress the whole preview into a flat mid-
    // grey. NaN: x != x. ±Inf: |x| > finite cap. The 1e30 cap stays
    // well within the rgba16float representable range (~6.5e4) while
    // catching any out-of-range upstream artefacts.
    let finite = lo == lo && hi == hi && abs(lo) < 1e30 && abs(hi) < 1e30;
    if (finite) {
      atomicMin(&wgMin, floatToOrdered(lo));
      atomicMax(&wgMax, floatToOrdered(hi));
    }
  }
  workgroupBarrier();

  // One thread per workgroup commits the workgroup's local min/max to
  // the global. Keeps global contention at "one atomic per workgroup"
  // (≈1k ops at 256², not 64k).
  if (lidx == 0u) {
    atomicMin(&minMax[0], atomicLoad(&wgMin));
    atomicMax(&minMax[1], atomicLoad(&wgMax));
  }
}

// ----- Render pass: blit with leveling --------------------------------

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

@group(0) @binding(2) var blitSrc: texture_2d<f32>;
@group(0) @binding(3) var blitSamp: sampler;
@group(0) @binding(4) var<storage, read> blitMinMax: array<u32, 2>;

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let rgba = textureSample(blitSrc, blitSamp, in.uv);
  let lo = orderedToFloat(blitMinMax[0]);
  let hi = orderedToFloat(blitMinMax[1]);
  // Floor on the range so a constant-coloured texture (min == max) maps
  // to a uniform 0 instead of dividing by zero into NaN haze.
  let denom = max(hi - lo, 1e-6);
  let leveled = (rgba.rgb - vec3f(lo)) / denom;
  return vec4f(clamp(leveled, vec3f(0.0), vec3f(1.0)), 1.0);
}
