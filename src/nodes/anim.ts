import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';

// The `anim/*` family. Every node here emits a Float that varies
// with the editor's playback clock (see render-bus.ts —
// animationTime / animationDelta). Any node DOWNSTREAM of these
// re-evaluates each frame while the preview's Play/Pause is in Play,
// because their fingerprints inherit the upstream's
// `dynamicFingerprintExtra(time)` and miss the eval cache. The eval
// cache short-circuits everything that doesn't trace back to an
// anim node, so the per-frame cost stays scoped to the actually-
// time-dependent subgraph.
//
// Use with care: a graph that pipes `anim/time` into a million-
// vertex point-cloud generator re-bakes the cloud per frame on the
// CPU. Push time as deep as you can — ideally into a WGSL shader's
// uniform — and keep the CPU-side graph time-independent.

// ────────────────────────────────────────────────────────────────────
// anim/time — bare elapsed seconds since the preview started playing.
// ────────────────────────────────────────────────────────────────────

export const animTimeNode: NodeDef = {
  id: 'anim/time',
  category: 'Animation',
  inputs: [],
  outputs: [
    {
      name: 'time',
      type: 'Float',
      description:
        'elapsed seconds since the editor\'s Play started. Frozen while paused (toggle Play/Pause on the preview header). 0 the moment the editor is first loaded',
    },
  ],
  doc: {
    summary: 'Elapsed playback seconds — the seed for every animated effect.',
    description: `
Reads the same playback clock the renderer drives uniforms from.
While the preview is paused the output holds at its last value, so a
paused preview is genuinely frozen — not just hiding the loop.

**Cost warning.** Anything wired downstream of this node misses the
eval cache every frame while playing, and re-evaluates on the CPU.
That's fine for a handful of \`math/*\` and \`scene/transform\`
nodes; it's prohibitive for big point clouds, mesh generators, or
expensive procedural textures. For the latter, animate inside the
shader (pass time as a uniform) rather than re-baking the asset
per frame on the CPU. The doc page lists patterns to prefer / avoid.
`,
    sampleGraph: () => {
      const g = createGraph();
      const t = addNode(g, 'anim/time', { id: 't', position: { x: 0, y: 0 } });
      return { graph: g, rootNodeId: t.id };
    },
  },
  dynamicFingerprintExtra(_inputs, ctx) {
    // Mix the current time into the fingerprint so the eval cache
    // misses each frame the clock advances. Without this the node
    // would emit `0` forever (cached on its first miss).
    return `t:${ctx.animationTime ?? 0}`;
  },
  evaluate(ctx): { time: number } {
    return { time: ctx.animationTime ?? 0 };
  },
};

// ────────────────────────────────────────────────────────────────────
// anim/delta — seconds elapsed THIS frame (0 while paused).
// ────────────────────────────────────────────────────────────────────

export const animDeltaNode: NodeDef = {
  id: 'anim/delta',
  category: 'Animation',
  inputs: [],
  outputs: [
    {
      name: 'delta',
      type: 'Float',
      description:
        'real-time seconds elapsed since the previous frame. 0 while paused (the preview consumes no frames). Useful as the dt in a time-step integrator (sweep, lerp, decay) — `position += velocity * delta` advances the same distance per real-world second whether the frame budget is 60 fps or 30',
    },
  ],
  doc: {
    summary: 'Per-frame delta — for time-step integration that\'s frame-rate independent.',
    description: `
Computed by the render bus from the actual rAF timestamps. Most
useful as the \`dt\` in a delta-time integration:
\`new_position = old_position + velocity * delta\`. That formulation
moves the same world distance per real-world second regardless of
whether the preview is rendering at 60 fps or 30 fps.

Same cost profile as \`anim/time\` — re-evaluates every frame while
playing. If you only need elapsed seconds, use \`anim/time\` and
let the consumer compute delta numerically; this node is shorthand
for the integrator-style code path that wants the value direct.
`,
    sampleGraph: () => {
      const g = createGraph();
      const d = addNode(g, 'anim/delta', { id: 'd', position: { x: 0, y: 0 } });
      return { graph: g, rootNodeId: d.id };
    },
  },
  dynamicFingerprintExtra(_inputs, ctx) {
    // `time` rather than `delta` so two adjacent frames with the
    // same delta value (rare but possible at locked frame rates)
    // still produce different fingerprints — the underlying frame
    // identity is what matters for re-eval.
    return `t:${ctx.animationTime ?? 0}`;
  },
  evaluate(ctx): { delta: number } {
    return { delta: ctx.animationDelta ?? 0 };
  },
};

// ────────────────────────────────────────────────────────────────────
// anim/sine — sin wave generator.
// ────────────────────────────────────────────────────────────────────
//
// out = amplitude * sin(2π · frequency · time + phase) + offset
//
// Composes the four-node chain (`anim/time` → `math/multiply` (2π·f)
// → `math/add` (phase) → built-in sine → `math/multiply` (amplitude)
// → `math/add` (offset)) into one node. That's the chain authors
// reach for any time they want a breathing / pulsing / oscillating
// value, so the single-node form earns its place.

export const animSineNode: NodeDef = {
  id: 'anim/sine',
  category: 'Animation',
  inputs: [
    {
      name: 'frequency',
      type: 'Float',
      default: 1,
      description:
        'cycles per second. 1 = one full oscillation per second; 0.25 = one cycle every 4 seconds (slow breath). Negative values just reverse the phase',
    },
    {
      name: 'amplitude',
      type: 'Float',
      default: 1,
      description:
        'peak distance from the offset. The output sweeps from `offset − amplitude` to `offset + amplitude`',
    },
    {
      name: 'offset',
      type: 'Float',
      default: 0,
      description:
        'DC offset — the midpoint the wave oscillates around. Set to e.g. `1` if you\'re modulating a scale factor (output sweeps 0..2 with amplitude=1, offset=1)',
    },
    {
      name: 'phase',
      type: 'Float',
      default: 0,
      description:
        'phase shift in CYCLES (0..1 spans one full cycle). 0 starts at the offset rising; 0.25 starts at the peak; 0.5 starts at the offset falling. Useful when you want two waves a quarter-cycle apart (one breathing in while the other breathes out)',
    },
  ],
  outputs: [
    {
      name: 'value',
      type: 'Float',
      description: 'amplitude * sin(2π · frequency · time + 2π · phase) + offset',
    },
  ],
  doc: {
    summary: 'Sine-wave LFO — the everyday animated value (breath, pulse, sway).',
    description: `
Equivalent to the four-node chain
\`anim/time → math/multiply (2π · frequency) → math/add (2π · phase)
→ sin → math/multiply (amplitude) → math/add (offset)\`. The single-
node form keeps a "this position should bob up and down 5 cm at
2 Hz" wiring visually compact — common enough to be worth a node.

For non-sinusoidal waveforms (triangle, square, sawtooth — flicker,
blink, ramp) use [\`anim/lfo\`](../../anim/lfo) which adds a
\`waveform\` enum input.
`,
    sampleGraph: () => {
      const g = createGraph();
      const s = addNode(g, 'anim/sine', {
        id: 's',
        position: { x: 0, y: 0 },
        inputValues: { frequency: 1, amplitude: 1, offset: 0, phase: 0 },
      });
      return { graph: g, rootNodeId: s.id };
    },
  },
  dynamicFingerprintExtra(_inputs, ctx) {
    return `t:${ctx.animationTime ?? 0}`;
  },
  evaluate(ctx, inputs): { value: number } {
    const t = ctx.animationTime ?? 0;
    const f = (inputs.frequency as number) ?? 1;
    const a = (inputs.amplitude as number) ?? 1;
    const o = (inputs.offset as number) ?? 0;
    const p = (inputs.phase as number) ?? 0;
    return { value: a * Math.sin(2 * Math.PI * (f * t + p)) + o };
  },
};

// ────────────────────────────────────────────────────────────────────
// anim/lfo — waveform-selectable oscillator (sine / triangle /
// sawtooth / square).
// ────────────────────────────────────────────────────────────────────
//
// Generalises anim/sine with a waveform enum. Same amplitude /
// offset / phase semantics; the wave just shapes differently.

const WAVEFORM_SINE = 0;
const WAVEFORM_TRIANGLE = 1;
const WAVEFORM_SAWTOOTH = 2;
const WAVEFORM_SQUARE = 3;

export const animLfoNode: NodeDef = {
  id: 'anim/lfo',
  category: 'Animation',
  inputs: [
    {
      name: 'waveform',
      type: 'Int',
      default: WAVEFORM_SINE,
      enumOptions: [
        { value: WAVEFORM_SINE,     label: 'sine — smooth' },
        { value: WAVEFORM_TRIANGLE, label: 'triangle — linear ramp up/down' },
        { value: WAVEFORM_SAWTOOTH, label: 'sawtooth — linear ramp + snap' },
        { value: WAVEFORM_SQUARE,   label: 'square — instant flip' },
      ],
      description:
        'wave shape. Sine: smooth oscillation (same as `anim/sine`). Triangle: piecewise-linear bounce — sharper turnarounds than sine, but no discontinuity. Sawtooth: linear ramp then snap back to start — phase resets give a "tick" feel. Square: hard binary flip — blink on/off',
    },
    {
      name: 'frequency',
      type: 'Float',
      default: 1,
      description: 'cycles per second',
    },
    {
      name: 'amplitude',
      type: 'Float',
      default: 1,
      description: 'peak distance from offset',
    },
    {
      name: 'offset',
      type: 'Float',
      default: 0,
      description: 'midpoint the wave oscillates around',
    },
    {
      name: 'phase',
      type: 'Float',
      default: 0,
      description: 'phase shift in cycles (0..1 spans one full cycle)',
    },
  ],
  outputs: [
    {
      name: 'value',
      type: 'Float',
      description:
        'waveform-shaped oscillator. Range is `offset ± amplitude` for all waveforms — only the path between the bounds differs',
    },
  ],
  doc: {
    summary: 'Waveform-selectable LFO (sine / triangle / sawtooth / square).',
    description: `
Generalises \`anim/sine\` with a \`waveform\` enum so a single node
covers smooth and non-sinusoidal motion alike. The range is always
\`offset ± amplitude\` for every waveform — only the path between
the extremes changes:

- **sine** — smooth oscillation (identical to \`anim/sine\`)
- **triangle** — linear ramp up, linear ramp down. Sharp at the
  turnarounds, no discontinuity in value.
- **sawtooth** — linear ramp then a one-frame snap back to start.
  Use for repeated "tick" / "step" / "reset" cues.
- **square** — instantaneous flip between +amplitude and
  −amplitude. Use for blink on/off, strobe, hard gating.

Same per-frame cost as the other anim nodes — minimal, but compose
carefully (push time as deep as possible).
`,
    sampleGraph: () => {
      const g = createGraph();
      const n = addNode(g, 'anim/lfo', {
        id: 'lfo',
        position: { x: 0, y: 0 },
        inputValues: { waveform: WAVEFORM_TRIANGLE, frequency: 0.5, amplitude: 1, offset: 0, phase: 0 },
      });
      return { graph: g, rootNodeId: n.id };
    },
  },
  dynamicFingerprintExtra(_inputs, ctx) {
    return `t:${ctx.animationTime ?? 0}`;
  },
  evaluate(ctx, inputs): { value: number } {
    const t = ctx.animationTime ?? 0;
    const f = (inputs.frequency as number) ?? 1;
    const a = (inputs.amplitude as number) ?? 1;
    const o = (inputs.offset as number) ?? 0;
    const p = (inputs.phase as number) ?? 0;
    const waveform = (inputs.waveform as number) ?? WAVEFORM_SINE;

    // Normalised phase in [0, 1) — one full cycle. Wave functions
    // below all consume this and return a value in [-1, 1] that's
    // then scaled by amplitude and shifted by offset.
    let u = f * t + p;
    u -= Math.floor(u);

    let shaped: number;
    switch (waveform) {
      case WAVEFORM_TRIANGLE:
        // Two linear ramps: [0, 0.5] climbs −1 → +1, [0.5, 1] falls
        // +1 → −1. `4u − 1` and `3 − 4u` give those segments.
        shaped = u < 0.5 ? 4 * u - 1 : 3 - 4 * u;
        break;
      case WAVEFORM_SAWTOOTH:
        // Linear ramp: −1 at the start, +1 just before the snap.
        shaped = 2 * u - 1;
        break;
      case WAVEFORM_SQUARE:
        shaped = u < 0.5 ? 1 : -1;
        break;
      case WAVEFORM_SINE:
      default:
        shaped = Math.sin(2 * Math.PI * u);
        break;
    }
    return { value: a * shaped + o };
  },
};
