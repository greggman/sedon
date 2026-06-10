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
  label: 'leaf-skeleton-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};
import shader from './leaf-skeleton.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// leaf/skeleton — first node of the leaf authoring chain. Produces two
// Texture2Ds:
//   shape: greyscale leaf silhouette with alpha = AA mask. Downstream
//          uses the alpha channel as the leaf-inside indicator; the
//          preview shows a white silhouette over the checkerboard.
//   veins: greyscale vein density (midrib + N pairs of side veins),
//          clipped to inside the leaf and carrying the same alpha
//          mask. Preview shows the vein pattern as bright strokes
//          over a dark leaf-shaped background.
//
// Both outputs are evaluated by fragment shaders against a parametric
// half-width profile y^base × (1−y)^tip. By varying the two exponents
// the same node covers ovate (default), lanceolate (taller, narrower),
// obovate (peak above middle), etc. — and once we add a lobed-outline
// switch it'll cover oak/maple too. For V0 we ship the smooth ovate
// path only.
export const leafSkeletonNode: NodeDef = {
  id: 'leaf/skeleton',
  category: 'Leaf',
  inputs: [
    {
      name: 'length',
      type: 'Float',
      default: 1,
      description: 'vertical extent of the leaf within the texture; 1 fills ~90% top-to-bottom',
    },
    {
      name: 'width',
      type: 'Float',
      default: 0.2,
      description: 'peak half-width as a fraction of texture width (0.2 ≈ 40% wide at the widest point)',
    },
    {
      name: 'tipPointedness',
      type: 'Float',
      default: 1.4,
      description: 'higher = sharper, more pointed tip',
    },
    {
      name: 'baseCurvature',
      type: 'Float',
      default: 0.7,
      description: 'higher = more rounded base; lower = narrower at the petiole',
    },
    {
      name: 'branchCount',
      type: 'Int',
      default: 5,
      min: 0,
      description: 'number of side-vein pairs along the midrib',
    },
    {
      name: 'branchAngle',
      type: 'Float',
      default: 55,
      description: 'degrees of each primary vein from the midrib (0 = parallel-to-midrib, 90 = perpendicular)',
    },
    {
      name: 'branchCurve',
      type: 'Float',
      default: 0.7,
      description: '0 = straight veins, 1 = full outward-then-tipward arc',
    },
    {
      name: 'branchTaper',
      type: 'Float',
      default: 0.7,
      description: 'how much primary veins thin from base to tip (1 = sharp taper)',
    },
    {
      name: 'subBranchCount',
      type: 'Int',
      default: 8,
      min: 0,
      description: 'sub-veins (ladder ribs) per primary, evenly spaced; 0 disables sub-branching',
    },
    {
      name: 'subBranchCurveStart',
      type: 'Float',
      default: 0.05,
      description: 'forward bias (toward primary tip) of the FIRST sub-rib. 0 = perpendicular, ~0.5 = strong forward sweep',
    },
    {
      name: 'subBranchCurveGrowth',
      type: 'Float',
      default: 0.35,
      description: 'additional forward bias by the LAST sub-rib. Last rib total = start + growth',
    },
    {
      name: 'lobeCount',
      type: 'Int',
      default: 0,
      min: 0,
      description:
        'pinnate lobe pairs along the leaf. 0 = smooth profile (default ovate). Real-world references: oak ≈ 4, pin-oak ≈ 6, sweetgum ≈ 5. For palmate (maple) we don\'t have a primitive yet — use 3 here for a rough approximation',
    },
    {
      name: 'lobeDepth',
      type: 'Float',
      default: 0.6,
      description:
        '0..1, how deep the sinuses cut between lobes. 0 = no effect regardless of lobeCount; 1 = sinuses reach the midrib (deeply lobed, like pin-oak). Around 0.5 is a typical oak',
    },
    { name: 'seed', type: 'Float', default: 0 },
    { name: 'resolution', type: 'Int', default: 512, min: 1 },
  ],
  outputs: [
    {
      name: 'shape',
      type: 'Texture2D',
      description: 'greyscale leaf silhouette; alpha channel is the AA mask for the inside-of-leaf indicator. Downstream stages multiply against this to keep their output inside the leaf outline',
    },
    {
      name: 'veins',
      type: 'Texture2D',
      description: 'greyscale vein density (midrib + side veins + sub-veins), clipped to the leaf interior and carrying the same alpha mask as `shape`',
    },
  ],
  doc: {
    summary: 'Parametric leaf silhouette + vein pattern as two greyscale textures.',
    description: `
The first node of the leaf authoring chain. Produces two Texture2D
outputs:

- **shape** — greyscale silhouette with alpha = AA mask. The
  half-width profile is parametric: \`y^baseCurvature × (1−y)^tipPointedness\`
  scaled by \`width\`. Vary the two exponents to cover ovate (default),
  lanceolate (taller, narrower), obovate (peak above middle), etc.
  Set \`lobeCount > 0\` for pinnate lobed leaves like oak / sweetgum;
  \`lobeDepth\` controls how deep the sinuses cut.

- **veins** — midrib + \`branchCount\` pairs of primary side veins +
  \`subBranchCount\` ladder ribs per primary. \`branchAngle\` /
  \`branchCurve\` / \`branchTaper\` shape the primaries;
  \`subBranchCurveStart\` and \`subBranchCurveGrowth\` interpolate the
  sub-vein forward-bias from base to tip.

Both outputs are clipped to the silhouette so downstream stages
(distance-transform → ramp → colorize for albedo,
[tex/normal-from-height](../../tex/normal-from-height) for surface
detail) compose cleanly. The full chain ends in
[geom/leaf](../../geom/leaf) for a billboard-ready Geometry.

For sample chains see the leaf subgraphs in the editor demos —
\`oak-leaf\`, \`generic-broadleaf\`, etc. all build on this node.
`,
    sampleGraph: () => {
      const g = createGraph();
      // The leaf-skeleton's editor preview composites shape + veins
      // into a single visual; the docs preview falls back to the first
      // output (shape) via TexturePreview.
      addNode(g, 'leaf/skeleton', {
        id: 'skeleton',
        position: { x: 0, y: 0 },
        inputValues: {
          length: 1, width: 0.22, tipPointedness: 1.6,
          baseCurvature: 0.8,
          branchCount: 6, branchAngle: 55, branchCurve: 0.7,
          branchTaper: 0.75,
          subBranchCount: 10, subBranchCurveStart: 0.05, subBranchCurveGrowth: 0.35,
          lobeCount: 0, lobeDepth: 0.6,
          seed: 0, resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 'skeleton' };
    },
  },
  evaluate(ctx, inputs): {
    shape: Texture2DValue;
    veins: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __shapeBindGroup?: ReusableBindGroup;
    __veinsBindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const resolution = inputs.resolution as number;

    // Two outputs ⇒ inspect each previous output individually for
    // texture reuse. Same dims+format on both, so a re-eval that only
    // nudges parameters reuses both textures.
    const prev = ctx.previousOutput as
      | {
          shape?: Texture2DValue;
          veins?: Texture2DValue;
          __uniformBuffer?: GPUBuffer;
          __shapeBindGroup?: ReusableBindGroup;
          __veinsBindGroup?: ReusableBindGroup;
        }
      | undefined;
    const usage =
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC;
    const shapeTexture = reusableTexture(device, prev?.shape, {
      label: 'leaf-skeleton-shape-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage,
    });
    const veinsTexture = reusableTexture(device, prev?.veins, {
      label: 'leaf-skeleton-veins-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage,
    });

    // 16 f32 = 64 bytes, 16-byte aligned. Matches the WGSL `Params`
    // struct field-for-field. (Was 12 before lobe_count/lobe_depth
    // landed; the trailing seed entry stayed last for stability.)
    const uniformData = new Float32Array(16);
    uniformData[0] = inputs.length as number;
    uniformData[1] = inputs.width as number;
    uniformData[2] = inputs.tipPointedness as number;
    uniformData[3] = inputs.baseCurvature as number;
    uniformData[4] = inputs.branchCount as number;
    uniformData[5] = inputs.branchAngle as number;
    uniformData[6] = inputs.branchCurve as number;
    uniformData[7] = inputs.branchTaper as number;
    uniformData[8] = inputs.subBranchCount as number;
    uniformData[9] = inputs.subBranchCurveStart as number;
    uniformData[10] = inputs.subBranchCurveGrowth as number;
    uniformData[11] = inputs.lobeCount as number;
    uniformData[12] = inputs.lobeDepth as number;
    uniformData[13] = inputs.seed as number;
    // Indices 14, 15 are tail padding to keep the buffer at the next
    // 16-byte multiple. WGSL doesn't require it for a uniform of this
    // shape, but reusableBuffer + same-size reuse is cleaner if we
    // round to vec4 boundaries.

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const module = getShaderModule(device, shader);
    const { bindGroupLayout: bgl, pipeline: shapePipeline } = getPipelineWithLayout(
      device,
      UNIFORM_FRAG_BGL,
      (layout) => ({
        label: 'leaf-skeleton-pipeline-shape',
        layout,
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: 'fs_shape', targets: [{ format: TEXTURE_FORMAT }] },
      }),
    );
    const { pipeline: veinsPipeline } = getPipelineWithLayout(
      device,
      UNIFORM_FRAG_BGL,
      (layout) => ({
        label: 'leaf-skeleton-pipeline-veins',
        layout,
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: 'fs_veins', targets: [{ format: TEXTURE_FORMAT }] },
      }),
    );

    // Both pipelines share the same explicit bind-group layout, so
    // a single bind group is bindable on either — but we still keep
    // two cache slots (shape + veins) because reusableBindGroup
    // wraps the layout-identity check around the buffer refs and
    // only one slot would prematurely invalidate when both pass
    // identical refs.
    const shapeBindGroup = reusableBindGroup(
      device,
      prev?.__shapeBindGroup,
      bgl,
      [uniformBuffer],
      () => [{ binding: 0, resource: uniformBuffer }],
    );
    const veinsBindGroup = reusableBindGroup(
      device,
      prev?.__veinsBindGroup,
      bgl,
      [uniformBuffer],
      () => [{ binding: 0, resource: uniformBuffer }],
    );

    const encoder = device.createCommandEncoder({ label: 'leaf-skeleton-encoder' });
    {
      const pass = encoder.beginRenderPass({
        label: 'leaf-skeleton-pass-shape',
        colorAttachments: [
          {
            view: shapeTexture.texture,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      pass.setPipeline(shapePipeline);
      pass.setBindGroup(0, shapeBindGroup.bindGroup);
      pass.draw(3);
      pass.end();
    }
    {
      const pass = encoder.beginRenderPass({
        label: 'leaf-skeleton-pass-veins',
        colorAttachments: [
          {
            view: veinsTexture.texture,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      pass.setPipeline(veinsPipeline);
      pass.setBindGroup(0, veinsBindGroup.bindGroup);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);

    return {
      shape: shapeTexture,
      veins: veinsTexture,
      __uniformBuffer: uniformBuffer,
      __shapeBindGroup: shapeBindGroup,
      __veinsBindGroup: veinsBindGroup,
    };
  },
};
