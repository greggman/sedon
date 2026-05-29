import type { GeometryValue, GrassFieldValue } from '../core/resources.js';
import { multiply, type Mat4 } from './mat4.js';
import { uploadMeshToGpu } from './mesh.js';
import { generateGrassCard } from './grass-card.js';
import { getSampler } from './gpu-cache.js';
import grassCullCode from './grass-cull.wgsl';
import grassCode from './grass.wgsl';
import shadowPcfCode from './shadow-pcf.wgsl';

// Camera-relative GPU-driven grass. The node graph produces a
// GrassFieldValue (maps + tuning); this subsystem turns it into blades
// at draw time:
//
//   compute()  — once per field, a workgroup-per-candidate cull/populate
//                pass that atomic-appends survivors into an instance
//                storage buffer and the indirect-draw instanceCount.
//   draw()     — drawIndexedIndirect of the cross-quad card mesh, reading
//                each blade's placement from the instance buffer.
//
// All GPU buffers here are subsystem-owned scratch, sized to the field's
// candidate budget and reused every frame — they never enter the eval
// cache, so the sweep/destroy lifecycle that governs node outputs
// doesn't touch them.

// Number of card-array (re)blits since startup. A diagnostic so headless
// tests can assert that a card-content edit actually re-copies the array
// (see blitCards). Read via getGrassBlitCount(); exposed on window under
// ?debug=1.
let grassBlitCount = 0;
export function getGrassBlitCount(): number {
  return grassBlitCount;
}

const MAX_GRID = 1024; // candidateCount capped at 1024² ≈ 1.05M
const MAX_INSTANCES_CAP = 262144; // drawn-blade ceiling → 8 MB instance buffer
const INSTANCE_BYTES = 32; // 2× vec4f: posScale + data
const INDIRECT_BYTES = 20; // 5× u32: indexCount, instanceCount, firstIndex, baseVertex, firstInstance
const UNIFORM_BYTES = 192; // mat4 + 8× vec4

export interface GrassFrame {
  modelView: Mat4;
  projection: Mat4;
  /** Seconds; advances only while animation is playing (else frozen → no wind). */
  time: number;
}

export interface GrassSystem {
  /** Run the cull/populate compute pass for every field. Call BEFORE the color pass, with the frame encoder. */
  compute(encoder: GPUCommandEncoder, fields: GrassFieldValue[], frame: GrassFrame): void;
  /** Draw every field. Call INSIDE the color pass, after opaque geometry; group 0 (scene) must already be bound. */
  draw(pass: GPURenderPassEncoder, fields: GrassFieldValue[]): void;
  destroy(): void;
}

interface FieldSlot {
  uniformBuffer: GPUBuffer;
  instanceBuffer: GPUBuffer;
  instanceCapacity: number;
  indirectBuffer: GPUBuffer;
  cardArray: GPUTexture | null;
  /** Per-layer attachment views into cardArray, reused on every re-blit. */
  cardLayerViews: GPUTextureView[];
  /** Per-layer source→array blit bind groups, reused on every re-blit. */
  blitBindGroups: GPUBindGroup[];
  computeBindGroup: GPUBindGroup | null;
  renderBindGroup: GPUBindGroup | null;
  // GPU-OBJECT identity of the wired inputs. Changes only when something
  // is (re)allocated — a resolution/format change, a card added, or a
  // texture swapped — i.e. when the card array + bind groups must be
  // rebuilt from scratch.
  structKey: string;
  // VALUE-WRAPPER identity of the card inputs. A producing node that
  // re-evaluates returns a fresh Texture2DValue wrapper even when it
  // re-renders into the SAME GPUTexture (reusableTexture). Since the
  // card array is a one-time COPY of that content, a changed content key
  // means we must re-blit (editing grass-blades colours hits this).
  cardContentKey: string;
}

// GPU-object identities: stable across a node re-render that reuses its
// texture; changes only on (re)allocation. Drives card-array + bind-group
// (re)creation.
function structKey(f: GrassFieldValue): string {
  const cards = f.cards.map((c) => gpuId(c.texture)).join(',');
  const type = f.typeMap ? gpuId(f.typeMap.texture) : 'none';
  const density = gpuId(f.density.texture);
  const height = gpuId(f.heightTexture.texture);
  return `${cards}|${type}|${density}|${height}|${f.cards.length}`;
}

// Value-wrapper identities of just the cards: a fresh wrapper means the
// producing node re-evaluated (possibly with new pixels), so the array
// copy is stale. Drives the in-place re-blit.
function cardContentKey(f: GrassFieldValue): string {
  return f.cards.map((c) => gpuId(c)).join(',');
}

// Local stable-id table (the render gpu-cache one is fine too, but keep
// grass self-contained).
const ids = new WeakMap<object, number>();
let nextId = 0;
function gpuId(o: object): number {
  let id = ids.get(o);
  if (id === undefined) {
    id = ++nextId;
    ids.set(o, id);
  }
  return id;
}

// Tiny fullscreen-triangle blit so we can assemble the per-type cards
// into one texture-2d-array without requiring COPY_SRC on the source
// textures (a render-into-layer works for any TEXTURE_BINDING source).
const BLIT_WGSL = /* wgsl */ `
struct VsOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  let x = f32(i & 1u) * 4.0 - 1.0;
  let y = f32(i >> 1u) * 4.0 - 1.0;
  var o: VsOut;
  o.pos = vec4f(x, y, 0.0, 1.0);
  o.uv = vec2f((x + 1.0) * 0.5, 1.0 - (y + 1.0) * 0.5);
  return o;
}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
@fragment fn fs(in: VsOut) -> @location(0) vec4f { return textureSample(src, s, in.uv); }
`;

// Format-stable shared resources (pipelines, layouts, sampler, card
// mesh, blit, dummy texture) — cached once per device, exactly like
// the SceneRenderer's sharedState. Only the per-view slot buffers
// (instance/indirect/uniform, keyed to a specific camera) live on the
// per-renderer GrassSystem instance, since two views place grass
// differently and can't share those.
interface GrassShared {
  cardGeom: GeometryValue;
  sampler: GPUSampler;
  computeGroupLayout: GPUBindGroupLayout;
  computePipeline: GPUComputePipeline;
  renderGroupLayout: GPUBindGroupLayout;
  renderPipeline: GPURenderPipeline;
  blitGroupLayout: GPUBindGroupLayout;
  blitPipelineFor: (format: GPUTextureFormat) => GPURenderPipeline;
  dummyType: GPUTexture;
}
const sharedByDevice = new WeakMap<GPUDevice, GrassShared>();

function ensureShared(
  device: GPUDevice,
  sceneBindGroupLayout: GPUBindGroupLayout,
  hdrFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
): GrassShared {
  const existing = sharedByDevice.get(device);
  if (existing) return existing;
  const built = buildShared(device, sceneBindGroupLayout, hdrFormat, depthFormat);
  sharedByDevice.set(device, built);
  return built;
}

function buildShared(
  device: GPUDevice,
  sceneBindGroupLayout: GPUBindGroupLayout,
  hdrFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
): GrassShared {
  // Cross-quad card mesh — shared by every field, built once.
  const cardGeom: GeometryValue = uploadMeshToGpu(device, generateGrassCard(2));

  const sampler = getSampler(device, {
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  // ---- Compute pipeline (cull/populate) ----
  const computeGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 5, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 6, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
    ],
  });
  const cullModule = device.createShaderModule({ code: grassCullCode });
  const computePipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [computeGroupLayout] }),
    compute: { module: cullModule, entryPoint: 'main' },
  });

  // ---- Render pipeline (drawIndexedIndirect) ----
  const renderGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });
  // Concatenate the shared shadow PCF ahead of the grass shader (WGSL
  // has no #include) so grass can call sample_shadow() against the same
  // shadow map the rest of the scene uses — see pbr-kind.ts for the
  // same pattern.
  const renderModule = device.createShaderModule({ code: `${shadowPcfCode}\n${grassCode}` });
  const renderPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [sceneBindGroupLayout, renderGroupLayout],
    }),
    vertex: {
      module: renderModule,
      entryPoint: 'vs_main',
      buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
        { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
      ],
    },
    fragment: { module: renderModule, entryPoint: 'fs_main', targets: [{ format: hdrFormat }] },
    // Two-sided cross-quads; reverse-Z depth (compare 'greater'), write
    // depth so grass self-occludes and bloom's bright-pass sees it.
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: depthFormat, depthWriteEnabled: true, depthCompare: 'greater' },
  });

  // ---- Card-array assembly blit ----
  const blitModule = device.createShaderModule({ code: BLIT_WGSL });
  const blitGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });
  // blit format is resolved per field (matches the card format), so the
  // pipeline is built lazily + cached by format.
  const blitPipelines = new Map<GPUTextureFormat, GPURenderPipeline>();
  function blitPipelineFor(format: GPUTextureFormat): GPURenderPipeline {
    let p = blitPipelines.get(format);
    if (!p) {
      p = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [blitGroupLayout] }),
        vertex: { module: blitModule, entryPoint: 'vs' },
        fragment: { module: blitModule, entryPoint: 'fs', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      blitPipelines.set(format, p);
    }
    return p;
  }

  // 1×1 placeholder so the type-map binding is always valid even when a
  // field has no typeMap.
  const dummyType = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: dummyType }, new Uint8Array([0, 0, 0, 255]), { bytesPerRow: 4 }, [1, 1]);

  return {
    cardGeom, sampler,
    computeGroupLayout, computePipeline,
    renderGroupLayout, renderPipeline,
    blitGroupLayout, blitPipelineFor, dummyType,
  };
}

export function createGrassSystem(
  device: GPUDevice,
  sceneBindGroupLayout: GPUBindGroupLayout,
  hdrFormat: GPUTextureFormat,
  depthFormat: GPUTextureFormat,
): GrassSystem {
  const {
    cardGeom, sampler,
    computeGroupLayout, computePipeline,
    renderGroupLayout, renderPipeline,
    blitGroupLayout, blitPipelineFor, dummyType,
  } = ensureShared(device, sceneBindGroupLayout, hdrFormat, depthFormat);

  const slots: FieldSlot[] = [];
  const uniformScratch = new ArrayBuffer(UNIFORM_BYTES);
  const uf = new Float32Array(uniformScratch);
  const uu = new Uint32Array(uniformScratch);
  const indirectScratch = new Uint32Array(5);

  // Allocate the texture-2d-array plus the per-layer attachment views and
  // source→layer blit bind groups. These are stable while the card GPU
  // textures (and dims/format/layer count) are unchanged, so we keep them
  // on the slot and reuse them for every re-blit — no per-frame allocation.
  function createCardArray(field: GrassFieldValue): {
    cardArray: GPUTexture;
    cardLayerViews: GPUTextureView[];
    blitBindGroups: GPUBindGroup[];
  } {
    const w = field.cards[0]!.width;
    const h = field.cards[0]!.height;
    const layers = field.cards.length;
    const format = field.cards[0]!.format;
    const cardArray = device.createTexture({
      label: 'grass card array',
      size: [w, h, layers],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    const cardLayerViews: GPUTextureView[] = [];
    const blitBindGroups: GPUBindGroup[] = [];
    for (let i = 0; i < layers; i++) {
      cardLayerViews.push(
        cardArray.createView({ dimension: '2d', baseArrayLayer: i, arrayLayerCount: 1 }),
      );
      blitBindGroups.push(
        device.createBindGroup({
          layout: blitGroupLayout,
          entries: [
            { binding: 0, resource: field.cards[i]!.texture.createView() },
            { binding: 1, resource: sampler },
          ],
        }),
      );
    }
    return { cardArray, cardLayerViews, blitBindGroups };
  }

  // Copy each card's current pixels into its array layer. Cheap to re-run
  // (reuses the cached views + bind groups), so we call it whenever a card
  // node re-rendered new content into its reused texture.
  function blitCards(field: GrassFieldValue, slot: FieldSlot): void {
    // Diagnostic: count card-array copies so headless tests can assert a
    // colour edit actually re-blits (a WebGPU canvas can't be pixel-diffed
    // via toDataURL — the swap chain isn't preserved). One int increment
    // on an already-rare path; harmless in prod.
    grassBlitCount++;
    const format = field.cards[0]!.format;
    const pipeline = blitPipelineFor(format);
    const encoder = device.createCommandEncoder();
    for (let i = 0; i < field.cards.length; i++) {
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          { view: slot.cardLayerViews[i]!, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, slot.blitBindGroups[i]!);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
  }

  function ensureSlot(i: number, field: GrassFieldValue, instanceCapacity: number): FieldSlot {
    let slot = slots[i];
    if (!slot) {
      slot = {
        uniformBuffer: device.createBuffer({
          size: UNIFORM_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
        instanceBuffer: device.createBuffer({
          size: instanceCapacity * INSTANCE_BYTES,
          usage: GPUBufferUsage.STORAGE,
        }),
        instanceCapacity,
        indirectBuffer: device.createBuffer({
          size: INDIRECT_BYTES,
          usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
        cardArray: null,
        cardLayerViews: [],
        blitBindGroups: [],
        computeBindGroup: null,
        renderBindGroup: null,
        structKey: '',
        cardContentKey: '',
      };
      slots[i] = slot;
    }
    // Bind groups go stale (must be rebuilt) whenever a resource they
    // reference is reallocated: the instance buffer below, or the card
    // array further down.
    let bindGroupsStale = !slot.computeBindGroup || !slot.renderBindGroup;

    // Grow the instance buffer if the budget went up (e.g. spacing
    // lowered). Both bind groups reference it, so they must be rebuilt.
    if (instanceCapacity > slot.instanceCapacity) {
      slot.instanceBuffer.destroy();
      slot.instanceBuffer = device.createBuffer({
        size: instanceCapacity * INSTANCE_BYTES,
        usage: GPUBufferUsage.STORAGE,
      });
      slot.instanceCapacity = instanceCapacity;
      bindGroupsStale = true;
    }

    // (Re)allocate the card array + its views/blit groups only when the
    // GPU-object wiring changes; then blit. Otherwise, if a card node
    // re-rendered new pixels into its reused texture, re-blit into the
    // existing array (no allocation).
    const sk = structKey(field);
    if (sk !== slot.structKey || !slot.cardArray) {
      slot.cardArray?.destroy();
      const built = createCardArray(field);
      slot.cardArray = built.cardArray;
      slot.cardLayerViews = built.cardLayerViews;
      slot.blitBindGroups = built.blitBindGroups;
      blitCards(field, slot);
      slot.structKey = sk;
      slot.cardContentKey = cardContentKey(field);
      bindGroupsStale = true; // render bind group references the new array
    } else {
      const ck = cardContentKey(field);
      if (ck !== slot.cardContentKey) {
        blitCards(field, slot);
        slot.cardContentKey = ck;
      }
    }

    if (bindGroupsStale) {
      slot.computeBindGroup = device.createBindGroup({
        layout: computeGroupLayout,
        entries: [
          { binding: 0, resource: slot.uniformBuffer },
          { binding: 1, resource: slot.instanceBuffer },
          { binding: 2, resource: slot.indirectBuffer },
          { binding: 3, resource: sampler },
          { binding: 4, resource: field.density.texture.createView() },
          { binding: 5, resource: field.typeMap ? field.typeMap.texture.createView() : dummyType.createView() },
          { binding: 6, resource: field.heightTexture.texture.createView() },
        ],
      });
      slot.renderBindGroup = device.createBindGroup({
        layout: renderGroupLayout,
        entries: [
          { binding: 0, resource: slot.uniformBuffer },
          { binding: 1, resource: slot.instanceBuffer },
          { binding: 2, resource: slot.cardArray!.createView({ dimension: '2d-array' }) },
          { binding: 3, resource: sampler },
        ],
      });
    }
    return slot;
  }

  function cameraWorldPos(mv: Mat4): [number, number, number] {
    // modelView = R·world + t. Eye = -Rᵀ·t. Column-major Mat4:
    // m[col*4+row]; Rᵀ row i = (m[i*4+0], m[i*4+1], m[i*4+2]); t = (m12,m13,m14).
    const t0 = mv[12]!, t1 = mv[13]!, t2 = mv[14]!;
    return [
      -(mv[0]! * t0 + mv[1]! * t1 + mv[2]! * t2),
      -(mv[4]! * t0 + mv[5]! * t1 + mv[6]! * t2),
      -(mv[8]! * t0 + mv[9]! * t1 + mv[10]! * t2),
    ];
  }

  function compute(encoder: GPUCommandEncoder, fields: GrassFieldValue[], frame: GrassFrame): void {
    if (fields.length === 0) return;
    const viewProj = multiply(frame.projection, frame.modelView);
    const eye = cameraWorldPos(frame.modelView);

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      const spacing = Math.max(0.01, field.spacing);
      // Auto grid budget: cover a 2·maxDistance square at `spacing`,
      // capped so candidateCount stays bounded.
      const gridDim = Math.min(MAX_GRID, Math.max(1, Math.ceil((2 * field.maxDistance) / spacing)));
      const candidateCount = gridDim * gridDim;
      const instanceCapacity = Math.min(candidateCount, MAX_INSTANCES_CAP);
      const slot = ensureSlot(i, field, instanceCapacity);

      // Origin as an integer GLOBAL CELL INDEX (not a world coord):
      // the camera-centered window starts gridDim/2 cells "before" the
      // cell the camera sits in. The shader derives world position +
      // every per-blade hash from `originCell + localCell`, so a blade
      // at a fixed world spot keeps the same identity as the window
      // slides — no swimming. (Snapping a world origin to `spacing`
      // wasn't enough: the per-blade hashes were keyed to the LOCAL
      // index, which shifts when the window moves.)
      const originCellX = Math.floor(eye[0] / spacing) - Math.floor(gridDim / 2);
      const originCellZ = Math.floor(eye[2] / spacing) - Math.floor(gridDim / 2);

      // Pack the uniform (see grass-cull.wgsl GrassU layout).
      uf.set(viewProj, 0);              // 0..15  mat4
      uf[16] = eye[0]; uf[17] = eye[1]; uf[18] = eye[2]; uf[19] = frame.time; // cameraPos + time
      uf[20] = originCellX; uf[21] = originCellZ; uf[22] = spacing; uf[23] = gridDim;  // grid
      uf[24] = field.worldSize[0]; uf[25] = field.worldSize[1];
      // heightRange is gone: heights live in the texture directly (R =
      // world Y in metres). The shader reads R as-is so the slots that
      // used to carry the [min, max] remap are now unused — kept as 0
      // so the uniform layout stays the same (shader ignores them).
      uf[26] = 0; uf[27] = 0;
      uf[28] = field.maxDistance; uf[29] = field.densityScale; uf[30] = field.maxSlope; uf[31] = field.cards.length; // params0
      uf[32] = field.bladeSize[0]; uf[33] = field.bladeSize[1]; uf[34] = field.windStrength; uf[35] = field.windSpeed; // blade
      uf[36] = field.baseColor[0]; uf[37] = field.baseColor[1]; uf[38] = field.baseColor[2]; uf[39] = field.colorVariation; // baseColor
      uf[40] = field.tipColor[0]; uf[41] = field.tipColor[1]; uf[42] = field.tipColor[2]; uf[43] = field.seed; // tipColor
      uu[44] = candidateCount; uu[45] = gridDim; uu[46] = instanceCapacity; uu[47] = field.typeMap ? 1 : 0; // counts
      device.queue.writeBuffer(slot.uniformBuffer, 0, uniformScratch);

      // Reset the indirect args: indexCount fixed, instanceCount=0 (the
      // compute pass atomic-appends into it).
      indirectScratch[0] = cardGeom.indexCount;
      indirectScratch[1] = 0;
      indirectScratch[2] = 0;
      indirectScratch[3] = 0;
      indirectScratch[4] = 0;
      device.queue.writeBuffer(slot.indirectBuffer, 0, indirectScratch as BufferSource);

      const pass = encoder.beginComputePass();
      pass.setPipeline(computePipeline);
      pass.setBindGroup(0, slot.computeBindGroup!);
      pass.dispatchWorkgroups(Math.ceil(candidateCount / 64));
      pass.end();
    }
  }

  function draw(pass: GPURenderPassEncoder, fields: GrassFieldValue[]): void {
    if (fields.length === 0) return;
    pass.setPipeline(renderPipeline);
    pass.setVertexBuffer(0, cardGeom.positionBuffer);
    pass.setVertexBuffer(1, cardGeom.normalBuffer);
    pass.setVertexBuffer(2, cardGeom.uvBuffer);
    pass.setIndexBuffer(cardGeom.indexBuffer, cardGeom.indexFormat);
    for (let i = 0; i < fields.length; i++) {
      const slot = slots[i];
      if (!slot || !slot.renderBindGroup) continue;
      pass.setBindGroup(1, slot.renderBindGroup);
      pass.drawIndexedIndirect(slot.indirectBuffer, 0);
    }
  }

  function destroy(): void {
    // Only the per-view slot buffers are owned by THIS instance. The
    // pipelines / card mesh / dummy texture are device-shared (other
    // live renderers may still be using them), so they're never freed
    // here — they live for the device's lifetime like sharedState.
    for (const slot of slots) {
      slot.uniformBuffer.destroy();
      slot.instanceBuffer.destroy();
      slot.indirectBuffer.destroy();
      slot.cardArray?.destroy();
    }
    slots.length = 0;
  }

  return { compute, draw, destroy };
}
