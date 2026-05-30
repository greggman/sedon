// Particle-based hydraulic erosion. Each "drop" is one compute thread
// that walks downhill across the heightfield, eroding terrain where it
// has spare capacity and depositing sediment where it doesn't. Many
// thousand drops in parallel sculpt characteristic river valleys,
// ridges, and depositional plains out of pure noise.
//
// Three entry points (one shader module, three pipelines):
//   init      — copy input texture's R channel into a fixed-point storage
//               buffer (so we can atomically accumulate fractional
//               deposits/erosions; storage textures don't support atomics).
//   simulate  — one workgroup-per-batch of drops; each thread runs a
//               single drop for up to max_lifetime steps.
//   writeback — copy the eroded fixed-point buffer back into the
//               output texture (format substituted at compile time so
//               this shader compiles for both rgba8unorm and rgba16float).
//
// Fixed-point: heights stored as i32 with scale 2^16 (one fixed-point
// unit = 1/65_536 of a source unit ≈ 15 μm in metres). i32 range
// therefore covers ±32 768 source units — more than any plausible
// terrain.
//
// CRITICAL: deposits/erodes use SATURATING add (sat_add below), not
// raw atomicAdd. On a metres-scale heightfield popular pixels (river
// outlets, deposition fans, edge-dump targets) accumulate enough
// material over 60 k drops × 40 steps to drive a single accumulator
// past the ±2³¹ fixed-point boundary. Plain atomicAdd wraps on
// overflow, corrupting the value and (through the writeback) the rest
// of the terrain's mass balance — the visible symptom was the whole
// terrain collapsing to a near-uniform mid-grey because the few
// wrapped pixels dragged the auto-leveled preview's range to ±32 km.
// sat_add does atomicCompareExchangeWeak in a loop with manual
// saturation. Slower under contention at popular pixels but the only
// way to keep the accumulator faithful with only i32 atomics in WGSL.

struct Params {
  resolution: vec2u,
  drops: u32,
  seed: u32,
  inertia: f32,
  capacity: f32,
  deposition: f32,
  erosion: f32,
  evaporation: f32,
  gravity: f32,
  min_slope: f32,
  max_lifetime: u32,
  brush_radius: u32,
  _pad0: u32,
  _pad1: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> heights: array<atomic<i32>>;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var dst: texture_storage_2d<{{STORAGE_FORMAT}}, write>;

const FIXED_SCALE: f32 = 65536.0;   // 2^16
const INV_FIXED_SCALE: f32 = 0.0000152587890625;  // 1 / 2^16

fn to_fixed(h: f32) -> i32 {
  return i32(h * FIXED_SCALE);
}
fn from_fixed(h: i32) -> f32 {
  return f32(h) * INV_FIXED_SCALE;
}
fn idx_of(p: vec2i) -> u32 {
  return u32(p.y) * params.resolution.x + u32(p.x);
}
fn load_height(p: vec2i) -> f32 {
  let clamped = clamp(p, vec2i(0), vec2i(params.resolution) - vec2i(1));
  return from_fixed(atomicLoad(&heights[idx_of(clamped)]));
}

// Saturating atomic add. The plain atomicAdd wraps on i32 overflow; on
// popular pixels (river outlets / brush hot-spots / edge-dump targets)
// the accumulator can exceed ±2³¹ across the simulation's 60 k drops ×
// 40 steps × 49-pixel brush, and wrap corrupts the height. We instead
// CAS-loop: read old, compute saturated old+delta, try to commit. The
// overflow check uses the (FIXED_MAX − delta) / (FIXED_MIN − delta)
// trick which avoids ever computing an overflowing intermediate.
const FIXED_MAX: i32 = 2147483647;     //  i32::MAX
const FIXED_MIN: i32 = -2147483648;    //  i32::MIN
fn sat_add(idx: u32, delta: i32) {
  loop {
    let old = atomicLoad(&heights[idx]);
    var new_val: i32;
    if (delta > 0 && old > FIXED_MAX - delta) {
      new_val = FIXED_MAX;
    } else if (delta < 0 && old < FIXED_MIN - delta) {
      new_val = FIXED_MIN;
    } else {
      new_val = old + delta;
    }
    let r = atomicCompareExchangeWeak(&heights[idx], old, new_val);
    if (r.exchanged) { break; }
  }
}

// Apply a signed amount to the brush footprint around `pos`. Triangular
// falloff (peak at centre, zero at radius+1). Negative amount = erode,
// positive amount = deposit. Pixels out of bounds are skipped, so the
// total applied near edges < `amount`; that's the off-map dissipation
// edge case — material that would have landed off-grid quietly leaves.
//
// Spreading deposits over the brush (matching erodes) is what kept the
// per-pixel accumulator faithful: an earlier version dumped each
// drop's full deposit on a single pixel, and basin pixels with hundreds
// of drop hits piled up into multi-km spikes that broke both the mass
// balance and the rendered mesh.
fn brush_apply(pos: vec2f, amount: f32) {
  let r = i32(params.brush_radius);
  let center = vec2i(i32(pos.x), i32(pos.y));
  let rf = f32(params.brush_radius);
  var total_weight: f32 = 0.0;
  for (var dy: i32 = -r; dy <= r; dy = dy + 1) {
    for (var dx: i32 = -r; dx <= r; dx = dx + 1) {
      let d = sqrt(f32(dx*dx + dy*dy));
      total_weight = total_weight + max(0.0, rf - d);
    }
  }
  for (var dy: i32 = -r; dy <= r; dy = dy + 1) {
    for (var dx: i32 = -r; dx <= r; dx = dx + 1) {
      let d = sqrt(f32(dx*dx + dy*dy));
      let w = max(0.0, rf - d) / total_weight;
      if (w <= 0.0) { continue; }
      let p = center + vec2i(dx, dy);
      if (p.x < 0 || p.x >= i32(params.resolution.x)
          || p.y < 0 || p.y >= i32(params.resolution.y)) {
        continue;
      }
      sat_add(idx_of(p), to_fixed(amount * w));
    }
  }
}

// Init: read the source R channel into the fixed-point buffer.
// One thread per texel.
@compute @workgroup_size(8, 8, 1)
fn init(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.resolution.x || gid.y >= params.resolution.y) {
    return;
  }
  let uv = (vec2f(f32(gid.x), f32(gid.y)) + vec2f(0.5)) / vec2f(params.resolution);
  let h = textureSampleLevel(src, samp, uv, 0.0).r;
  atomicStore(&heights[idx_of(vec2i(i32(gid.x), i32(gid.y)))], to_fixed(h));
}

// Writeback: store the (possibly negative or out-of-source-range)
// fixed-point heights into the output texture. The format is
// substituted at shader-compile time so this writes the natural value
// range of the format (rgba8unorm clamps to [0,1]; rgba16float carries
// the full range).
@compute @workgroup_size(8, 8, 1)
fn writeback(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.resolution.x || gid.y >= params.resolution.y) {
    return;
  }
  let h = from_fixed(atomicLoad(&heights[idx_of(vec2i(i32(gid.x), i32(gid.y)))]));
  textureStore(dst, vec2i(i32(gid.x), i32(gid.y)), vec4f(h, h, h, 1.0));
}

// Dave Hoskins-style hash for stochastic drop spawn / step jitter.
fn hash11(p: u32) -> f32 {
  var x = p;
  x = (x ^ 61u) ^ (x >> 16u);
  x = x + (x << 3u);
  x = x ^ (x >> 4u);
  x = x * 0x27d4eb2du;
  x = x ^ (x >> 15u);
  return f32(x) * (1.0 / 4294967296.0);
}

// Sample a bilinear height + its 2D gradient at fractional pixel pos.
struct HG { h: f32, g: vec2f, }
fn sample_height_gradient(p: vec2f) -> HG {
  let f = floor(p);
  let t = p - f;
  let i = vec2i(i32(f.x), i32(f.y));
  let h00 = load_height(i);
  let h10 = load_height(i + vec2i(1, 0));
  let h01 = load_height(i + vec2i(0, 1));
  let h11 = load_height(i + vec2i(1, 1));
  // Bilinear interp.
  let h = (h00 * (1.0 - t.x) + h10 * t.x) * (1.0 - t.y)
        + (h01 * (1.0 - t.x) + h11 * t.x) * t.y;
  // Gradients along x and y, also bilinear-interpolated across the cell.
  let gx = (h10 - h00) * (1.0 - t.y) + (h11 - h01) * t.y;
  let gy = (h01 - h00) * (1.0 - t.x) + (h11 - h10) * t.x;
  var out: HG;
  out.h = h;
  out.g = vec2f(gx, gy);
  return out;
}

// Simulate: one thread per drop. Spawn at a hash-determined position,
// walk up to max_lifetime steps, atomicAdd deposits / atomicSub erosions
// into the shared heights buffer.
@compute @workgroup_size(64, 1, 1)
fn simulate(@builtin(global_invocation_id) gid: vec3<u32>) {
  let drop_idx = gid.x;
  if (drop_idx >= params.drops) {
    return;
  }

  // Spawn position: stratified random across the texture. Seed mixes
  // in the drop index so 1k drops are deterministic with the seed but
  // each picks a different cell.
  let res = vec2f(params.resolution);
  var pos = vec2f(
    hash11(drop_idx * 2u + params.seed) * (res.x - 1.0),
    hash11(drop_idx * 2u + 1u + params.seed * 31u) * (res.y - 1.0),
  );
  var vel = vec2f(0.0);
  var water = 1.0;
  var sediment = 0.0;
  var speed = 0.0;

  for (var step: u32 = 0u; step < params.max_lifetime; step = step + 1u) {
    let old = sample_height_gradient(pos);

    // Update velocity = inertia * old_vel + (1 - inertia) * (-gradient)
    vel = vel * params.inertia - old.g * (1.0 - params.inertia);
    let vlen = length(vel);
    if (vlen < 0.0001) {
      // Drop sat down — deposit whatever sediment is left and stop.
      let dep_idx = idx_of(clamp(vec2i(i32(pos.x), i32(pos.y)), vec2i(0), vec2i(params.resolution) - vec2i(1)));
      sat_add(dep_idx, to_fixed(sediment));
      return;
    }
    vel = vel / vlen;
    let new_pos = pos + vel;
    if (new_pos.x < 1.0 || new_pos.x >= res.x - 1.0
        || new_pos.y < 1.0 || new_pos.y >= res.y - 1.0) {
      // Walked off the map — drop dissipates carrying its load with
      // it. Modelling "river reaches the sea" rather than "river piles
      // sediment against an invisible wall." Previously deposited at
      // the boundary pixel "so we don't leak material," but with many
      // drops dispersing toward edges over the simulation, that built
      // up nonsensical accumulation against the boundary and dragged
      // the preview's auto-leveled range across kilometres of phantom
      // edge mass. Letting drops carry their sediment off-map respects
      // the physical metaphor and keeps the in-bounds heights faithful.
      return;
    }
    let new_h = sample_height_gradient(new_pos).h;
    let dh = new_h - old.h;

    // Sediment capacity proportional to slope × speed × water. min_slope
    // floor prevents drops on flat ground from stopping erosion entirely.
    let cap = max(-dh, params.min_slope) * speed * water * params.capacity;

    if (dh > 0.0 || sediment > cap) {
      // Deposit: either we're climbing (dh > 0 = uphill — drop pools)
      // or we're carrying more than this slope can hold. Spread over
      // the brush around the OLD position — same falloff erodes use —
      // so depositional fans are smooth and no single pixel piles up
      // a multi-km spike from many drops hitting the same basin.
      var deposit: f32;
      if (dh > 0.0) {
        deposit = min(dh, sediment);
      } else {
        deposit = (sediment - cap) * params.deposition;
      }
      sediment = sediment - deposit;
      brush_apply(pos, deposit);
    } else {
      // Erode: drop has spare capacity. Lower the terrain in the brush
      // around the OLD position so erosion has a coherent footprint
      // rather than a single-pixel pin.
      let erode_amount = min((cap - sediment) * params.erosion, -dh);
      brush_apply(pos, -erode_amount);
      // Drop picks up exactly what was removed (mass conservation);
      // brush weights sum to 1, so erode_amount × Σw = erode_amount.
      sediment = sediment + erode_amount;
    }

    // speed^2 update via gravity: rolling downhill adds speed, climbing
    // loses it. clamp to avoid sqrt(negative) when going uphill aggressively.
    speed = sqrt(max(0.0, speed * speed + (-dh) * params.gravity));
    water = water * (1.0 - params.evaporation);
    pos = new_pos;
    if (water < 0.005) {
      // Dried up — deposit remaining sediment and stop.
      let dep_idx = idx_of(clamp(vec2i(i32(pos.x), i32(pos.y)), vec2i(0), vec2i(params.resolution) - vec2i(1)));
      sat_add(dep_idx, to_fixed(sediment));
      return;
    }
  }
}
