import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice, reusableTexture } from '../core/resources.js';

// "Colors → ramp" helper. Builds an Nx1 RGBA texture from N Color
// inputs (positions evenly spaced) suitable for feeding into a
// `core/colorize` `ramp` input or anywhere else a 1D palette is
// needed.
//
// The use case `core/ramp` doesn't cover: PARAMETRIC colours. Ramp's
// gradient editor authors stop colours locally on the node — fine
// when authoring, useless inside a subgraph that wants its colours
// supplied by boundary inputs. Palette closes that gap: it just
// takes Color sockets and emits a ramp.
//
// Currently fixed at two colours (color_a, color_b → 2-pixel ramp).
// That's all the existing subgraphs need; an N-colour variant via
// extraInputsSpec can come later if it's actually wanted.

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

function toByte(c: number): number {
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

export const paletteNode: NodeDef = {
  id: 'core/palette',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'color_a',
      type: 'Color',
      default: [0, 0, 0, 1],
      description: 'colour at the LEFT end of the ramp (t = 0 when sampled)',
    },
    {
      name: 'color_b',
      type: 'Color',
      default: [1, 1, 1, 1],
      description: 'colour at the RIGHT end of the ramp (t = 1 when sampled)',
    },
  ],
  outputs: [
    {
      name: 'ramp',
      type: 'Texture2D',
      description: '2-pixel-wide Nx1 ramp texture with color_a on the left, color_b on the right. Consumers sample it with t ∈ [0, 1] (applying the half-texel offset so t=0/1 produce exactly the authored colours)',
    },
  ],
  doc: {
    summary: 'Two Color inputs → a 2-pixel ramp texture (parametric counterpart to core/ramp).',
    description:
      'Builds a tiny Nx1 RGBA texture from two Color inputs — colour_a maps to the left ' +
      'end, colour_b to the right. Plug the result into any node that takes a `ramp` input ' +
      '(core/colorize and friends) just like you would with a core/ramp output.\n\n' +
      'Why this exists alongside core/ramp: a Ramp node carries its gradient stops on the ' +
      'node itself, authored locally. That\'s great when authoring but useless inside a ' +
      'subgraph that wants its colours supplied by boundary inputs. Palette closes that ' +
      'gap by taking Color sockets instead — wire the subgraph\'s `colour_low` / `colour_high` ' +
      'inputs straight into a Palette and feed its output to a Colorize.',
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/palette', {
        id: 'palette',
        position: { x: 0, y: 0 },
        inputValues: { color_a: [0.12, 0.18, 0.40, 1], color_b: [0.95, 0.86, 0.34, 1] },
      });
      return { graph: g, rootNodeId: 'palette' };
    },
  },
  evaluate(ctx, inputs): { ramp: Texture2DValue } {
    const device = requireDevice(ctx);
    const a = inputs.color_a as [number, number, number, number];
    const b = inputs.color_b as [number, number, number, number];

    const prev = ctx.previousOutput as { texture?: Texture2DValue } | undefined;
    // 2-pixel texture: one stop per pixel. Consumers apply the
    // half-texel correction described in nodes/ramp.ts so the lerp
    // covers the full t ∈ [0, 1] range cleanly.
    const width = 2;
    const out = reusableTexture(device, prev?.texture, {
      width,
      height: 1,
      format: TEXTURE_FORMAT,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    const bytes = new Uint8Array(width * 4);
    bytes[0] = toByte(a[0]);
    bytes[1] = toByte(a[1]);
    bytes[2] = toByte(a[2]);
    bytes[3] = toByte(a[3]);
    bytes[4] = toByte(b[0]);
    bytes[5] = toByte(b[1]);
    bytes[6] = toByte(b[2]);
    bytes[7] = toByte(b[3]);
    device.queue.writeTexture(
      { texture: out.texture },
      bytes,
      { bytesPerRow: width * 4 },
      [width, 1],
    );

    return { ramp: out };
  },
};
