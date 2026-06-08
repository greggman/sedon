import type { TerrainFieldValue } from '../core/resources.js';
import { getSampler } from './gpu-cache.js';
import { type Mat4 } from './mat4.js';
import terrainCode from './terrain-render.wgsl';
import shadowPcfCode from './shadow-pcf.wgsl';

// Chunked-LOD terrain rendering subsystem. Mirrors grass.ts in shape:
// the node graph emits TerrainFieldValue parameters and the renderer
// turns them into per-frame compute + drawIndexedIndirect calls. All
// GPU resources here are subsystem-owned scratch sized to the field's
// chunk budget and reused every frame — they never enter the eval
// cache, so the sweep/destroy lifecycle that governs node outputs
// doesn't touch them.

const MAX_LODS = 8;
const DRAW_ARGS_STRIDE = 20; // 5 × u32: indexCount, instanceCount, firstIndex, baseVertex, firstInstance
const UNIFORM_BYTES = 80; // see TerrainU in terrain-render.wgsl

// URL flag: `?debugTerrainLOD=1` tints each chunk by its assigned LOD
// level and switches the fragment shader to derivative-derived flat
// normals so triangles read distinctly. Read once at module load —
// changing it requires a page reload (acceptable for a debug aid).
function readDebugTerrainLODFlag(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const v = new URLSearchParams(window.location.search).get('debugTerrainLOD');
    return v === '1' || v === 'true' ? 1 : 0;
  } catch {
    return 0;
  }
}
const DEBUG_TERRAIN_LOD = readDebugTerrainLODFlag();

export interface TerrainFrame {
  modelView: Mat4;
  projection: Mat4;
}

type MaterialBgFn = (m: TerrainFieldValue['material']) => GPUBindGroup;

export interface TerrainSystem {
  /**
   * Per-frame LOD-selection compute pass. Must run BEFORE the color
   * pass (which reads the populated chunk-instance buffer + drawArgs).
   * `sceneBindGroup` and `buildMaterialBindGroup` are required to
   * satisfy the pipeline layout — the compute kernel itself only
   * reads the per-field @group(2) bindings, but the shared pipeline
   * layout still mandates group 0 and 1 be valid.
   */
  compute(
    encoder: GPUCommandEncoder,
    fields: TerrainFieldValue[],
    frame: TerrainFrame,
    sceneBindGroup: GPUBindGroup,
    buildMaterialBindGroup: MaterialBgFn,
  ): void;
  /**
   * Draw every terrain field. Call INSIDE the color pass after opaque
   * geometry; @group(0) (scene) must already be bound. Issues
   * `lodLevels` drawIndexedIndirect calls per field.
   */
  draw(pass: GPURenderPassEncoder, fields: TerrainFieldValue[], buildMaterialBindGroup: MaterialBgFn): void;
  destroy(): void;
}

interface LodMesh {
  /** Per-vertex unit-grid position attribute (location 0): vec3f x,y,z with y=0. */
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  vertexCount: number;
}

interface FieldSlot {
  uniformBuffer: GPUBuffer;
  /** Per-LOD shared unit-grid meshes; lodMeshes.length === field.lodLevels. */
  lodMeshes: LodMesh[];
  /**
   * Big chunk-index storage buffer with `lodLevels × totalChunks`
   * u32 slots. Compute writes chunk index into `lod * totalChunks +
   * slot`; render binds it as a per-instance vertex buffer at
   * `lod * totalChunks * 4` byte offset (via setVertexBuffer's offset
   * arg) — avoiding `firstInstance` in indirect args because that
   * requires the optional `indirect-first-instance` feature.
   */
  chunkInstanceBuffer: GPUBuffer;
  /** Bytes per LOD slice = totalChunks × 4. */
  chunkInstanceStrideBytes: number;
  /** Indirect-draw arguments, lodLevels × DRAW_ARGS_STRIDE bytes. */
  drawArgsBuffer: GPUBuffer;
  /** Scratch CPU buffer for resetting drawArgs each frame. */
  drawArgsScratch: Uint32Array;
  /** @group(2) bind group used by the compute pass (includes storage bindings). */
  fieldComputeBindGroup: GPUBindGroup;
  /** @group(2) bind group used by the render pass (omits storage bindings). */
  fieldRenderBindGroup: GPUBindGroup;
  /** Cached "shape" of the field — when this changes, rebuild the slot. */
  structKey: string;
}

// modelView^{-1}.translation = -Rᵀ · t (same trick grass.ts uses).
function cameraWorldPos(mv: Mat4): [number, number, number] {
  const t0 = mv[12]!, t1 = mv[13]!, t2 = mv[14]!;
  return [
    -(mv[0]! * t0 + mv[1]! * t1 + mv[2]! * t2),
    -(mv[4]! * t0 + mv[5]! * t1 + mv[6]! * t2),
    -(mv[8]! * t0 + mv[9]! * t1 + mv[10]! * t2),
  ];
}

// CPU-side unit grid generator: a flat XZ plane in [-0.5, 0.5]² with
// `vertsPerEdge` vertices along each edge.
function buildUnitGrid(vertsPerEdge: number): { positions: Float32Array; indices: Uint32Array } {
  const n = Math.max(2, vertsPerEdge);
  const positions = new Float32Array(n * n * 3);
  for (let zi = 0; zi < n; zi++) {
    for (let xi = 0; xi < n; xi++) {
      const idx = (zi * n + xi) * 3;
      positions[idx] = xi / (n - 1) - 0.5;
      positions[idx + 1] = 0;
      positions[idx + 2] = zi / (n - 1) - 0.5;
    }
  }
  const quadsPerEdge = n - 1;
  const indices = new Uint32Array(quadsPerEdge * quadsPerEdge * 6);
  let i = 0;
  for (let zi = 0; zi < quadsPerEdge; zi++) {
    for (let xi = 0; xi < quadsPerEdge; xi++) {
      const a = zi * n + xi;
      const b = a + n;
      indices[i++] = a;
      indices[i++] = b;
      indices[i++] = a + 1;
      indices[i++] = b;
      indices[i++] = b + 1;
      indices[i++] = a + 1;
    }
  }
  return { positions, indices };
}

export function createTerrainSystem(
  device: GPUDevice,
  format: GPUTextureFormat,
  sceneBindGroupLayout: GPUBindGroupLayout,
  materialBindGroupLayout: GPUBindGroupLayout,
): TerrainSystem {
  // Two distinct field-bind-group layouts: the compute pass needs
  // bindings 3 and 4 (chunkInstance + drawArgs as storage), but
  // binding them at render time would conflict with the same buffers'
  // VERTEX / INDIRECT usage in that pass (WebGPU forbids writable
  // storage + any other usage of the same buffer inside one pass).
  // Solution: declare only the truly-read bindings in the render-side
  // layout, omit 3 and 4.
  const fieldComputeLayout = device.createBindGroupLayout({
    label: 'terrain-lod-compute-bgl',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const fieldRenderLayout = device.createBindGroupLayout({
    label: 'terrain-render-bgl',
    entries: [
      // Uniform also visible to the fragment so it can read debugMode.
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX, sampler: { type: 'filtering' } },
    ],
  });

  const module = device.createShaderModule({
    label: 'terrain-render-module',
    code: `${shadowPcfCode}\n${terrainCode}`,
  });
  const computePipeline = device.createComputePipeline({
    label: 'terrain-lod-select-pipeline',
    layout: device.createPipelineLayout({
      label: 'terrain-compute-pl',
      bindGroupLayouts: [sceneBindGroupLayout, materialBindGroupLayout, fieldComputeLayout],
    }),
    compute: { module, entryPoint: 'lod_select' },
  });
  const renderPipeline = device.createRenderPipeline({
    label: 'terrain-render-pipeline',
    layout: device.createPipelineLayout({
      label: 'terrain-render-pl',
      bindGroupLayouts: [sceneBindGroupLayout, materialBindGroupLayout, fieldRenderLayout],
    }),
    vertex: {
      module,
      entryPoint: 'vs_main',
      buffers: [
        // location 0: per-vertex gridPos (vec3f)
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        // location 1: per-instance chunkIdx (u32)
        { arrayStride: 4, stepMode: 'instance', attributes: [{ shaderLocation: 1, offset: 0, format: 'uint32' }] },
      ],
    },
    fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { cullMode: 'back' },
    depthStencil: { format: 'depth32float', depthCompare: 'greater', depthWriteEnabled: true },
  });

  const heightSampler = getSampler(device, {
    label: 'terrain-height-sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });

  const slots: FieldSlot[] = [];

  // Structural fingerprint that gates a full slot rebuild. Hits when
  // chunk count / LOD count / baseDivisions / height texture identity
  // change. The material's identity is tracked via the renderer's
  // shared material cache (passed in as buildMaterialBindGroup).
  function fieldStructKey(f: TerrainFieldValue): string {
    return [
      `cc=${f.chunkCount[0]}x${f.chunkCount[1]}`,
      `lod=${f.lodLevels}`,
      `bd=${f.baseDivisions}`,
      // The wrapped Texture2DValue may be re-allocated even when its
      // underlying GPUTexture is the same; key on the GPUTexture
      // handle, which is stable across reusableTexture re-renders.
      `htex=${tagOf(f.heightTexture.texture)}`,
    ].join('|');
  }
  // Stable per-GPUObject identity tag — gpu-cache provides `gpuObjectId`;
  // we use a tiny inline version to avoid a circular import on
  // gpu-cache (which already imports from this file's neighbours).
  const tagMap = new WeakMap<object, number>();
  let nextTag = 1;
  function tagOf(obj: object): number {
    let t = tagMap.get(obj);
    if (t === undefined) { t = nextTag++; tagMap.set(obj, t); }
    return t;
  }

  function buildSlot(field: TerrainFieldValue): FieldSlot {
    const totalChunks = field.chunkCount[0] * field.chunkCount[1];
    const lodLevels = Math.min(MAX_LODS, Math.max(1, field.lodLevels));

    const lodMeshes: LodMesh[] = [];
    for (let lod = 0; lod < lodLevels; lod++) {
      // vertsPerEdge = (baseDivisions >> lod) + 1 (NOT just
      // `>> lod`) so adjacent LODs share vertex positions exactly:
      // LOD i has spacing 1/(baseDivisions >> i) and LOD i+1 has
      // spacing 2/(baseDivisions >> i), so every LOD i+1 vertex is
      // also an LOD i vertex. That alignment lets the vertex
      // shader's geomorph snap a fine vertex to its LOD i+1 host
      // and produce identical geometry at morph t=1, which in turn
      // makes T-junctions at chunk boundaries vanish at the moment
      // a chunk transitions LOD level.
      const vertsPerEdge = Math.max(2, (field.baseDivisions >> lod) + 1);
      const { positions, indices } = buildUnitGrid(vertsPerEdge);
      const vb = device.createBuffer({
        label: `terrain-lod-vb:lod-${lod}`,
        size: positions.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(vb, 0, positions as BufferSource);
      const ib = device.createBuffer({
        label: `terrain-lod-ib:lod-${lod}`,
        size: indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(ib, 0, indices as BufferSource);
      lodMeshes.push({
        vertexBuffer: vb,
        indexBuffer: ib,
        indexCount: indices.length,
        vertexCount: positions.length / 3,
      });
    }

    // One slot per chunk per LOD. Bound as STORAGE (compute writes) +
    // VERTEX (per-instance attribute on draw). Worst-case all chunks
    // pick the same LOD, so lodLevels × totalChunks u32s.
    const chunkInstanceBuffer = device.createBuffer({
      label: 'terrain-chunk-instance',
      size: lodLevels * totalChunks * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    const drawArgsBuffer = device.createBuffer({
      label: 'terrain-draw-args',
      size: lodLevels * DRAW_ARGS_STRIDE,
      // COPY_SRC lets test repros read back the indirect args to
      // verify LOD selection — cheap to enable, never used in
      // production frames.
      usage:
        GPUBufferUsage.STORAGE
        | GPUBufferUsage.INDIRECT
        | GPUBufferUsage.COPY_DST
        | GPUBufferUsage.COPY_SRC,
    });
    // Pre-populate per-LOD constants. instanceCount (offset+1) is
    // overwritten each frame before the compute populates it.
    // firstInstance is always 0 — WebGPU's core spec disallows non-
    // zero firstInstance in indirect args without the
    // `indirect-first-instance` feature (which Sedon doesn't request).
    // Instead, the LOD's slice of chunkInstanceBuffer is bound at the
    // matching byte offset via setVertexBuffer(slot, buf, offset).
    const drawArgsScratch = new Uint32Array(lodLevels * 5);
    for (let lod = 0; lod < lodLevels; lod++) {
      const base = lod * 5;
      drawArgsScratch[base + 0] = lodMeshes[lod]!.indexCount;
      drawArgsScratch[base + 1] = 0;
      drawArgsScratch[base + 2] = 0;
      drawArgsScratch[base + 3] = 0;
      drawArgsScratch[base + 4] = 0;
    }
    device.queue.writeBuffer(drawArgsBuffer, 0, drawArgsScratch as BufferSource);

    const uniformBuffer = device.createBuffer({
      label: 'terrain-uniform',
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const fieldComputeBindGroup = device.createBindGroup({
      label: 'terrain-compute-bg',
      layout: fieldComputeLayout,
      entries: [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: field.heightTexture.texture },
        { binding: 2, resource: heightSampler },
        { binding: 3, resource: chunkInstanceBuffer },
        { binding: 4, resource: drawArgsBuffer },
      ],
    });
    const fieldRenderBindGroup = device.createBindGroup({
      label: 'terrain-render-bg',
      layout: fieldRenderLayout,
      entries: [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: field.heightTexture.texture },
        { binding: 2, resource: heightSampler },
      ],
    });

    return {
      uniformBuffer,
      lodMeshes,
      chunkInstanceBuffer,
      chunkInstanceStrideBytes: totalChunks * 4,
      drawArgsBuffer,
      drawArgsScratch,
      fieldComputeBindGroup,
      fieldRenderBindGroup,
      structKey: fieldStructKey(field),
    };
  }

  function ensureSlot(i: number, field: TerrainFieldValue): FieldSlot {
    const key = fieldStructKey(field);
    let slot = slots[i];
    if (!slot || slot.structKey !== key) {
      slot?.uniformBuffer.destroy();
      slot?.chunkInstanceBuffer.destroy();
      slot?.drawArgsBuffer.destroy();
      for (const m of slot?.lodMeshes ?? []) {
        m.vertexBuffer.destroy();
        m.indexBuffer.destroy();
      }
      slot = buildSlot(field);
      slots[i] = slot;
    }
    return slot;
  }

  function writeUniforms(slot: FieldSlot, field: TerrainFieldValue, eye: [number, number, number]) {
    // Offsets in bytes — must match TerrainU in terrain-render.wgsl.
    const buf = new ArrayBuffer(UNIFORM_BYTES);
    const f32 = new Float32Array(buf);
    const u32 = new Uint32Array(buf);
    const totalW = field.worldSize[0];
    const totalD = field.worldSize[1];
    const chunkW = totalW / field.chunkCount[0];
    const chunkD = totalD / field.chunkCount[1];
    f32[0]  = -totalW / 2; f32[1] = -totalD / 2;                  // worldOrigin (offset 0)
    f32[2]  = chunkW;      f32[3] = chunkD;                        // chunkSize    (offset 8)
    u32[4]  = field.chunkCount[0]; u32[5] = field.chunkCount[1];   // chunkCount   (offset 16)
    // _unused0/_unused1 — heightRange is gone (R = world Y in metres).
    f32[6]  = 0;                                                   // _unused0 (offset 24)
    f32[7]  = 0;                                                   // _unused1 (offset 28)
    u32[8]  = Math.min(MAX_LODS, Math.max(1, field.lodLevels));    // lodLevels    (offset 32)
    f32[9]  = field.lodDistance;                                   // lodDistance  (offset 36)
    u32[10] = field.baseDivisions;                                 // baseDivisions (offset 40)
    u32[11] = DEBUG_TERRAIN_LOD;                                   // debugMode    (offset 44)
    f32[12] = eye[0]; f32[13] = eye[1]; f32[14] = eye[2]; f32[15] = 0; // cameraPos (offset 48, vec4f)
    device.queue.writeBuffer(slot.uniformBuffer, 0, buf);
  }

  function compute(
    encoder: GPUCommandEncoder,
    fields: TerrainFieldValue[],
    frame: TerrainFrame,
    sceneBindGroup: GPUBindGroup,
    buildMaterialBindGroup: MaterialBgFn,
  ): void {
    if (fields.length === 0) return;
    const eye = cameraWorldPos(frame.modelView);

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      const slot = ensureSlot(i, field);
      writeUniforms(slot, field, eye);
      // Reset instanceCount fields to 0; preserve the per-LOD
      // constants written at slot build.
      for (let lod = 0; lod < slot.lodMeshes.length; lod++) {
        slot.drawArgsScratch[lod * 5 + 1] = 0;
      }
      device.queue.writeBuffer(slot.drawArgsBuffer, 0, slot.drawArgsScratch as BufferSource);

      const materialBg = buildMaterialBindGroup(field.material);
      const pass = encoder.beginComputePass({ label: `terrain-lod-select-pass:field-${i}` });
      pass.setPipeline(computePipeline);
      pass.setBindGroup(0, sceneBindGroup);
      pass.setBindGroup(1, materialBg);
      pass.setBindGroup(2, slot.fieldComputeBindGroup);
      const totalChunks = field.chunkCount[0] * field.chunkCount[1];
      pass.dispatchWorkgroups(Math.ceil(totalChunks / 64));
      pass.end();
    }
  }

  function draw(pass: GPURenderPassEncoder, fields: TerrainFieldValue[], buildMaterialBindGroup: MaterialBgFn): void {
    if (fields.length === 0) return;
    pass.setPipeline(renderPipeline);
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!;
      const slot = slots[i];
      if (!slot) continue;
      const materialBg = buildMaterialBindGroup(field.material);
      pass.setBindGroup(1, materialBg);
      pass.setBindGroup(2, slot.fieldRenderBindGroup);
      for (let lod = 0; lod < slot.lodMeshes.length; lod++) {
        const mesh = slot.lodMeshes[lod]!;
        pass.setVertexBuffer(0, mesh.vertexBuffer);
        pass.setVertexBuffer(
          1,
          slot.chunkInstanceBuffer,
          lod * slot.chunkInstanceStrideBytes,
          slot.chunkInstanceStrideBytes,
        );
        pass.setIndexBuffer(mesh.indexBuffer, 'uint32');
        pass.drawIndexedIndirect(slot.drawArgsBuffer, lod * DRAW_ARGS_STRIDE);
      }
    }
  }

  function destroy() {
    for (const slot of slots) {
      slot?.uniformBuffer.destroy();
      slot?.chunkInstanceBuffer.destroy();
      slot?.drawArgsBuffer.destroy();
      for (const m of slot?.lodMeshes ?? []) {
        m.vertexBuffer.destroy();
        m.indexBuffer.destroy();
      }
    }
    slots.length = 0;
  }

  return { compute, draw, destroy };
}
