import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { getRenderPipeline, getSampler, getShaderModule } from '../render/gpu-cache.js';
import shader from './distance-transform.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// core/distance-transform — for each pixel, the Euclidean distance to
// the nearest pixel above `threshold` in the input. Output is greyscale
// 0..1 normalized by `maxDistance` (in UV units).
//
// Uses the Jump Flood Algorithm: an init pass that marks seed pixels,
// then log2(resolution) ping-pong passes propagating seed UVs over
// halving distances, then a final pass that turns the per-pixel seed
// UV into a normalized distance value. Total passes ≈ 11 at 512² —
// fast enough to use freely.
//
// Useful for: leaf cell gradients (distance from nearest vein), soft
// dilations, antialiased mask refinement, glow ramps that scale by
// distance rather than Gaussian falloff.
export const distanceTransformNode: NodeDef = {
  id: 'core/distance-transform',
  category: 'Texture/Filters',
  inputs: [
    { name: 'texture', type: 'Texture2D' },
    {
      name: 'threshold',
      type: 'Float',
      default: 0.5,
      description: 'pixels with R > threshold become seeds (distance 0)',
    },
    {
      name: 'maxDistance',
      type: 'Float',
      default: 0.15,
      description:
        'UV-space distance that maps to 1.0 in the output. Distances beyond clamp to 1.',
    },
    {
      name: 'invert',
      type: 'Bool',
      default: false,
      description:
        'false (default) outputs distance (0 at seed, 1 far away). true outputs proximity (1 at seed, 0 far) — useful when the next stage wants seeds to read as bright/highlights.',
    },
    { name: 'resolution', type: 'Int', default: 512 },
  ],
  outputs: [{ name: 'texture', type: 'Texture2D' }],
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __jfa?: [Texture2DValue, Texture2DValue];
    __uniformBuffer?: GPUBuffer;
    __initBg?: ReusableBindGroup;
    __jfaBgA?: ReusableBindGroup;
    __jfaBgB?: ReusableBindGroup;
    __finalBgA?: ReusableBindGroup;
    __finalBgB?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.texture as Texture2DValue;
    const threshold = inputs.threshold as number;
    const maxDistance = inputs.maxDistance as number;
    const invert = inputs.invert as boolean;
    const resolution = inputs.resolution as number;

    const usage =
      GPUTextureUsage.RENDER_ATTACHMENT |
      GPUTextureUsage.TEXTURE_BINDING |
      GPUTextureUsage.COPY_SRC;

    const prev = ctx.previousOutput as
      | {
          texture?: Texture2DValue;
          __jfa?: [Texture2DValue, Texture2DValue];
          __uniformBuffer?: GPUBuffer;
          __initBg?: ReusableBindGroup;
          __jfaBgA?: ReusableBindGroup;
          __jfaBgB?: ReusableBindGroup;
          __finalBgA?: ReusableBindGroup;
          __finalBgB?: ReusableBindGroup;
        }
      | undefined;
    const outTexture = reusableTexture(device, prev?.texture, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage,
    });

    // Two intermediate textures for the JFA ping-pong. Reused via the
    // eval cache: stash both on the output under `__jfa` so the next
    // eval at the same resolution reuses them. Reusable textures are
    // also subject to sweep destruction when this node's outputs are
    // evicted.
    const jfaDesc = {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage,
    };
    const a = reusableTexture(device, prev?.__jfa?.[0], jfaDesc);
    const b = reusableTexture(device, prev?.__jfa?.[1], jfaDesc);
    const aView = a.texture;
    const bView = b.texture;

    // One uniform buffer, rewritten between passes (only `step` changes
    // between JFA iterations; threshold + max_distance + invert are
    // constant for the entire eval).
    const uniformData = new Float32Array(8);
    uniformData[0] = 1 / resolution;
    uniformData[1] = 1 / resolution;
    uniformData[3] = threshold;
    uniformData[4] = maxDistance;
    uniformData[5] = invert ? 1 : 0;
    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );
    const writeStep = (step: number) => {
      uniformData[2] = step;
      device.queue.writeBuffer(uniformBuffer, 0, uniformData as BufferSource);
    };

    const sampler = getSampler(device, {
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Three pipelines share the same shader module + bind group layout
    // (one uniform, one texture, one sampler at @group(0)). Only the
    // fragment entry point differs between them.
    const module = getShaderModule(device, shader);
    const makePipeline = (entry: string): GPURenderPipeline =>
      getRenderPipeline(device, {
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: entry, targets: [{ format: TEXTURE_FORMAT }] },
      });
    const initPipeline = makePipeline('fs_init');
    const jfaPipeline = makePipeline('fs_jfa');
    const finalPipeline = makePipeline('fs_final');

    const buildEntries = (srcView: GPUTexture) => () => [
      { binding: 0, resource: uniformBuffer },
      { binding: 1, resource: srcView },
      { binding: 2, resource: sampler },
    ];
    // Five long-lived bind groups, one per purpose. The JFA passes
    // need two because the loop swaps which texture is being READ
    // each iteration; same for the final pass since its read source
    // depends on the loop's parity. All five are stable across edits
    // because uniformBuffer / aView / bView / src.texture / sampler
    // are all reused via reusableBuffer / reusableTexture / getSampler.
    const initBg = reusableBindGroup(
      device,
      prev?.__initBg,
      initPipeline.getBindGroupLayout(0),
      [uniformBuffer, src.texture, sampler],
      buildEntries(src.texture),
    );
    const jfaBgA = reusableBindGroup(
      device,
      prev?.__jfaBgA,
      jfaPipeline.getBindGroupLayout(0),
      [uniformBuffer, aView, sampler],
      buildEntries(aView),
    );
    const jfaBgB = reusableBindGroup(
      device,
      prev?.__jfaBgB,
      jfaPipeline.getBindGroupLayout(0),
      [uniformBuffer, bView, sampler],
      buildEntries(bView),
    );
    const finalBgA = reusableBindGroup(
      device,
      prev?.__finalBgA,
      finalPipeline.getBindGroupLayout(0),
      [uniformBuffer, aView, sampler],
      buildEntries(aView),
    );
    const finalBgB = reusableBindGroup(
      device,
      prev?.__finalBgB,
      finalPipeline.getBindGroupLayout(0),
      [uniformBuffer, bView, sampler],
      buildEntries(bView),
    );

    const fullScreen = (
      enc: GPUCommandEncoder,
      pipeline: GPURenderPipeline,
      view: GPUTextureView | GPUTexture,
      bg: GPUBindGroup,
    ) => {
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bg);
      pass.draw(3);
      pass.end();
    };

    // Init: read original input → write seed UVs into texture A.
    {
      const enc = device.createCommandEncoder();
      writeStep(0);
      fullScreen(enc, initPipeline, aView, initBg.bindGroup);
      device.queue.submit([enc.finish()]);
    }

    // JFA passes. Step halves each iteration; total ≈ log2(resolution).
    // We submit each pass separately so the read/write of the previous
    // pass is guaranteed visible — WebGPU's submission boundary is the
    // synchronization point.
    let readView = aView;
    let writeView = bView;
    let readBg = jfaBgA.bindGroup; // tracks which bind group goes with readView
    let writeBg = jfaBgB.bindGroup;
    const startStep = Math.floor(resolution / 2);
    for (let step = startStep; step >= 1; step = Math.floor(step / 2)) {
      const enc = device.createCommandEncoder();
      writeStep(step);
      fullScreen(enc, jfaPipeline, writeView, readBg);
      device.queue.submit([enc.finish()]);
      // Swap.
      const tmpView = readView;
      readView = writeView;
      writeView = tmpView;
      const tmpBg = readBg;
      readBg = writeBg;
      writeBg = tmpBg;
      // The integer-divide loop terminates when step reaches 0; do an
      // extra pass at step=1 already covered above, no special case
      // needed since the loop runs while step >= 1.
      if (step === 1) break;
    }

    // Final: turn the last JFA result's seed-UVs into normalized
    // distances and write to the output texture. Pick the bind group
    // matching whichever JFA texture ended up as `readView`.
    {
      const enc = device.createCommandEncoder();
      writeStep(0);
      const finalBg = readView === aView ? finalBgA.bindGroup : finalBgB.bindGroup;
      fullScreen(enc, finalPipeline, outTexture.texture, finalBg);
      device.queue.submit([enc.finish()]);
    }

    // a, b stay alive in the returned outputs so the next eval can
    // reuse them. The cache sweep destroys them when this node's
    // outputs are finally evicted.
    return {
      texture: outTexture,
      __jfa: [a, b],
      __uniformBuffer: uniformBuffer,
      __initBg: initBg,
      __jfaBgA: jfaBgA,
      __jfaBgB: jfaBgB,
      __finalBgA: finalBgA,
      __finalBgB: finalBgB,
    };
  },
};
