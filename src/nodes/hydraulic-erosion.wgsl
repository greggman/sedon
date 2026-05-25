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
//   writeback — copy the eroded fixed-point buffer back into an
//               rgba8unorm texture for downstream nodes.
//
// Fixed-point: heights stored as i32 with scale 2^20 (one fixed-point
// unit = 1/1_048_576 of a normalised height). i32 range ±2048 in
// normalised space is far beyond any plausible erosion accumulation.
// Atomic<i32> means atomicAdd handles both deposit (positive) and erode
// (negative) deltas uniformly.

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
@group(0) @binding(4) var dst: texture_storage_2d<rgba8unorm, write>;

const FIXED_SCALE: f32 = 1048576.0;   // 2^20
const INV_FIXED_SCALE: f32 = 0.0000009536743;  // 1 / 2^20

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

// Writeback: store the (possibly negative or >1) fixed-point heights
// into a clamped rgba8unorm texture. The downstream Heightfield value
// maps the texture's R channel back to world heights via the worldSize/
// heightRange metadata; we deliberately preserve [0,1] there and clamp
// any erosion artefacts (deep deposits or pits) at the boundaries.
@compute @workgroup_size(8, 8, 1)
fn writeback(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= params.resolution.x || gid.y >= params.resolution.y) {
    return;
  }
  let h = from_fixed(atomicLoad(&heights[idx_of(vec2i(i32(gid.x), i32(gid.y)))]));
  let c = clamp(h, 0.0, 1.0);
  textureStore(dst, vec2i(i32(gid.x), i32(gid.y)), vec4f(c, c, c, 1.0));
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
      atomicAdd(&heights[dep_idx], to_fixed(sediment));
      return;
    }
    vel = vel / vlen;
    let new_pos = pos + vel;
    if (new_pos.x < 1.0 || new_pos.x >= res.x - 1.0
        || new_pos.y < 1.0 || new_pos.y >= res.y - 1.0) {
      // Walked off the map. Drop any remaining sediment at the old
      // pos so we don't leak material out of the simulation.
      let dep_idx = idx_of(clamp(vec2i(i32(pos.x), i32(pos.y)), vec2i(0), vec2i(params.resolution) - vec2i(1)));
      atomicAdd(&heights[dep_idx], to_fixed(sediment));
      return;
    }
    let new_h = sample_height_gradient(new_pos).h;
    let dh = new_h - old.h;

    // Sediment capacity proportional to slope × speed × water. min_slope
    // floor prevents drops on flat ground from stopping erosion entirely.
    let cap = max(-dh, params.min_slope) * speed * water * params.capacity;

    if (dh > 0.0 || sediment > cap) {
      // Deposit: either we're climbing (dh > 0 = uphill — drop pools)
      // or we're carrying more than this slope can hold. Drop at OLD
      // pos so deposits fill the hole the drop just emerged from.
      var deposit: f32;
      if (dh > 0.0) {
        deposit = min(dh, sediment);
      } else {
        deposit = (sediment - cap) * params.deposition;
      }
      sediment = sediment - deposit;
      let dep_idx = idx_of(clamp(vec2i(i32(pos.x), i32(pos.y)), vec2i(0), vec2i(params.resolution) - vec2i(1)));
      atomicAdd(&heights[dep_idx], to_fixed(deposit));
    } else {
      // Erode: drop has spare capacity. Lower the terrain in a small
      // brush around the OLD position so erosion has a coherent
      // footprint rather than a single-pixel pin.
      let erode_amount = min((cap - sediment) * params.erosion, -dh);
      let r = i32(params.brush_radius);
      let center = vec2i(i32(pos.x), i32(pos.y));
      // Total brush weight for normalisation. Triangular falloff with
      // peak at center, zero at radius+1.
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
          let amount = erode_amount * w;
          atomicAdd(&heights[idx_of(p)], to_fixed(-amount));
          sediment = sediment + amount;
        }
      }
    }

    // speed^2 update via gravity: rolling downhill adds speed, climbing
    // loses it. clamp to avoid sqrt(negative) when going uphill aggressively.
    speed = sqrt(max(0.0, speed * speed + (-dh) * params.gravity));
    water = water * (1.0 - params.evaporation);
    pos = new_pos;
    if (water < 0.005) {
      // Dried up — deposit remaining sediment and stop.
      let dep_idx = idx_of(clamp(vec2i(i32(pos.x), i32(pos.y)), vec2i(0), vec2i(params.resolution) - vec2i(1)));
      atomicAdd(&heights[dep_idx], to_fixed(sediment));
      return;
    }
  }
}
