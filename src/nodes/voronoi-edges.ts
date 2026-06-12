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
import shader from './voronoi-edges.wgsl';

const UNIFORM_FRAG_BGL: GPUBindGroupLayoutDescriptor = {
  label: 'voronoi-edges-bgl',
  entries: [
    { binding: 0, visibility: ShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
  ],
};

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export const voronoiEdgesNode: NodeDef = {
  id: 'tex/voronoi-edges',
  category: 'Texture/Noise',
  inputs: [
    {
      name: 'cell_color',
      type: 'Color',
      default: [0.05, 0.07, 0.10, 1],
      description: 'colour inside each cell',
    },
    {
      name: 'edge_color',
      type: 'Color',
      default: [0.95, 0.93, 0.85, 1],
      description: 'colour along the cell boundaries',
    },
    {
      name: 'scale',
      type: 'Float',
      default: 8,
      min: 1,
      description: 'cell density across the texture. Rounded to integer for tileability',
    },
    {
      name: 'edge_width',
      type: 'Float',
      default: 0.04,
      min: 0,
      description: 'half-width of the edge band in cell-space units. 0 = pure binary lines (aliased); 0.04 = AA-style; 0.15+ = thick "ridge" look; very large values fade the edges out (the smoothstep never reaches 1)',
    },
    {
      name: 'jitter',
      type: 'Float',
      default: 1,
      min: 0,
      max: 1,
      description: 'how randomly the feature point can drift inside each cell. 0 = perfectly centred (regular grid edges); 1 = full cell-size jitter (natural voronoi cells)',
    },
    {
      name: 'seed',
      type: 'Float',
      default: 0,
      description: 'random offset of the feature points',
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
      description: 'voronoi cell edges (F2 − F1): bright lines where two nearest cells are equidistant, dark inside the cells',
    },
  ],
  doc: {
    summary: 'Voronoi cell EDGES — cracks, leather, dried mud, stained glass.',
    description: `
Where [tex/worley](../../tex/worley) outputs F1 (distance to nearest
feature point, giving you the cell BODIES as a gradient), this node
outputs F2 − F1 (distance gap between nearest and second-nearest), giving
you the cell EDGES.

The F2 − F1 metric is small at cell boundaries (the two nearest features
are roughly equidistant), and large in cell centres (one feature
dominates). Threshold that with \`edge_width\` and you get clean lines.

Use for:

- cracks in dried mud, stone, glass
- leather hide / reptile scales (low edge_width, low jitter)
- stained-glass lead lines (high edge_width, high jitter)
- mortar between irregular floor stones (chain through
  [tex/colorize](../../tex/colorize) to colour each cell)
`,
    sampleGraph: () => {
      const g = createGraph();
      addNode(g, 'tex/voronoi-edges', {
        id: 've',
        position: { x: 0, y: 0 },
        inputValues: {
          cell_color: [0.05, 0.07, 0.10, 1],
          edge_color: [0.95, 0.93, 0.85, 1],
          scale: 8,
          edge_width: 0.04,
          jitter: 1,
          seed: 0,
          resolution: 512,
        },
      });
      return { graph: g, rootNodeId: 've' };
    },
  },
  evaluate(ctx, inputs): {
    texture: Texture2DValue;
    __uniformBuffer?: GPUBuffer;
    __bindGroup?: ReusableBindGroup;
  } {
    const device = requireDevice(ctx);
    const cell = inputs.cell_color as [number, number, number, number];
    const edge = inputs.edge_color as [number, number, number, number];
    const scale = inputs.scale as number;
    const edgeWidth = inputs.edge_width as number;
    const jitter = inputs.jitter as number;
    const seed = inputs.seed as number;
    const resolution = inputs.resolution as number;

    const prev = ctx.previousOutput as {
      texture?: Texture2DValue;
      __uniformBuffer?: GPUBuffer;
      __bindGroup?: ReusableBindGroup;
    } | undefined;
    const out = reusableTexture(device, prev?.texture, {
      label: 'voronoi-edges-output-tex',
      width: resolution,
      height: resolution,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_SRC,
    });

    // vec4 cell (16) + vec4 edge (16) + 4 × f32 (16) + 4 pad (16) = 64 bytes.
    const uniformData = new Float32Array(16);
    uniformData.set(cell, 0);
    uniformData.set(edge, 4);
    uniformData[8] = scale;
    uniformData[9] = edgeWidth;
    uniformData[10] = jitter;
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
        label: 'voronoi-edges-pipeline',
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

    const encoder = device.createCommandEncoder({ label: 'voronoi-edges-encoder' });
    const pass = encoder.beginRenderPass({
      label: 'voronoi-edges-pass',
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
