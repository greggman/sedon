import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice, reusableTexture } from '../core/resources.js';
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
  evaluate(ctx, inputs): { texture: Texture2DValue } {
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

    const prev = ctx.previousOutput as { texture?: Texture2DValue } | undefined;
    const outTexture = reusableTexture(device, prev?.texture, {
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage,
    });

    // Two intermediate textures for the JFA ping-pong. Created fresh
    // each eval — JFA only needs them for this one node's pipeline.
    // (Could pool them per-device if profiling shows allocation cost.)
    const makeIntermediate = () =>
      device.createTexture({
        size: [resolution, resolution],
        format: TEXTURE_FORMAT,
        usage,
      });
    const a = makeIntermediate();
    const b = makeIntermediate();
    const aView = a.createView();
    const bView = b.createView();

    // One uniform buffer, rewritten between passes (only `step` changes
    // between JFA iterations; threshold + max_distance + invert are
    // constant for the entire eval).
    const uniformData = new Float32Array(8);
    uniformData[0] = 1 / resolution;
    uniformData[1] = 1 / resolution;
    uniformData[3] = threshold;
    uniformData[4] = maxDistance;
    uniformData[5] = invert ? 1 : 0;
    const uniformBuffer = device.createBuffer({
      size: uniformData.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const writeStep = (step: number) => {
      uniformData[2] = step;
      device.queue.writeBuffer(uniformBuffer, 0, uniformData as BufferSource);
    };

    const sampler = device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Three pipelines share the same shader module + bind group layout
    // (one uniform, one texture, one sampler at @group(0)). Only the
    // fragment entry point differs between them.
    const module = device.createShaderModule({ code: shader });
    const makePipeline = (entry: string): GPURenderPipeline =>
      device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs_main' },
        fragment: { module, entryPoint: entry, targets: [{ format: TEXTURE_FORMAT }] },
      });
    const initPipeline = makePipeline('fs_init');
    const jfaPipeline = makePipeline('fs_jfa');
    const finalPipeline = makePipeline('fs_final');

    const makeBindGroup = (
      pipeline: GPURenderPipeline,
      srcView: GPUTextureView,
    ): GPUBindGroup =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer } },
          { binding: 1, resource: srcView },
          { binding: 2, resource: sampler },
        ],
      });

    const fullScreen = (
      enc: GPUCommandEncoder,
      pipeline: GPURenderPipeline,
      view: GPUTextureView,
      bg: GPUBindGroup,
    ) => {
      const pass = enc.beginRenderPass({
        colorAttachments: [
          {
            view,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
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
      const bg = makeBindGroup(initPipeline, src.view);
      writeStep(0);
      fullScreen(enc, initPipeline, aView, bg);
      device.queue.submit([enc.finish()]);
    }

    // JFA passes. Step halves each iteration; total ≈ log2(resolution).
    // We submit each pass separately so the read/write of the previous
    // pass is guaranteed visible — WebGPU's submission boundary is the
    // synchronization point.
    let readView = aView;
    let writeView = bView;
    const startStep = Math.floor(resolution / 2);
    for (let step = startStep; step >= 1; step = Math.floor(step / 2)) {
      const enc = device.createCommandEncoder();
      writeStep(step);
      const bg = makeBindGroup(jfaPipeline, readView);
      fullScreen(enc, jfaPipeline, writeView, bg);
      device.queue.submit([enc.finish()]);
      // Swap.
      const tmp = readView;
      readView = writeView;
      writeView = tmp;
      // The integer-divide loop terminates when step reaches 0; do an
      // extra pass at step=1 already covered above, no special case
      // needed since the loop runs while step >= 1.
      if (step === 1) break;
    }

    // Final: turn the last JFA result's seed-UVs into normalized
    // distances and write to the output texture.
    {
      const enc = device.createCommandEncoder();
      writeStep(0);
      const bg = makeBindGroup(finalPipeline, readView);
      fullScreen(enc, finalPipeline, outTexture.view, bg);
      device.queue.submit([enc.finish()]);
    }

    a.destroy();
    b.destroy();
    return { texture: outTexture };
  },
};
