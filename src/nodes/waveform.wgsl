struct Params {
  color_a: vec4f,
  color_b: vec4f,
  // wave direction in radians; 0 = horizontal sweep (vertical stripes).
  angle: f32,
  // periods per UV unit (along the wave direction).
  frequency: f32,
  // phase shift in turns.
  phase: f32,
  // duty cycle for square wave (and asymmetric triangle / sawtooth).
  duty: f32,
  // 0 = sine, 1 = triangle, 2 = sawtooth, 3 = square, 4 = reverse sawtooth.
  waveform: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> params: Params;

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

const TAU = 6.28318530717958647692;

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  // Project the centred uv onto the wave direction; multiply by
  // frequency to get the cycle count, add phase.
  let centred = in.uv - 0.5;
  let dir = vec2f(cos(params.angle), sin(params.angle));
  let cycle = dot(centred, dir) * params.frequency + params.phase;

  let mode = i32(params.waveform + 0.5);
  let local = fract(cycle);
  let duty = clamp(params.duty, 0.001, 0.999);
  var v: f32;
  if (mode == 1) {
    // Triangle: rises 0→1 over [0, duty], falls 1→0 over [duty, 1].
    let rising = local / duty;
    let falling = (1.0 - local) / (1.0 - duty);
    v = min(rising, falling);
  } else if (mode == 2) {
    // Sawtooth: linear ramp 0→1 over the period.
    v = local;
  } else if (mode == 3) {
    // Square: a or b based on whether we're in the duty band.
    v = select(0.0, 1.0, local < duty);
  } else if (mode == 4) {
    // Reverse sawtooth: linear ramp 1→0 over the period.
    v = 1.0 - local;
  } else {
    // Sine (default).
    v = 0.5 + 0.5 * sin(cycle * TAU);
  }

  return mix(params.color_a, params.color_b, v);
}
