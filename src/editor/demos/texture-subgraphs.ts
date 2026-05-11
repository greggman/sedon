import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Procedural texture subgraphs. Each builds a Texture2D (or pair: basecolor +
// normal) from primitive noise + filter nodes, exposes the result via the
// subgraph boundary, AND has a standalone preview chain (plane + material +
// scene-entity + core/output) so dragging into the subgraph in the editor
// shows the texture applied to a flat plane.
//
// Convention: every texture subgraph has a `seed: Float` input so an outer
// graph can vary the noise pattern between instances.

const COL = 280;
const ROW = 180;

// Shared helper: append a standalone-preview chain (plane + material →
// core/output) to an in-progress texture subgraph. Caller passes the node
// ids holding the basecolor texture and (optionally) the normal map.
function addTexturePreview(
  g: ReturnType<typeof createGraph>,
  basecolorNodeId: string,
  basecolorSocket: string,
  normalNodeId: string | null,
  normalSocket: string | null,
  position: { x: number; y: number },
): void {
  const plane = addNode(g, 'core/plane', {
    position: { x: position.x, y: position.y },
    inputValues: { size: [2, 2], divisions: [4, 4] },
  });
  const mat = addNode(g, 'core/material', {
    position: { x: position.x + COL * 2, y: position.y },
    inputValues: { roughness: 0.9, metallic: 0 },
  });
  const entity = addNode(g, 'core/scene-entity', {
    position: { x: position.x + COL * 3, y: position.y },
  });
  const output = addNode(g, 'core/output', {
    position: { x: position.x + COL * 4, y: position.y },
  });
  addEdge(g, { node: plane.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
  addEdge(g, { node: basecolorNodeId, socket: basecolorSocket }, { node: mat.id, socket: 'basecolor' });
  if (normalNodeId && normalSocket) {
    addEdge(g, { node: normalNodeId, socket: normalSocket }, { node: mat.id, socket: 'normal' });
  }
  addEdge(g, { node: mat.id, socket: 'material' }, { node: entity.id, socket: 'material' });
  addEdge(g, { node: entity.id, socket: 'scene' }, { node: output.id, socket: 'scene' });
}

// === Bark ==============================================================
//
// Anisotropic Perlin stretched along Y (low X frequency, high Y frequency)
// gives the look of vertical wood fibers. The same height field drives
// both the colorize-to-bark-color and the normal-from-height pass, so
// surface lighting matches the visual grain.
export function buildBarkTextureSubgraph(): SubgraphDef {
  const id = 'bark-texture';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 1.5 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 5, y: ROW * 1 },
  });

  const fibers = addNode(g, 'core/perlin', {
    position: { x: COL, y: 0 },
    inputValues: {
      scale: [2, 14],
      octaves: 4,
      lacunarity: 2.1,
      gain: 0.55,
      resolution: 256,
    },
  });
  const levels = addNode(g, 'core/levels', {
    position: { x: COL * 2, y: 0 },
    inputValues: { brightness: 0, contrast: 1.6, gamma: 1.0, resolution: 256 },
  });
  const colorize = addNode(g, 'core/colorize', {
    position: { x: COL * 3, y: 0 },
    inputValues: { resolution: 256 },
  });
  const normal = addNode(g, 'core/normal-from-height', {
    position: { x: COL * 3, y: ROW * 1.5 },
    inputValues: { strength: 3, resolution: 256 },
  });

  // Wire: boundary inputs → perlin seed + colorize colors.
  addEdge(g, { node: inputNode.id, socket: 'seed' }, { node: fibers.id, socket: 'seed' });
  addEdge(g, { node: fibers.id, socket: 'texture' }, { node: levels.id, socket: 'input' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: colorize.id, socket: 'factor' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: normal.id, socket: 'height' });
  addEdge(g, { node: inputNode.id, socket: 'color_dark' }, { node: colorize.id, socket: 'low' });
  addEdge(g, { node: inputNode.id, socket: 'color_light' }, { node: colorize.id, socket: 'high' });

  // Outputs: basecolor and normal exposed to parent.
  addEdge(g, { node: colorize.id, socket: 'texture' }, { node: outputNode.id, socket: 'basecolor' });
  addEdge(g, { node: normal.id, socket: 'texture' }, { node: outputNode.id, socket: 'normal' });

  // Standalone preview (a plane wearing the bark).
  addTexturePreview(g, colorize.id, 'texture', normal.id, 'texture', {
    x: COL, y: ROW * 4,
  });

  return {
    id,
    label: 'Bark Texture',
    category: 'Subgraphs',
    inputs: [
      { name: 'seed', type: 'Float', default: 0.3 },
      { name: 'color_dark', type: 'Color', default: [0.13, 0.07, 0.04, 1] },
      { name: 'color_light', type: 'Color', default: [0.42, 0.28, 0.16, 1] },
    ],
    outputs: [
      { name: 'basecolor', type: 'Texture2D' },
      { name: 'normal', type: 'Texture2D' },
    ],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Grass =============================================================
//
// Soft isotropic perlin colored through a green gradient. Two layers — a
// broad variation and a fine sparkle overlay — so the result doesn't look
// like a single uniform noise.
export function buildGrassTextureSubgraph(): SubgraphDef {
  const id = 'grass-texture';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 1.5 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 5, y: ROW * 1 },
  });

  // Broad clumping (low frequency) plus a finer detail layer (higher
  // frequency) blended together.
  const broad = addNode(g, 'core/perlin', {
    position: { x: COL, y: 0 },
    inputValues: {
      scale: [4, 4],
      octaves: 3,
      lacunarity: 2,
      gain: 0.55,
      resolution: 256,
    },
  });
  const detail = addNode(g, 'core/perlin', {
    position: { x: COL, y: ROW * 1.2 },
    inputValues: {
      scale: [18, 18],
      octaves: 2,
      lacunarity: 2,
      gain: 0.5,
      resolution: 256,
    },
  });
  const blend = addNode(g, 'core/blend', {
    position: { x: COL * 2, y: ROW * 0.6 },
    inputValues: { factor: 0.35, resolution: 256 },
  });
  const levels = addNode(g, 'core/levels', {
    position: { x: COL * 3, y: ROW * 0.6 },
    inputValues: { brightness: 0, contrast: 1.25, gamma: 1.0, resolution: 256 },
  });
  const colorize = addNode(g, 'core/colorize', {
    position: { x: COL * 4, y: ROW * 0.6 },
    inputValues: { resolution: 256 },
  });

  addEdge(g, { node: inputNode.id, socket: 'seed' }, { node: broad.id, socket: 'seed' });
  // Detail uses a derived seed so the layers don't sync up obviously.
  // (No "seed offset" node yet — fixed bias is fine for v1.)
  addEdge(g, { node: broad.id, socket: 'texture' }, { node: blend.id, socket: 'a' });
  addEdge(g, { node: detail.id, socket: 'texture' }, { node: blend.id, socket: 'b' });
  addEdge(g, { node: blend.id, socket: 'texture' }, { node: levels.id, socket: 'input' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: colorize.id, socket: 'factor' });
  addEdge(g, { node: inputNode.id, socket: 'color_dark' }, { node: colorize.id, socket: 'low' });
  addEdge(g, { node: inputNode.id, socket: 'color_light' }, { node: colorize.id, socket: 'high' });
  addEdge(g, { node: colorize.id, socket: 'texture' }, { node: outputNode.id, socket: 'texture' });

  addTexturePreview(g, colorize.id, 'texture', null, null, {
    x: COL, y: ROW * 4,
  });

  return {
    id,
    label: 'Grass Texture',
    category: 'Subgraphs',
    inputs: [
      { name: 'seed', type: 'Float', default: 0.5 },
      { name: 'color_dark', type: 'Color', default: [0.12, 0.22, 0.07, 1] },
      { name: 'color_light', type: 'Color', default: [0.34, 0.5, 0.18, 1] },
    ],
    outputs: [{ name: 'texture', type: 'Texture2D' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Rock ==============================================================
//
// Worley cellular noise gives the chunky look of rock fragments; Perlin
// adds color variation; levels tightens contrast. Output is basecolor —
// for AAA-quality rocks you'd add ridged noise + a real normal map; that's
// in the next slice.
export function buildRockTextureSubgraph(): SubgraphDef {
  const id = 'rock-texture';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 1.5 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 5, y: ROW * 1 },
  });

  const cells = addNode(g, 'core/worley', {
    position: { x: COL, y: 0 },
    inputValues: {
      scale: 8,
      octaves: 2,
      lacunarity: 2.0,
      gain: 0.5,
      resolution: 256,
    },
  });
  const grain = addNode(g, 'core/perlin', {
    position: { x: COL, y: ROW * 1.2 },
    inputValues: {
      scale: [16, 16],
      octaves: 3,
      lacunarity: 2,
      gain: 0.55,
      resolution: 256,
    },
  });
  const blend = addNode(g, 'core/blend', {
    position: { x: COL * 2, y: ROW * 0.6 },
    inputValues: { factor: 0.45, resolution: 256 },
  });
  const levels = addNode(g, 'core/levels', {
    position: { x: COL * 3, y: ROW * 0.6 },
    inputValues: { brightness: 0, contrast: 1.3, gamma: 0.9, resolution: 256 },
  });
  const colorize = addNode(g, 'core/colorize', {
    position: { x: COL * 4, y: ROW * 0.6 },
    inputValues: { resolution: 256 },
  });

  addEdge(g, { node: inputNode.id, socket: 'seed' }, { node: cells.id, socket: 'seed' });
  addEdge(g, { node: inputNode.id, socket: 'seed' }, { node: grain.id, socket: 'seed' });
  addEdge(g, { node: cells.id, socket: 'texture' }, { node: blend.id, socket: 'a' });
  addEdge(g, { node: grain.id, socket: 'texture' }, { node: blend.id, socket: 'b' });
  addEdge(g, { node: blend.id, socket: 'texture' }, { node: levels.id, socket: 'input' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: colorize.id, socket: 'factor' });
  addEdge(g, { node: inputNode.id, socket: 'color_dark' }, { node: colorize.id, socket: 'low' });
  addEdge(g, { node: inputNode.id, socket: 'color_light' }, { node: colorize.id, socket: 'high' });
  addEdge(g, { node: colorize.id, socket: 'texture' }, { node: outputNode.id, socket: 'texture' });

  addTexturePreview(g, colorize.id, 'texture', null, null, {
    x: COL, y: ROW * 4,
  });

  return {
    id,
    label: 'Rock Texture',
    category: 'Subgraphs',
    inputs: [
      { name: 'seed', type: 'Float', default: 0.7 },
      { name: 'color_dark', type: 'Color', default: [0.22, 0.20, 0.18, 1] },
      { name: 'color_light', type: 'Color', default: [0.55, 0.50, 0.46, 1] },
    ],
    outputs: [{ name: 'texture', type: 'Texture2D' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
