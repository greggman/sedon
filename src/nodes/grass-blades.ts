import { addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { ShaderStage, getPipelineWithLayout, getShaderModule } from '../render/gpu-cache.js';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'grass-blades-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};
import shader from './grass-blades.wgsl';

// Procedural blade-card texture for core/grass. Renders tapered,
// leaning blades with an ALPHA SILHOUETTE so the grass shader's
// alpha-cut carves out individual leaves (vs the solid quads you get
// feeding it a plain texture). RGB is a base→tip gradient; the grass
// node can multiply its own tint on top (set that tint near-white to
// use these colours directly).
const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const grassBladesNode: NodeDef = {
  id: 'core/grass-blades',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'bladeCount',
      type: 'Int',
      default: 5,
      min: 0,
      description: 'how many blades draw inside the card. 3 reads as sparse tufts; 8+ as a tight clump',
    },
    {
      name: 'baseColor',
      type: 'Color',
      default: [0.12, 0.3, 0.08, 1],
      description: 'colour at the bottom of each blade',
    },
    {
      name: 'tipColor',
      type: 'Color',
      default: [0.55, 0.78, 0.32, 1],
      description: 'colour at the tip of each blade — typically lighter / yellower for sun-bleached realism',
    },
    {
      name: 'width',
      type: 'Float',
      default: 1,
      description: 'blade width multiplier; >1 makes broader leaves, <1 thinner spikes',
    },
    {
      name: 'lean',
      type: 'Float',
      default: 0.15,
      description: 'how far the tips sweep sideways from the base. 0 = straight up; higher = wind-pressed look',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'random seed; varies blade positions, leans, and per-blade jitter',
    },
    {
      name: 'resolution',
      type: 'Int',
      default: 256,
      min: 1,
      description: 'output texture width and height. 256 is fine for distance grass; 512 for hero close-ups',
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description: 'a single blade card: RGB is the base→tip gradient, A is the per-blade silhouette. Wire into [core/grass](../../core/grass)\'s `card_0` (or any `card_N`) input',
    },
  ],
  doc: {
    summary: 'Procedural blade-card texture for core/grass — tapered blades with alpha silhouette.',
    description: `
The default card art for [core/grass](../../core/grass). Renders
\`bladeCount\` tapered blades into an RGBA texture: RGB is a base→tip
colour gradient, A is the per-blade silhouette. The alpha is what
makes grass actually look like grass — without it the grass shader's
quad would render as a solid rectangle.

Use multiple instances with different seeds / colors / blade counts
to author a varied grass field (each one feeds a separate \`card_N\`
on [core/grass](../../core/grass); the field's typeMap picks which
card each blade samples). For exotic plants — clover, ferns, dry
straw — author the card art externally and feed that texture in
directly instead.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'core/grass-blades', {
        id: 'blades',
        position: { x: 0, y: 0 },
        inputValues: {
          bladeCount: 5,
          baseColor: [0.12, 0.3, 0.08, 1],
          tipColor: [0.55, 0.78, 0.32, 1],
          width: 1,
          lean: 0.15,
          seed: 0,
          resolution: 256,
        },
      });
      return { graph: g, rootNodeId: 'blades' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const baseColor = inputs.baseColor as [number, number, number, number];
    const tipColor = inputs.tipColor as [number, number, number, number];
    const bladeCount = inputs.bladeCount as number;
    const width = inputs.width as number;
    const lean = inputs.lean as number;
    const seed = inputs.seed as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'grass-blades-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // Params: baseColor(4) + tipColor(4) + cfg(bladeCount,width,lean,seed)
    const uniformData = new Float32Array(12);
    uniformData.set(baseColor, 0);
    uniformData.set(tipColor, 4);
    uniformData[8] = bladeCount;
    uniformData[9] = width;
    uniformData[10] = lean;
    uniformData[11] = seed;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const module = getShaderModule(device, shader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_FRAG_BGL,
      (layout) => ({
        label: 'grass-blades-pipeline',
        layout,
        vertex: { module },
        fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
      }),
    );

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      bgl,
      [uniformBuffer],
      () => [{ binding: 0, resource: uniformBuffer }],
    );

    const encoder = device.createCommandEncoder({ label: 'grass-blades-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'grass-blades-pass',
      colorAttachments: [
        { view: out.texture, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup.bindGroup);
    pass.draw(3);
    pass.end();
    device.queue.submit([encoder.finish()]);

    return { texture: out, __uniformBuffer: uniformBuffer, __bindGroup: bindGroup };
  },
};
