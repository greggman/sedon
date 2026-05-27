// Animated water surface. Standard scene-entity vertex pipeline (same
// per-instance transform layout as PBR + terrain-splat), with a
// procedural fragment that builds tangent-space normals from
// scrolling sine waves and renders a tight-rough specular highlight
// against the sun.
//
// All-procedural — no textures, no per-material bindings beyond a
// small uniform block (colour + wave + roughness).
//
// `time` lives at the trailing slot of the shared scene uniform
// buffer (offset 272), so adding water doesn't require touching any
// other shader's `Uniforms` struct.

struct Uniforms {
  modelView: mat4x4f,
  projection: mat4x4f,
  lightViewProj: mat4x4f,
  lightDirWorld: vec3f,
  lightColor: vec3f,
  skyColor: vec3f,
  ambientIntensity: f32,
  groundColor: vec3f,
  fog: vec4f,
  time: f32,
};

struct WaterParams {
  color: vec4f,
  // x = waveStrength, y = waveScale, z = waveSpeed, w = roughness
  waves: vec4f,
  // x,y = worldSize (heightfield XZ extent), z = heightMin, w = heightMax
  world: vec4f,
  // x = foamWidth (world units), y = foamEnabled (0/1), z/w = unused
  foam: vec4f,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var shadow_map: texture_depth_2d;
@group(0) @binding(3) var shadow_samp: sampler_comparison;

@group(1) @binding(0) var<uniform> water: WaterParams;
@group(1) @binding(1) var heightTex: texture_2d<f32>;
@group(1) @binding(2) var heightSamp: sampler;

struct VsIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) inst_col0: vec4f,
  @location(4) inst_col1: vec4f,
  @location(5) inst_col2: vec4f,
  @location(6) inst_col3: vec4f,
  @location(7) inst_tint: vec4f,
};

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) view_pos: vec3f,
  @location(1) view_normal: vec3f,
  @location(2) world_pos: vec3f,
  @location(3) tint: vec4f,
};

@vertex
fn vs_main(in: VsIn) -> VsOut {
  let inst_mat = mat4x4f(in.inst_col0, in.inst_col1, in.inst_col2, in.inst_col3);
  var world_pos4 = inst_mat * vec4f(in.position, 1.0);
  // Displace vertices vertically by the wave height field. Same
  // function the fragment shader uses, so the analytic normal it
  // computes is the true derivative of THIS surface (no shading-vs-
  // silhouette mismatch). Strength + scale + speed come from the
  // shared per-material uniforms.
  let strength = water.waves.x;
  let scale = water.waves.y;
  let speed = water.waves.z;
  let wave = computeWaves(world_pos4.xz, uniforms.time, strength, scale, speed);
  world_pos4.y = world_pos4.y + wave.h;
  let view_pos4 = uniforms.modelView * world_pos4;
  var out: VsOut;
  out.position = uniforms.projection * view_pos4;
  out.view_pos = view_pos4.xyz;
  out.world_pos = world_pos4.xyz;
  let inst_3x3 = mat3x3f(in.inst_col0.xyz, in.inst_col1.xyz, in.inst_col2.xyz);
  let world_normal = inst_3x3 * in.normal;
  let normal_mat = mat3x3f(
    uniforms.modelView[0].xyz,
    uniforms.modelView[1].xyz,
    uniforms.modelView[2].xyz,
  );
  out.view_normal = normal_mat * world_normal;
  out.tint = in.inst_tint;
  return out;
}

const PI: f32 = 3.14159265359;

fn distribution_ggx(n_dot_h: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let n_dot_h2 = n_dot_h * n_dot_h;
  let denom = n_dot_h2 * (a2 - 1.0) + 1.0;
  return a2 / max(PI * denom * denom, 0.0001);
}
fn geometry_schlick_ggx(n_dot_v: f32, roughness: f32) -> f32 {
  let r = roughness + 1.0;
  let k = (r * r) / 8.0;
  return n_dot_v / (n_dot_v * (1.0 - k) + k);
}
fn geometry_smith(n_dot_v: f32, n_dot_l: f32, roughness: f32) -> f32 {
  return geometry_schlick_ggx(n_dot_v, roughness) * geometry_schlick_ggx(n_dot_l, roughness);
}
fn fresnel_schlick(cos_theta: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(clamp(1.0 - cos_theta, 0.0, 1.0), 5.0);
}
fn srgb_to_linear(color: vec3f) -> vec3f {
  return pow(color, vec3f(2.2));
}
fn apply_fog(lit: vec3f, view_pos_z: f32) -> vec3f {
  let visibility = exp(-uniforms.fog.w * abs(view_pos_z));
  return mix(srgb_to_linear(uniforms.fog.xyz), lit, visibility);
}

// Procedural water surface = sum of three scrolling sine waves at
// non-aligned directions. Returns both the height (consumed by the
// vertex shader for vertical displacement) and the analytic
// tangent-space normal (consumed by the fragment shader). Sharing
// one function for both keeps the surface physically consistent —
// the normal you see at a fragment is the true derivative of the
// height the vertex shader displaced to.
//
// World-XZ inputs so the wave pattern is locked to the world, not
// the mesh. Wider planes don't stretch the waves; subdividing the
// mesh gives more taps of the same field.
struct Wave {
  h: f32,
  n: vec3f,
};

fn computeWaves(worldXZ: vec2f, t: f32, strength: f32, scale: f32, speed: f32) -> Wave {
  let invScale = 1.0 / max(scale, 0.0001);
  let p = worldXZ * invScale;
  let d1 = vec2f( 1.0,  0.6);
  let d2 = vec2f(-0.4,  1.0);
  let d3 = vec2f( 0.7, -0.9);
  let ph1 = dot(p, d1) + t * 1.0 * speed;
  let ph2 = dot(p, d2) + t * 1.3 * speed;
  let ph3 = dot(p, d3) + t * 0.7 * speed;
  let s1 = sin(ph1);
  let s2 = sin(ph2);
  let s3 = sin(ph3);
  let c1 = cos(ph1);
  let c2 = cos(ph2);
  let c3 = cos(ph3);
  let dhx = (c1 * d1.x + c2 * d2.x + c3 * d3.x) * strength * invScale;
  let dhz = (c1 * d1.y + c2 * d2.y + c3 * d3.y) * strength * invScale;
  var out: Wave;
  out.h = (s1 + s2 + s3) * strength;
  out.n = normalize(vec3f(-dhx, 1.0, -dhz));
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Build tangent-space normal from scrolling waves; rotate into
  // view space using the geometry's world basis (water plane has
  // world-up Y, so view_rot * tangent ≈ view_rot * world).
  let strength = water.waves.x;
  let scale = water.waves.y;
  let speed = water.waves.z;
  let roughness = water.waves.w;

  let n_world = computeWaves(in.world_pos.xz, uniforms.time, strength, scale, speed).n;
  let view_rot = mat3x3f(
    uniforms.modelView[0].xyz,
    uniforms.modelView[1].xyz,
    uniforms.modelView[2].xyz,
  );
  let n = normalize(view_rot * n_world);

  let v = normalize(-in.view_pos);
  let l_world = normalize(uniforms.lightDirWorld);
  let l = normalize(view_rot * l_world);
  let h = normalize(v + l);

  let n_dot_v = max(dot(n, v), 0.0);
  let n_dot_l = max(dot(n, l), 0.0);
  let n_dot_h = max(dot(n, h), 0.0);
  let h_dot_v = max(dot(h, v), 0.0);

  // Water F0 is around 0.02 — physically correct, gives the soft
  // ambient reflectance + strong fresnel that water needs.
  let f0 = vec3f(0.02);
  let f = fresnel_schlick(h_dot_v, f0);
  let d = distribution_ggx(n_dot_h, roughness);
  let g = geometry_smith(n_dot_v, n_dot_l, roughness);
  let specular = (d * g * f) / max(4.0 * n_dot_v * n_dot_l, 0.0001);

  let albedo = srgb_to_linear(water.color.rgb * in.tint.rgb);
  let k_d = (vec3f(1.0) - f);
  // Hemisphere ambient — water reflects sky strongly upward.
  let hemi_t = n_world.y * 0.5 + 0.5;
  let ambient_color = mix(uniforms.groundColor, uniforms.skyColor, hemi_t) * uniforms.ambientIntensity;

  let direct = (k_d * albedo / PI + specular) * uniforms.lightColor * n_dot_l;
  let ambient_term = albedo * ambient_color;
  // Water reflects extra sky — a fresnel-driven sky tint boost on
  // top of the diffuse + specular. Keeps water reading as wet even
  // in shadow.
  let sky_reflect = uniforms.skyColor * f * 0.4;
  var lit = direct + ambient_term + sky_reflect;

  // Shoreline foam. When a heightfield is bound AND this fragment
  // sits over the actual terrain footprint (UV in [0,1]), sample
  // terrain Y at the pixel's world XZ and compute water depth here.
  // Within the first `foamWidth` metres the surface fades toward
  // bright foam-white, still multiplied by the sun/ambient so foam
  // dims correctly in shadow.
  //
  // When the water plane extends past the heightfield (open water
  // beyond the terrain edge), the UV bounds check skips foam — that
  // region is "deep open water" with no shoreline to break against.
  // Depth-driven opacity. The authored alpha (water.color.a) is the
  // shallow-water opacity — that's where you actually want to see
  // sand/foam/silt through the water. As depth grows, water reads
  // as more opaque (Beer-Lambert: more water column = more photons
  // absorbed). Without this, water with alpha=0.7 stays 30% see-
  // through over even the deepest channels, making the whole
  // surface look like tinted glass.
  //
  // When no heightfield is bound, depth can't be computed → fall
  // back to the authored alpha unchanged.
  var alpha = water.color.a;
  if (water.foam.y > 0.5) {
    let worldSize = water.world.xy;
    let hMin = water.world.z;
    let hMax = water.world.w;
    let uv = in.world_pos.xz / worldSize + vec2f(0.5);
    let inHeightfield = uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
    if (inHeightfield) {
      let terrainH = textureSampleLevel(heightTex, heightSamp, uv, 0.0).r;
      let terrainY = hMin + terrainH * (hMax - hMin);
      let depth = max(in.world_pos.y - terrainY, 0.0);
      // Beer-Lambert-ish depth opacity. depth=0 → authored alpha
      // (shallow, terrain shows through). depth ≥ ~2 m → fully
      // opaque (deep water reads as solid colour). The exponent
      // 1.5 tunes how quickly water hides what's beneath.
      let depthOpacity = 1.0 - exp(-depth * 1.5);
      let baseAlpha = mix(water.color.a, 1.0, depthOpacity);
      // Foam mix on top: shoreline whitewater. Only when foamWidth>0.
      var foam = 0.0;
      if (water.foam.x > 0.0) {
        foam = 1.0 - smoothstep(0.0, water.foam.x, depth);
        let foam_color = srgb_to_linear(vec3f(0.9, 0.94, 0.96));
        lit = mix(lit, foam_color * (uniforms.lightColor * n_dot_l + ambient_color), foam);
      }
      // Foam is opaque whitewater; take the max of foam opacity
      // and depth opacity so the foam never gets undercut by the
      // shallow-water alpha.
      alpha = max(baseAlpha, foam);
    }
  }

  return vec4f(apply_fog(lit, in.view_pos.z), alpha);
}
