import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { getRenderPipeline, getShaderModule } from '../render/gpu-cache.js';
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
    { name: 'seed', type: 'Float', default: 0 },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [
    { name: 'shape', type: 'Texture2D' },
    { name: 'veins', type: 'Texture2D' },
  ],
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
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage,
    });
    const veinsTexture = reusableTexture(device, prev?.veins, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage,
    });

    // 12 f32 = 48 bytes, 16-byte aligned. Matches the WGSL `Params`
    // struct field-for-field.
    const uniformData = new Float32Array(12);
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
    uniformData[11] = inputs.seed as number;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const module = getShaderModule(device, shader);
    const shapePipeline = getRenderPipeline(device, {
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_shape', targets: [{ format: TEXTURE_FORMAT }] },
    });
    const veinsPipeline = getRenderPipeline(device, {
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_veins', targets: [{ format: TEXTURE_FORMAT }] },
    });

    // Each pipeline has its own bind group layout (auto-derived from
    // its entry point), but the bindings are identical — same uniform
    // buffer on @binding(0) — so we build one bind group per pipeline.
    const shapeBindGroup = reusableBindGroup(
      device,
      prev?.__shapeBindGroup,
      shapePipeline.getBindGroupLayout(0),
      [uniformBuffer],
      () => [{ binding: 0, resource: uniformBuffer }],
    );
    const veinsBindGroup = reusableBindGroup(
      device,
      prev?.__veinsBindGroup,
      veinsPipeline.getBindGroupLayout(0),
      [uniformBuffer],
      () => [{ binding: 0, resource: uniformBuffer }],
    );

    const encoder = device.createCommandEncoder();
    {
      const pass = encoder.beginRenderPass({
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
