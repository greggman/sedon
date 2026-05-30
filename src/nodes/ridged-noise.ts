import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { getRenderPipeline, getShaderModule } from '../render/gpu-cache.js';
import shader from './ridged-noise.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// Ridged fBm — same lattice/wrap/uniform layout as core/perlin, but the
// inner fBm sum uses `(1 - abs(perlin))²` per octave and weights each
// octave by the previous one (Musgrave's ridged multifractal). Produces
// sharp creases instead of soft hills — perfect for mountain spines,
// rock-fracture patterns, dry-riverbed networks (inverted).
export const ridgedNoiseNode: NodeDef = {
  id: 'core/ridged-noise',
  category: 'Texture/Noise',
  inputs: [
    {
      name: 'scale',
      type: 'Vec2',
      default: [4, 4],
      description: 'tiling frequency per axis. Integers only — fractional periods would break tileability and get rounded',
    },
    {
      name: 'octaves',
      type: 'Int',
      default: 5,
      min: 1,
      description: 'how many ridged layers stack on top of each other. More octaves add finer crease detail; 1 gives a single set of broad ridges',
    },
    {
      name: 'lacunarity',
      type: 'Float',
      default: 2,
      description: 'frequency multiplier between octaves. 2 = each octave doubles the ridge density',
    },
    {
      name: 'gain',
      type: 'Float',
      default: 0.5,
      description: 'amplitude multiplier between octaves. <0.5 yields a few dominant ridges; higher keeps every octave loud (busy result)',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'random seed offset. Change to get a different ridge pattern at the same scale/octaves',
    },
    {
      name: 'resolution',
      type: 'Int',
      default: 512,
      min: 1,
      description: 'output texture width and height in pixels',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'ridged-multifractal noise in [0, 1]: sharp bright creases where Perlin noise crosses zero, dark valleys between them',
    },
  ],
  doc: {
    summary: 'Ridged-multifractal noise — sharp creases instead of soft hills.',
    description: `
Same lattice and tiling layout as [core/perlin](../../core/perlin), but each
octave is folded through \`(1 − |perlin|)²\` and weighted by the previous
octave's value (Musgrave's ridged multifractal). The result has sharp bright
ridges where the underlying Perlin noise crosses zero, with each successive
octave only adding detail where the previous octave was already bright —
concentrating creases along major spines.

Perfect for mountain ridges and rock-fracture patterns when used as a
heightfield directly, or as the input to a
[core/texture-to-heightfield-mesh](../../core/texture-to-heightfield-mesh) chain. Invert
(1 − result) and you get a dry-riverbed network of dark grooves on a light
plateau.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/ridged-noise', {
        id: 'ridged',
        position: { x: 0, y: 0 },
        inputValues: { scale: [4, 4], octaves: 5, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      return { graph: g, rootNodeId: 'ridged' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const resolution = inputs.resolution as number;

    const rawScale = inputs.scale as number | [number, number];
    const scale: [number, number] =
      typeof rawScale === 'number' ? [rawScale, rawScale] : rawScale;

    // Reuse the previously-allocated texture when dims+format are
    // unchanged — same texture object, new contents rendered in.
    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const outputTexture = reusableTexture(device, prev?.texture, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Params layout matches core/perlin: scale vec2 (8B) + octaves,
    // lacunarity, gain, seed (4 × 4B = 16B) = 24B padded to 32 to meet
    // the 16-byte uniform minimum.
    const uniformData = new Float32Array(8);
    uniformData[0] = scale[0];
    uniformData[1] = scale[1];
    uniformData[2] = inputs.octaves as number;
    uniformData[3] = inputs.lacunarity as number;
    uniformData[4] = inputs.gain as number;
    uniformData[5] = inputs.seed as number;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const module = getShaderModule(device, shader);
    const pipeline = getRenderPipeline(device, {
      layout: 'auto',
      vertex: { module },
      fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
    });

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      pipeline.getBindGroupLayout(0),
      [uniformBuffer],
      () => [{ binding: 0, resource: uniformBuffer }],
    );

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: outputTexture.texture,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: [0, 0, 0, 0],
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup.bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return {
      texture: outputTexture,
      __uniformBuffer: uniformBuffer,
      __bindGroup: bindGroup,
    };
  },
};
