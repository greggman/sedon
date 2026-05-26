// Carve a heightfield along a Path. One thread per output texel:
// finds the minimum distance to any segment of the path's polyline,
// then subtracts `depth × falloff(dist)` from the local height.
// Inside `width/2` of the path the full depth is removed; the depth
// smooths out to zero by `width/2 + falloff`. Outside that the texel
// is identical to the input.
//
// Distance is computed in world XZ (the heightfield's plane). The
// path's Y component is ignored here — the carve is purely a 2D
// stamp. Future road-flatten variant will read Y too.
//
// Heights are stored in the texture's R channel as normalised [0,1]
// over [heightMin, heightMax]; the world-unit `depth` is mapped into
// that range so the WGSL math works in normalised space and the
// output texture matches the input format (rgba8unorm).

struct Params {
  resolution: vec2u,
  worldSize: vec2f,
  heightRange: vec2f,
  sampleCount: u32,
  width: f32,
  depth: f32,
  falloff: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var dst: texture_storage_2d<rgba8unorm, write>;
// Polyline samples: 3 f32 per sample, length = sampleCount * 3.
@group(0) @binding(4) var<storage, read> samples: array<f32>;

fn distToSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let ap = p - a;
  let denom = max(dot(ab, ab), 0.000001);
  let t = clamp(dot(ap, ab) / denom, 0.0, 1.0);
  let proj = a + ab * t;
  return length(p - proj);
}

@compute @workgroup_size(8, 8, 1)
fn carve(@builtin(global_invocation_id) gid: vec3<u32>) {
  let res = params.resolution;
  if (gid.x >= res.x || gid.y >= res.y) {
    return;
  }
  let uv = (vec2f(f32(gid.x), f32(gid.y)) + vec2f(0.5)) / vec2f(res);
  // World XZ for this texel. Heightfield is centred on origin and
  // spans [-worldSize/2, +worldSize/2] in both axes — matches
  // terrain-render.wgsl's coordinate convention.
  let worldXZ = (uv - vec2f(0.5)) * params.worldSize;

  // Min distance to any polyline segment. With an empty / one-sample
  // path the loop body never runs and minDist stays at +inf, so the
  // smoothstep factor below is zero — pass-through.
  var minDist = 1e30;
  if (params.sampleCount >= 2u) {
    for (var i: u32 = 0u; i + 1u < params.sampleCount; i = i + 1u) {
      let ax = samples[i * 3u + 0u];
      let az = samples[i * 3u + 2u];
      let bx = samples[(i + 1u) * 3u + 0u];
      let bz = samples[(i + 1u) * 3u + 2u];
      let d = distToSegment(worldXZ, vec2f(ax, az), vec2f(bx, bz));
      minDist = min(minDist, d);
    }
  }

  let halfW = params.width * 0.5;
  let outer = halfW + params.falloff;
  // factor: 1 inside halfW, smooth ramp to 0 at outer, then flat 0.
  let factor = 1.0 - smoothstep(halfW, outer, minDist);
  // Map world-unit depth into the texture's normalised range so the
  // input R channel and the carved R channel use the same units.
  let range = max(params.heightRange.y - params.heightRange.x, 0.000001);
  let dh = params.depth * factor / range;

  let h_in = textureSampleLevel(src, samp, uv, 0.0).r;
  let h_out = clamp(h_in - dh, 0.0, 1.0);
  textureStore(dst, vec2i(i32(gid.x), i32(gid.y)), vec4f(h_out, h_out, h_out, 1.0));
}
