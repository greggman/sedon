import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Texture subgraphs for the furniture demo. Pattern matches the
// forest demo's texture-subgraphs.ts: each subgraph builds a
// basecolor + normal pair from perlin + colorize + normal-from-height
// and exposes them via the subgraph boundary. The hero furniture
// subgraphs reference these via subgraph/<id> nodes so changing the
// wood palette in one place re-tints every wooden surface in the
// room at once.

const COL = 280;
const ROW = 180;

// === Wood ==============================================================
//
// Strongly anisotropic perlin — high frequency along U (grain), low
// frequency along V (cross-grain) — so the texture reads as long
// running wood fibers. Colorize through a dark/light gradient drawn
// from a `tex/palette` so the boundary's two Color inputs can shift
// the wood species (oak, walnut, pine, …) without rebuilding the
// graph.
export function buildWoodTextureSubgraph(): SubgraphDef {
  const id = 'wood-texture';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 1.5 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 5, y: ROW },
  });

  // Grain runs along U. The high V-frequency / low U-frequency split
  // is what makes the noise look like fibers instead of soap-bubble
  // patches. octaves=4 keeps the fiber pattern from feeling synthetic
  // at close-range; gain<0.5 keeps high octaves subtle.
  const grain = addNode(g, 'tex/perlin', {
    position: { x: COL, y: 0 },
    inputValues: {
      scale: [18, 2],
      octaves: 4,
      lacunarity: 2.1,
      gain: 0.45,
      resolution: 256,
    },
  });
  const levels = addNode(g, 'tex/levels', {
    position: { x: COL * 2, y: 0 },
    inputValues: { brightness: -0.05, contrast: 1.5, gamma: 1.0, resolution: 256 },
  });
  const colorize = addNode(g, 'tex/colorize', {
    position: { x: COL * 3, y: 0 },
    inputValues: { resolution: 256 },
  });
  const normal = addNode(g, 'tex/normal-from-height', {
    position: { x: COL * 3, y: ROW * 1.5 },
    inputValues: { strength: 1.5, resolution: 256 },
  });
  const palette = addNode(g, 'tex/palette', {
    position: { x: COL * 2.5, y: ROW * 0.6 },
  });

  addEdge(g, { node: inputNode.id, socket: 'seed' }, { node: grain.id, socket: 'seed' });
  addEdge(g, { node: grain.id, socket: 'texture' }, { node: levels.id, socket: 'input' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: colorize.id, socket: 'factor' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: normal.id, socket: 'height' });
  addEdge(g, { node: inputNode.id, socket: 'color_dark' }, { node: palette.id, socket: 'color_a' });
  addEdge(g, { node: inputNode.id, socket: 'color_light' }, { node: palette.id, socket: 'color_b' });
  addEdge(g, { node: palette.id, socket: 'ramp' }, { node: colorize.id, socket: 'ramp' });
  addEdge(g, { node: colorize.id, socket: 'texture' }, { node: outputNode.id, socket: 'basecolor' });
  addEdge(g, { node: normal.id, socket: 'texture' }, { node: outputNode.id, socket: 'normal' });

  return {
    id,
    label: 'Wood Texture',
    category: 'Subgraphs',
    inputs: [
      { name: 'seed', type: 'Float', default: 0.21 },
      // Oak-ish defaults: warm mid-brown grain with a slightly darker
      // base. Override at the wrapper for walnut (darker) / pine
      // (lighter) / cherry (redder) without forking the subgraph.
      { name: 'color_dark', type: 'Color', default: [0.18, 0.10, 0.05, 1] },
      { name: 'color_light', type: 'Color', default: [0.55, 0.36, 0.21, 1] },
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

// === Fabric ============================================================
//
// Isotropic mid-frequency perlin colorized through a soft palette —
// reads as woven linen / canvas at preview scale. The normal map is
// gentle so the cushions don't look quilted; the perceived weave
// comes from the basecolor noise.
export function buildFabricTextureSubgraph(): SubgraphDef {
  const id = 'fabric-texture';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 1.5 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 5, y: ROW },
  });

  const weave = addNode(g, 'tex/perlin', {
    position: { x: COL, y: 0 },
    inputValues: {
      scale: [12, 12],
      octaves: 3,
      lacunarity: 2.0,
      gain: 0.5,
      resolution: 256,
    },
  });
  const levels = addNode(g, 'tex/levels', {
    position: { x: COL * 2, y: 0 },
    inputValues: { brightness: 0.0, contrast: 1.15, gamma: 1.0, resolution: 256 },
  });
  const colorize = addNode(g, 'tex/colorize', {
    position: { x: COL * 3, y: 0 },
    inputValues: { resolution: 256 },
  });
  // Strength is high here — perlin gradients are gentle and the
  // weave reads as flat-color without amplification.
  const normal = addNode(g, 'tex/normal-from-height', {
    position: { x: COL * 3, y: ROW * 1.5 },
    inputValues: { strength: 4, resolution: 256 },
  });
  const palette = addNode(g, 'tex/palette', {
    position: { x: COL * 2.5, y: ROW * 0.6 },
  });

  addEdge(g, { node: inputNode.id, socket: 'seed' }, { node: weave.id, socket: 'seed' });
  addEdge(g, { node: weave.id, socket: 'texture' }, { node: levels.id, socket: 'input' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: colorize.id, socket: 'factor' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: normal.id, socket: 'height' });
  addEdge(g, { node: inputNode.id, socket: 'color_dark' }, { node: palette.id, socket: 'color_a' });
  addEdge(g, { node: inputNode.id, socket: 'color_light' }, { node: palette.id, socket: 'color_b' });
  addEdge(g, { node: palette.id, socket: 'ramp' }, { node: colorize.id, socket: 'ramp' });
  addEdge(g, { node: colorize.id, socket: 'texture' }, { node: outputNode.id, socket: 'basecolor' });
  addEdge(g, { node: normal.id, socket: 'texture' }, { node: outputNode.id, socket: 'normal' });

  return {
    id,
    label: 'Fabric Texture',
    category: 'Subgraphs',
    inputs: [
      { name: 'seed', type: 'Float', default: 0.62 },
      // Slate-blue linen defaults. Wrapper can override for
      // any upholstery color.
      { name: 'color_dark', type: 'Color', default: [0.22, 0.27, 0.34, 1] },
      { name: 'color_light', type: 'Color', default: [0.42, 0.48, 0.55, 1] },
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

// === Metal =============================================================
//
// Strongly anisotropic perlin — high frequency along V, low along U
// — for a brushed-metal directional grain. Colorize through a tight
// gray gradient so the result reads metallic when the material's
// metallic input is high. Normal is gentle: brushed metal has a
// directional reflection but very small physical relief.
export function buildMetalTextureSubgraph(): SubgraphDef {
  const id = 'metal-texture';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 1.5 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 5, y: ROW },
  });

  const brush = addNode(g, 'tex/perlin', {
    position: { x: COL, y: 0 },
    inputValues: {
      scale: [2, 32],
      octaves: 2,
      lacunarity: 2.0,
      gain: 0.4,
      resolution: 256,
    },
  });
  const levels = addNode(g, 'tex/levels', {
    position: { x: COL * 2, y: 0 },
    inputValues: { brightness: 0.1, contrast: 1.1, gamma: 1.0, resolution: 256 },
  });
  const colorize = addNode(g, 'tex/colorize', {
    position: { x: COL * 3, y: 0 },
    inputValues: { resolution: 256 },
  });
  const normal = addNode(g, 'tex/normal-from-height', {
    position: { x: COL * 3, y: ROW * 1.5 },
    inputValues: { strength: 2, resolution: 256 },
  });
  const palette = addNode(g, 'tex/palette', {
    position: { x: COL * 2.5, y: ROW * 0.6 },
  });

  addEdge(g, { node: inputNode.id, socket: 'seed' }, { node: brush.id, socket: 'seed' });
  addEdge(g, { node: brush.id, socket: 'texture' }, { node: levels.id, socket: 'input' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: colorize.id, socket: 'factor' });
  addEdge(g, { node: levels.id, socket: 'texture' }, { node: normal.id, socket: 'height' });
  addEdge(g, { node: inputNode.id, socket: 'color_dark' }, { node: palette.id, socket: 'color_a' });
  addEdge(g, { node: inputNode.id, socket: 'color_light' }, { node: palette.id, socket: 'color_b' });
  addEdge(g, { node: palette.id, socket: 'ramp' }, { node: colorize.id, socket: 'ramp' });
  addEdge(g, { node: colorize.id, socket: 'texture' }, { node: outputNode.id, socket: 'basecolor' });
  addEdge(g, { node: normal.id, socket: 'texture' }, { node: outputNode.id, socket: 'normal' });

  return {
    id,
    label: 'Metal Texture',
    category: 'Subgraphs',
    inputs: [
      { name: 'seed', type: 'Float', default: 0.4 },
      // Brushed steel defaults. The gradient is intentionally narrow
      // — wide ranges read painted/plastic, not metallic.
      { name: 'color_dark', type: 'Color', default: [0.45, 0.46, 0.48, 1] },
      { name: 'color_light', type: 'Color', default: [0.72, 0.73, 0.75, 1] },
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
