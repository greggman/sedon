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
import checkerShader from './checker.wgsl';

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

// Single uniform at binding 0, fragment-only. Explicit so the
// pipeline layout is a stable identity — `layout: 'auto'` would
// hand out a new layout per pipeline that's only compatible with
// bind groups created from that exact pipeline's
// getBindGroupLayout call, defeating any cross-evaluation reuse.
const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'checker-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

// Two-tone checkerboard. Same GPU plumbing as tex/grid (full-
// screen triangle + one tiny uniform buffer); the fragment shader
// just toggles between the two colours based on cell parity instead
// of drawing line strokes. Useful for crosswalk stripes, tiled
// floors, and any "alternating two-colour" cell pattern that a
// `tex/grid` with line_width=0.5 would approximate but not nail.
export const checkerNode: NodeDef = {
  id: 'tex/checker',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'fg',
      type: 'Color',
      default: [1, 1, 1, 1],
      description: 'colour of the cells where (col + row) is even',
    },
    {
      name: 'bg',
      type: 'Color',
      default: [0, 0, 0, 1],
      description: 'colour of the cells where (col + row) is odd',
    },
    {
      name: 'divisions',
      type: 'Vec2i',
      default: [8, 8],
      description: 'number of cells along X and Y. [8, 8] = 8×8 board; can be asymmetric ([16, 1] gives alternating vertical stripes)',
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
      description: 'a checkerboard texture: fg and bg alternating per cell',
    },
  ],
  doc: {
    summary: 'A 2D checkerboard texture — two cell colours, divisions, resolution.',
    description: `
Renders a configurable checkerboard into an N×N texture. The two colours
alternate per cell; \`divisions\` picks how many cells span the texture.

The natural fit for crosswalk stripes (set \`divisions: [8, 1]\` with
white-on-asphalt), tile floors, and any other two-tone alternating
pattern. For grid LINES (rather than alternating cells), use \`tex/grid\`
instead — it draws strokes between cells.
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/checker', {
        id: 'checker',
        position: { x: 0, y: 0 },
        inputValues: {
          fg: [0.95, 0.95, 0.97, 1],
          bg: [0.10, 0.10, 0.12, 1],
          divisions: [8, 8],
          resolution: 256,
        },
      });
      return { graph: g, rootNodeId: 'checker' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const fg = inputs.fg as [number, number, number, number];
    const bg = inputs.bg as [number, number, number, number];
    const divisions = inputs.divisions as [number, number];
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'checker-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // 16-byte-aligned uniform: vec4 fg, vec4 bg, vec2 divisions, 2×f32 pad.
    const uniformData = new Float32Array(12);
    uniformData.set(fg, 0);
    uniformData.set(bg, 4);
    uniformData[8] = divisions[0];
    uniformData[9] = divisions[1];
    uniformData[10] = 0;
    uniformData[11] = 0;

    const uniformBuffer = reusableBuffer(
      device,
      prev?.__uniformBuffer,
      uniformData as BufferSource,
      GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    );

    const module = getShaderModule(device, checkerShader);
    const { bindGroupLayout: bgl, pipeline } = getPipelineWithLayout(
      device,
      UNIFORM_FRAG_BGL,
      (layout) => ({
        label: 'checker-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'checker-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'checker-pass',
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
