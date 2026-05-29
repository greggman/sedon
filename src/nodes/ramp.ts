import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice, reusableTexture } from '../core/resources.js';

// Generic N-stop colour gradient → Nx1 RGBA8 texture. Authored via
// the in-node gradient editor (custom inline renderer for the
// `Gradient` socket type). Consumers sample the resulting texture
// with a parameter in [0, 1].
//
// IMPORTANT for downstream consumers — the standard half-texel
// boundary correction. With bilinear filtering, naïvely sampling at
// uv.x = `l` (l in [0, 1]) for an N-pixel ramp means:
//
//   - l ∈ [0, 0.5/N]:        sticks at pixel 0 (clamped)
//   - l ∈ [0.5/N, (N-0.5)/N]: smooth ramp through pixel centres
//   - l ∈ [(N-0.5)/N, 1]:    sticks at pixel N-1 (clamped)
//
// To get the full gradient with `l = 0` → leftmost stop colour and
// `l = 1` → rightmost stop colour, the consumer must shift the sample
// uv to:
//
//   uv.x = (0.5 + l * (textureWidth - 1)) / textureWidth
//
// (i.e. map [0, 1] into the range of pixel CENTRES, not the texel
// edges). The default `resolution` of 256 keeps the per-pixel jump
// small so this correction usually only matters for very-low-N
// ramps, but it's the right thing to do everywhere.
//
// The Nx1 texture is generated on the CPU (a few ms even at 1024
// pixels) and uploaded via writeTexture. We don't need a render pass
// — the work per pixel is just "find the bracketing stop pair, lerp."

export type RampInterpolation = 'linear' | 'smooth' | 'constant';

export interface GradientStop {
  /** Position along the ramp, normalised to [0, 1]. */
  position: number;
  /** sRGB authoring colour with alpha. Stored 0..1 per channel. */
  color: [number, number, number, number];
  /**
   * Optional Photoshop-style midpoint: where the 50/50 mix of THIS
   * stop's colour with the NEXT stop's colour falls between them,
   * expressed as a fraction in (0, 1) of the distance. 0.5 = linear
   * (default). <0.5 = mix pinches toward THIS colour; >0.5 = pinches
   * toward the next. The piecewise-linear local-t remap is applied
   * before the colour lerp, so it composes cleanly with Smooth /
   * Constant interpolation modes too. Has no effect on the LAST
   * stop (nothing after it to mix with).
   */
  midpoint?: number;
}

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

const DEFAULT_STOPS: GradientStop[] = [
  { position: 0, color: [0, 0, 0, 1] },
  { position: 1, color: [1, 1, 1, 1] },
];

// Enum value → string name, kept in sync with the dropdown options
// in the input definition below.
const INTERP_BY_INDEX: Record<number, RampInterpolation> = {
  0: 'linear',
  1: 'smooth',
  2: 'constant',
};

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function toByte(c: number): number {
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

// Normalise an authored stops array: filter junk, ensure at least one
// stop, sort by position, clamp positions to [0, 1]. Doesn't mutate
// the input.
function normaliseStops(raw: unknown): GradientStop[] {
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_STOPS;
  const out: GradientStop[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { position?: unknown; color?: unknown; midpoint?: unknown };
    if (typeof e.position !== 'number' || !Number.isFinite(e.position)) continue;
    if (!Array.isArray(e.color) || e.color.length !== 4) continue;
    if (!e.color.every((c) => typeof c === 'number' && Number.isFinite(c))) continue;
    const stop: GradientStop = {
      position: clamp01(e.position),
      color: [e.color[0]!, e.color[1]!, e.color[2]!, e.color[3]!] as [number, number, number, number],
    };
    if (typeof e.midpoint === 'number' && Number.isFinite(e.midpoint)) {
      stop.midpoint = clamp01(e.midpoint);
    }
    out.push(stop);
  }
  if (out.length === 0) return DEFAULT_STOPS;
  out.sort((a, b) => a.position - b.position);
  return out;
}

// Sample the gradient at parameter `t ∈ [0, 1]` using the given
// interpolation mode. Stops are assumed already sorted by position.
function sampleGradient(
  stops: GradientStop[],
  t: number,
  mode: RampInterpolation,
): [number, number, number, number] {
  // Single-stop case = solid colour everywhere.
  if (stops.length === 1) return stops[0]!.color;
  // Clamp to endpoint colours outside the authored range.
  if (t <= stops[0]!.position) return stops[0]!.color;
  if (t >= stops[stops.length - 1]!.position) return stops[stops.length - 1]!.color;
  // Find bracketing pair (a..b where a.pos <= t < b.pos).
  let a = stops[0]!;
  let b = stops[stops.length - 1]!;
  for (let i = 0; i < stops.length - 1; i++) {
    const s0 = stops[i]!;
    const s1 = stops[i + 1]!;
    if (t >= s0.position && t <= s1.position) {
      a = s0;
      b = s1;
      break;
    }
  }
  // Constant: step at b's edge, so within [a, b) the result is a.
  if (mode === 'constant') return a.color;
  // Linear or smooth — compute local t within the pair.
  const span = b.position - a.position;
  let local = span > 0 ? (t - a.position) / span : 0;
  // Apply A's midpoint remap (if any). Smooth POWER curve rather
  // than piecewise-linear: choose exponent k such that
  // midpoint^k = 0.5, then local := local^k. Endpoints stay
  // anchored (0^k = 0, 1^k = 1) and there's no derivative kink at
  // the midpoint, so the bias reads as a gradual lean rather than
  // a sharp corner. (Photoshop's documented behaviour is the
  // piecewise-linear remap, but most artists who want "midpoint" in
  // practice expect the smoother curve.)
  if (a.midpoint !== undefined && a.midpoint > 0 && a.midpoint < 1 && a.midpoint !== 0.5) {
    const k = Math.log(0.5) / Math.log(a.midpoint);
    local = Math.pow(local, k);
  }
  if (mode === 'smooth') local = smoothstep(local);
  return [
    a.color[0] + (b.color[0] - a.color[0]) * local,
    a.color[1] + (b.color[1] - a.color[1]) * local,
    a.color[2] + (b.color[2] - a.color[2]) * local,
    a.color[3] + (b.color[3] - a.color[3]) * local,
  ];
}

export const rampNode: NodeDef = {
  id: 'core/ramp',
  category: 'Texture/Generators',
  inputs: [
    {
      // Authored only — there's no socket type for "list of gradient
      // stops" because no other node produces or consumes that shape.
      // The `widget: 'gradient'` dispatches the popup editor; the
      // `hideSocket: true` suppresses the (misleading) handle. The
      // underlying `type` field is a placeholder ('Vec4' chosen as the
      // closest single-value cousin); it's never used for connections.
      name: 'gradient',
      type: 'Vec4',
      widget: 'gradient',
      hideSocket: true,
      default: DEFAULT_STOPS,
      description: 'colour gradient (list of (position, colour) stops). Click the swatch to open the editor: click the bar to add a stop, drag a stop to move, double-click a stop to recolour, Delete to remove. Authored in sRGB',
    },
    {
      name: 'interpolation',
      type: 'Int',
      default: 0,
      description: 'how colours blend between adjacent stops. Linear = straight lerp; Smooth = smoothstep curve; Constant = pixel-perfect step at each stop',
      enumOptions: [
        { value: 0, label: 'Linear' },
        { value: 1, label: 'Smooth' },
        { value: 2, label: 'Constant' },
      ],
    },
    {
      name: 'resolution',
      type: 'Int',
      default: 256,
      description: 'output texture width in pixels (height is always 1). Higher = smoother gradient at the cost of upload size; 256 covers smooth lerps; 16 is enough for hand-stepped palettes',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'Nx1 RGBA gradient texture. Sample with t ∈ [0, 1] (applying a half-texel offset, see ramp.ts header) to read the colour at that position along the gradient',
    },
  ],
  doc: {
    summary: 'Author an N-stop colour gradient as an Nx1 RGBA texture.',
    description:
      'Builds a 1D palette from N (position, colour) stops, drawn into an Nx1 texture so ' +
      'downstream nodes can sample it with a parameter in [0, 1]. Authoring happens in the ' +
      'in-node gradient editor — click the bar to add a stop, drag to move, double-click ' +
      'to recolour, Delete to remove. Each stop optionally carries a midpoint (the diamond ' +
      'between adjacent stops) controlling where the 50/50 mix lands.\n\n' +
      'Three interpolation modes: Linear is a straight lerp between stops; Smooth runs the ' +
      'lerp through a smoothstep curve so the transition reads softer; Constant draws each ' +
      'stop\'s colour up to the next stop with no blending (pixel-perfect step palette).\n\n' +
      'Pair with core/colorize to remap a greyscale source (perlin, worley, distance ' +
      'transform, …) through the gradient — same behaviour as Photoshop\'s Gradient Map.',
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/ramp', {
        id: 'ramp',
        position: { x: 0, y: 0 },
        inputValues: {
          gradient: [
            { position: 0, color: [0.18, 0.36, 0.16, 1] },
            { position: 0.6, color: [0.55, 0.62, 0.28, 1] },
            { position: 1, color: [0.95, 0.88, 0.42, 1] },
          ],
          interpolation: 0,
          resolution: 256,
        },
      });
      return { graph: g, rootNodeId: 'ramp' };
    },
  },
  evaluate(ctx, inputs): { texture: Texture2DValue } {
    const device = requireDevice(ctx);
    const stops = normaliseStops(inputs.gradient);
    const interpolation = INTERP_BY_INDEX[inputs.interpolation as number] ?? 'linear';
    const resolution = Math.max(2, inputs.resolution as number);

    const prev = ctx.previousOutput as { texture?: Texture2DValue } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      width: resolution,
      height: 1,
      format: TEXTURE_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // Walk every pixel and sample the gradient at its centre's
    // position. Mapping pixel i → t = i / (resolution - 1) puts t=0
    // at pixel 0 and t=1 at pixel N-1, which together with the
    // consumer-side half-texel sample-uv correction produces a clean
    // 0→1 ramp regardless of texture resolution.
    const bytes = new Uint8Array(resolution * 4);
    for (let i = 0; i < resolution; i++) {
      const t = i / (resolution - 1);
      const rgba = sampleGradient(stops, t, interpolation);
      bytes[i * 4 + 0] = toByte(rgba[0]);
      bytes[i * 4 + 1] = toByte(rgba[1]);
      bytes[i * 4 + 2] = toByte(rgba[2]);
      bytes[i * 4 + 3] = toByte(rgba[3]);
    }
    device.queue.writeTexture(
      { texture: out.texture },
      bytes,
      { bytesPerRow: resolution * 4 },
      [resolution, 1],
    );

    return { texture: out };
  },
};
