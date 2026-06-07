import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// A tree subgraph: cylinder trunk + (sphere | cone) foliage at origin,
// merged into a 2-entity Scene. NO scatter — that's the parent's job
// (compose with core/instance-scene-on-points and a point cloud).
// Standalone view shows the single tree directly.
//
// `id` and `label` are visible in the editor; everything else is implicit.
function buildTreeSubgraph(opts: {
  id: string;
  label: string;
  trunk: {
    radius: number;
    height: number;
    segments: number;
    /** Dark crack/shadow color (low end of bark gradient). */
    colorDark: [number, number, number, number];
    /** Light ridge color (high end of bark gradient). */
    colorLight: [number, number, number, number];
  };
  bark: {
    /** Noise seed — keep distinct between species so they look different. */
    seed: number;
  };
  foliage: {
    kind: 'sphere' | 'cone';
    radius: number;
    height?: number; // cone only
    segments: number;
    rings?: number; // sphere only
    liftY: number;
    color: [number, number, number, number];
  };
}): SubgraphDef {
  const g = createGraph();
  const COL = 280;
  const ROW = 180;

  // Boundary nodes: input on the left (unused — this subgraph takes no
  // parent inputs), output on the right.
  const inputNode = addNode(g, `subgraph-input/${opts.id}`, {
    position: { x: 0, y: ROW * 1.5 },
  });
  const outputNode = addNode(g, `subgraph-output/${opts.id}`, {
    position: { x: COL * 6, y: ROW * 1.5 },
  });

  // Trunk chain. The bark texture lives in its own subgraph
  // (subgraph/bark-texture) — this just instantiates it with the species'
  // seed and color palette, then feeds basecolor + normal into the
  // material. Drilling into "Bark Texture" in the graph switcher reveals
  // the noise + colorize + normal-from-height internals.
  const trunkGeo = addNode(g, 'core/cylinder', {
    position: { x: COL, y: 0 },
    inputValues: {
      radius: opts.trunk.radius,
      height: opts.trunk.height,
      segments: opts.trunk.segments,
    },
  });
  const bark = addNode(g, 'subgraph/bark-texture', {
    position: { x: COL * 2, y: -ROW * 0.4 },
    inputValues: {
      seed: opts.bark.seed,
      color_dark: opts.trunk.colorDark,
      color_light: opts.trunk.colorLight,
    },
  });
  // detail_scale + detail_strength control HOW the material uses the
  // detail textures supplied by the bark subgraph; the textures themselves
  // live inside subgraph/bark-texture.
  const trunkMat = addNode(g, 'core/material', {
    position: { x: COL * 4, y: -ROW * 0.4 },
    inputValues: { roughness: 0.95, metallic: 0, detail_scale: 6, detail_strength: 0.6 },
  });
  const trunkEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 5, y: 0 },
  });

  // Foliage chain.
  const foliageGeo = opts.foliage.kind === 'sphere'
    ? addNode(g, 'core/sphere', {
        position: { x: COL, y: ROW * 2 },
        inputValues: {
          radius: opts.foliage.radius,
          segments: opts.foliage.segments,
          rings: opts.foliage.rings ?? 12,
        },
      })
    : addNode(g, 'core/cone', {
        position: { x: COL, y: ROW * 2 },
        inputValues: {
          radius: opts.foliage.radius,
          height: opts.foliage.height ?? 1.6,
          segments: opts.foliage.segments,
        },
      });
  const foliageLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: {
      translate: [0, opts.foliage.liftY, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  const foliageMat = addNode(g, 'core/material', {
    position: { x: COL * 3, y: ROW * 3 },
    inputValues: {
      basecolor: opts.foliage.color,
      roughness: 0.9,
      metallic: 0,
    },
  });
  const foliageEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 4, y: ROW * 2 },
  });

  // Merge into a 2-entity tree scene — this is the subgraph's output.
  const treeMerge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 5, y: ROW },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });

  // Edges — trunk chain (bark subgraph provides basecolor + normal +
  // detail textures).
  addEdge(g, { node: trunkGeo.id, socket: 'geometry' }, { node: trunkEntity.id, socket: 'geometry' });
  addEdge(g, { node: bark.id, socket: 'basecolor' }, { node: trunkMat.id, socket: 'basecolor' });
  addEdge(g, { node: bark.id, socket: 'normal' }, { node: trunkMat.id, socket: 'normal' });
  addEdge(g, { node: bark.id, socket: 'detail_basecolor' }, { node: trunkMat.id, socket: 'detail_basecolor' });
  addEdge(g, { node: bark.id, socket: 'detail_normal' }, { node: trunkMat.id, socket: 'detail_normal' });
  addEdge(g, { node: trunkMat.id, socket: 'material' }, { node: trunkEntity.id, socket: 'material' });

  // Foliage chain.
  addEdge(g, { node: foliageGeo.id, socket: 'geometry' }, { node: foliageLift.id, socket: 'geometry' });
  addEdge(g, { node: foliageLift.id, socket: 'geometry' }, { node: foliageEntity.id, socket: 'geometry' });
  addEdge(g, { node: foliageMat.id, socket: 'material' }, { node: foliageEntity.id, socket: 'material' });

  // Tree merge → boundary output.
  addEdge(g, { node: trunkEntity.id, socket: 'scene' }, { node: treeMerge.id, socket: 'scene_0' });
  addEdge(g, { node: foliageEntity.id, socket: 'scene' }, { node: treeMerge.id, socket: 'scene_1' });
  addEdge(g, { node: treeMerge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id: opts.id,
    label: opts.label,
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// Tree dimensions follow real-world averages: oak ~20m, pine ~30m. World
// units are meters everywhere now.
export function buildOakSubgraph(): SubgraphDef {
  return buildTreeSubgraph({
    id: 'oak-tree',
    label: 'Oak Tree',
    trunk: {
      radius: 0.5,
      height: 8,
      segments: 12,
      colorDark: [0.13, 0.07, 0.04, 1],
      colorLight: [0.42, 0.28, 0.16, 1],
    },
    bark: { seed: 0.31 },
    foliage: {
      kind: 'sphere',
      radius: 6,
      segments: 20,
      rings: 14,
      liftY: 14, // sphere center at y=14; bottom at y=8 (trunk top), top at y=20
      color: [0.22, 0.5, 0.16, 1],
    },
  });
}

export function buildPineSubgraph(): SubgraphDef {
  return buildTreeSubgraph({
    id: 'pine-tree',
    label: 'Pine Tree',
    trunk: {
      radius: 0.4,
      height: 6,
      segments: 12,
      colorDark: [0.10, 0.06, 0.03, 1],
      colorLight: [0.36, 0.22, 0.12, 1],
    },
    bark: { seed: 0.72 },
    foliage: {
      kind: 'cone',
      radius: 5,
      height: 24,
      segments: 18,
      liftY: 6, // cone base at y=6 (trunk top), apex at y=30
      color: [0.1, 0.32, 0.18, 1],
    },
  });
}
