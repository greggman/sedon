import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { ReusableBindGroup, Texture2DValue } from '../core/resources.js';
import {
  requireDevice,
  reusableBindGroup,
  reusableBuffer,
  reusableTexture,
} from '../core/resources.js';
import { ShaderStage, getPipelineWithLayout, getSampler, getShaderModule } from '../render/gpu-cache.js';
import shader from './tex-transform.wgsl';

const UNIFORM_TEX_SAMP_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'tex-transform-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
    { binding: 1, visibility: ShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    { binding: 2, visibility: ShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// Resample an input texture under a 2D pivot/scale/rotate/translate
// UV transform. Distinct from `geom/uv-transform`, which multiplies a
// mesh's stored UV attribute — this one runs in texture space and
// rewrites the output of any tex/* node.
export const texTransformNode: NodeDef = {
  id: 'tex/transform',
  category: 'Texture/Filters',
  inputs: [
    {
      name: 'input',
      type: 'Texture2D',
      description: 'source texture to resample',
    },
    {
      name: 'pivot',
      type: 'Vec2',
      default: [0.5, 0.5],
      description: 'pivot point in UV units. Scale and rotation happen around this point. [0.5, 0.5] = image centre',
    },
    {
      name: 'scale',
      type: 'Vec2',
      default: [1, 1],
      description: 'UV scale around pivot. >1 zooms in (texture appears larger), <1 zooms out (texture tiles). Negative flips on that axis',
    },
    {
      name: 'rotation',
      type: 'Float',
      default: 0,
      description: 'rotation around pivot in radians. Positive = counter-clockwise',
    },
    {
      name: 'translate',
      type: 'Vec2',
      default: [0, 0],
      description: 'translation in UV units, applied after scale/rotation. [0.5, 0] shifts the image half a width to the right',
    },
    {
      name: 'edge_mode',
      type: 'Int',
      default: 0,
      description: 'what to sample outside the [0,1] uv range',
      enumOptions: [
        { value: 0, label: 'repeat (tile)' },
        { value: 1, label: 'clamp to edge' },
        { value: 2, label: 'background colour' },
      ],
    },
    {
      name: 'bg_color',
      type: 'Color',
      default: [0, 0, 0, 0],
      description: 'background colour when edge_mode = background colour. Default transparent black',
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
      description: 'the input resampled with the given UV transform',
    },
  ],
  doc: {
    summary: 'Scale, rotate, and translate the UVs of an input texture before sampling.',
    description: `
The all-purpose 2D transform for textures. Use it to:

- Tile a base texture more or less densely (set \`scale\` > 1 to tile twice as
  fast on each axis, < 1 to upscale into one tile)
- Rotate a pattern (e.g. align brick rows to a wall direction)
- Shift a noise field for animation (drive \`translate.x\` from
  [anim/time](../../anim/time))
- Flip horizontally / vertically (negative scale)

Distinct from [geom/uv-transform](../../geom/uv-transform), which rewrites
the mesh's stored UV attribute. This node runs entirely in texture space
on the output of any tex/* node — useful when you want to transform a
generated pattern before further texture ops, not after the mesh maps it.
`,
    sampleGraph: () => {
      const g = createGraph();
      const src = addNode(g, 'tex/perlin', {
        id: 'src',
        position: { x: 0, y: 0 },
        inputValues: { scale: [4, 4], octaves: 4, lacunarity: 2, gain: 0.5, seed: 0, resolution: 512 },
      });
      const xform = addNode(g, 'tex/transform', {
        id: 'xform',
        position: { x: 280, y: 0 },
        inputValues: {
          pivot: [0.5, 0.5],
          scale: [2, 2],
          rotation: Math.PI / 6,
          translate: [0, 0],
          edge_mode: 0,
          bg_color: [0, 0, 0, 0],
          resolution: 512,
        },
      });
      addEdge(g, { node: src.id, socket: 'texture' }, { node: xform.id, socket: 'input' });
      return { graph: g, rootNodeId: 'xform' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const src = inputs.input as Texture2DValue;
    const pivot = inputs.pivot as [number, number];
    const scale = inputs.scale as [number, number];
    const translate = inputs.translate as [number, number];
    const rotation = inputs.rotation as number;
    const edgeMode = inputs.edge_mode as number;
    const bg = inputs.bg_color as [number, number, number, number];
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'tex-transform-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec2 pivot(8) + vec2 scale(8) + vec2 translate(8) + f32 rot(4) +
    // f32 edge(4) + vec4 bg(16) = 48 bytes.
    const uniformData = new Float32Array(12);
    uniformData[0] = pivot[0];
    uniformData[1] = pivot[1];
    uniformData[2] = scale[0];
    uniformData[3] = scale[1];
    uniformData[4] = translate[0];
    uniformData[5] = translate[1];
    uniformData[6] = rotation;
    uniformData[7] = edgeMode;
    uniformData.set(bg, 8);

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer as GPUBuffer | undefined,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    // edge_mode 0 = repeat lives on the sampler; modes 1 (clamp) and 2
    // (bg) both use clamp here (mode 2's bg substitution happens in
    // shader).
    const sampler = getSampler(device, {
      label: 'tex-transform-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: edgeMode === 0 ? 'repeat' : 'clamp-to-edge',
      addressModeV: edgeMode === 0 ? 'repeat' : 'clamp-to-edge',
    });

    const module = getShaderModule(device, shader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_TEX_SAMP_BGL,
      (layout) => ({
        label: 'tex-transform-pipeline',
        layout,
        vertex: { module },
        fragment: { module, targets: [{ format: TEXTURE_FORMAT }] },
      }),
    );

    const bindGroup = reusableBindGroup(
      device,
      prev?.__bindGroup,
      bgl,
      [uniformBuffer, src.texture, sampler],
      () => [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: src.texture },
        { binding: 2, resource: sampler },
      ],
    );

    const encoder = device.createCommandEncoder({ label: 'tex-transform-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'tex-transform-pass',
      colorAttachments: [
        {
          view: out.texture,
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

    return { texture: out, __uniformBuffer: uniformBuffer, __bindGroup: bindGroup };
  },
};
