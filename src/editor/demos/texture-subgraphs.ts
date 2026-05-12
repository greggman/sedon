import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Procedural texture subgraphs. Each builds a Texture2D (or pair: basecolor
// + normal) from primitive noise + filter nodes and exposes the result via
// the subgraph boundary. Standalone preview falls out of the per-output
// tile grid in preview.tsx — basecolor and normal each get their own
// auto-synthesized plane tile, no explicit preview chain needed.
//
// Convention: every texture subgraph has a `seed: Float` input so an outer
// graph can vary the noise pattern between instances.

const COL = 280;
const ROW = 180;

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

  // Detail layer: a high-freq isotropic perlin that the material samples
  // at a tighter UV to break the visible repetition of the base fibers at
  // close range. Same height field drives both detail_basecolor (greyscale
  // multiplier) and detail_normal (tangent-space bump). Seed is fixed
  // (not wired from the input seed) so the detail pattern is "generic
  // bark crackle" rather than species-correlated — species variation
  // already comes from the base fibers' seed input.
  const detailNoise = addNode(g, 'core/perlin', {
    position: { x: COL, y: ROW * 3 },
    inputValues: {
      scale: [8, 8],
      octaves: 3,
      lacunarity: 2.2,
      gain: 0.55,
      seed: 0.79,
      resolution: 256,
    },
  });
  const detailNormal = addNode(g, 'core/normal-from-height', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { strength: 20, resolution: 256 },
  });

  // Wire: boundary inputs → perlin seed + colorize colors.
  addEdge(g, { node: inputNode.id, socket: 'seed' }, { node: fibers.id, socket: 'seed' });
  addEdge(g, { node: fibers.id, socket: 'texture' }, { node: levels.id, socket: 'input' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: colorize.id, socket: 'factor' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: normal.id, socket: 'height' });
  addEdge(g, { node: inputNode.id, socket: 'color_dark' }, { node: colorize.id, socket: 'low' });
  addEdge(g, { node: inputNode.id, socket: 'color_light' }, { node: colorize.id, socket: 'high' });
  // Detail chain.
  addEdge(g, { node: detailNoise.id, socket: 'texture' }, { node: detailNormal.id, socket: 'height' });

  // Outputs: basecolor, normal, plus the detail pair.
  addEdge(g, { node: colorize.id, socket: 'texture' }, { node: outputNode.id, socket: 'basecolor' });
  addEdge(g, { node: normal.id, socket: 'texture' }, { node: outputNode.id, socket: 'normal' });
  addEdge(g, { node: detailNoise.id, socket: 'texture' }, { node: outputNode.id, socket: 'detail_basecolor' });
  addEdge(g, { node: detailNormal.id, socket: 'texture' }, { node: outputNode.id, socket: 'detail_normal' });


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
      { name: 'detail_basecolor', type: 'Texture2D' },
      { name: 'detail_normal', type: 'Texture2D' },
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
// like a single uniform noise. The same height field drives both the
// colorize-to-grass-color and a normal-from-height pass, so surface
// shading reads as scattered blades + clumps rather than flat color.
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
  // Strength is high here because grass-noise is smooth — small per-pixel
  // gradients become barely-visible normal tilts unless we amplify them.
  const normal = addNode(g, 'core/normal-from-height', {
    position: { x: COL * 4, y: ROW * 2 },
    inputValues: { strength: 12, resolution: 256 },
  });

  addEdge(g, { node: inputNode.id, socket: 'seed' }, { node: broad.id, socket: 'seed' });
  addEdge(g, { node: broad.id, socket: 'texture' }, { node: blend.id, socket: 'a' });
  addEdge(g, { node: detail.id, socket: 'texture' }, { node: blend.id, socket: 'b' });
  addEdge(g, { node: blend.id, socket: 'texture' }, { node: levels.id, socket: 'input' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: colorize.id, socket: 'factor' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: normal.id, socket: 'height' });
  addEdge(g, { node: inputNode.id, socket: 'color_dark' }, { node: colorize.id, socket: 'low' });
  addEdge(g, { node: inputNode.id, socket: 'color_light' }, { node: colorize.id, socket: 'high' });
  addEdge(g, { node: colorize.id, socket: 'texture' }, { node: outputNode.id, socket: 'basecolor' });
  addEdge(g, { node: normal.id, socket: 'texture' }, { node: outputNode.id, socket: 'normal' });

  return {
    id,
    label: 'Grass Texture',
    category: 'Subgraphs',
    inputs: [
      { name: 'seed', type: 'Float', default: 0.5 },
      { name: 'color_dark', type: 'Color', default: [0.12, 0.22, 0.07, 1] },
      { name: 'color_light', type: 'Color', default: [0.34, 0.5, 0.18, 1] },
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

// === Rock ==============================================================
//
// Worley cellular noise gives the chunky look of rock fragments; Perlin
// adds color variation; levels tightens contrast. Same height field feeds
// both colorize (for basecolor) and normal-from-height (for surface
// shading), so the cellular fracture pattern reads as actual relief.
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
  // Worley cells already produce sharp gradients, so strength here is
  // lower than grass — but still bumped enough to read at distance.
  const normal = addNode(g, 'core/normal-from-height', {
    position: { x: COL * 4, y: ROW * 2 },
    inputValues: { strength: 8, resolution: 256 },
  });

  // Detail layer: high-freq isotropic perlin for surface grit at close
  // range. Same rationale as the bark subgraph's detail — fixed seed so
  // every rock instance shares the same micro-detail "grit" character.
  const detailNoise = addNode(g, 'core/perlin', {
    position: { x: COL, y: ROW * 3 },
    inputValues: {
      scale: [10, 10],
      octaves: 3,
      lacunarity: 2.2,
      gain: 0.55,
      seed: 0.41,
      resolution: 256,
    },
  });
  const detailNormal = addNode(g, 'core/normal-from-height', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { strength: 18, resolution: 256 },
  });

  addEdge(g, { node: inputNode.id, socket: 'seed' }, { node: cells.id, socket: 'seed' });
  addEdge(g, { node: inputNode.id, socket: 'seed' }, { node: grain.id, socket: 'seed' });
  addEdge(g, { node: cells.id, socket: 'texture' }, { node: blend.id, socket: 'a' });
  addEdge(g, { node: grain.id, socket: 'texture' }, { node: blend.id, socket: 'b' });
  addEdge(g, { node: blend.id, socket: 'texture' }, { node: levels.id, socket: 'input' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: colorize.id, socket: 'factor' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: normal.id, socket: 'height' });
  addEdge(g, { node: inputNode.id, socket: 'color_dark' }, { node: colorize.id, socket: 'low' });
  addEdge(g, { node: inputNode.id, socket: 'color_light' }, { node: colorize.id, socket: 'high' });
  addEdge(g, { node: detailNoise.id, socket: 'texture' }, { node: detailNormal.id, socket: 'height' });

  addEdge(g, { node: colorize.id, socket: 'texture' }, { node: outputNode.id, socket: 'basecolor' });
  addEdge(g, { node: normal.id, socket: 'texture' }, { node: outputNode.id, socket: 'normal' });
  addEdge(g, { node: detailNoise.id, socket: 'texture' }, { node: outputNode.id, socket: 'detail_basecolor' });
  addEdge(g, { node: detailNormal.id, socket: 'texture' }, { node: outputNode.id, socket: 'detail_normal' });

  return {
    id,
    label: 'Rock Texture',
    category: 'Subgraphs',
    inputs: [
      { name: 'seed', type: 'Float', default: 0.7 },
      { name: 'color_dark', type: 'Color', default: [0.22, 0.20, 0.18, 1] },
      { name: 'color_light', type: 'Color', default: [0.55, 0.50, 0.46, 1] },
    ],
    outputs: [
      { name: 'basecolor', type: 'Texture2D' },
      { name: 'normal', type: 'Texture2D' },
      { name: 'detail_basecolor', type: 'Texture2D' },
      { name: 'detail_normal', type: 'Texture2D' },
    ],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
