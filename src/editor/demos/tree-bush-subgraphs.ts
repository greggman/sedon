import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Procedural tree built from the BranchGraph pipeline:
//
//   branch/recursive → branch/tropism → branch/tube → bark material →
//                  ↘                                                 ↘
//                    branch/sample-points (leaves)                    scene-merge → output
//                  ↘                                                 ↗
//                    branch/sample-points (flowers)
//
// Same BranchGraph feeds three downstream chains: tube mesh (the trunk +
// branches geometry), a leaf-card scatter, and a flower scatter. The leaf
// and flower scatters differ only in their sample-points filters and the
// material on their instanced geometry — proves the "leaves and flowers
// are two configurations of the same node" claim from the plan.
//
// Bark texture is reused from the existing `subgraph/bark-texture` —
// drill into "Bark Texture" via the graph switcher to inspect.

const COL = 280;
const ROW = 180;

export function buildBranchTreeSubgraph(): SubgraphDef {
  const id = 'branch-tree';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 2 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 9, y: ROW * 2 },
  });

  // === BranchGraph generation ============================================
  const recursive = addNode(g, 'branch/recursive', {
    position: { x: COL, y: 0 },
    inputValues: {
      trunkHeight: 6,
      trunkRadius: 0.28,
      trunkSegments: 10,
      maxDepth: 3,
      branchesPerSegment: 1,
      branchStart: 0.4,
      branchAngle: 50,
      branchAngleJitter: 12,
      lengthRatio: 0.6,
      radiusRatio: 0.5,
      branchCurvature: 4,
      phyllotaxisAngle: 137.5,
      segmentRatio: 0.75,
      minSegmentsPerBranch: 3,
      tipRadiusFraction: 0.2,
      seed: 0.31,
    },
  });

  const tropism = addNode(g, 'branch/tropism', {
    position: { x: COL * 2, y: 0 },
    inputValues: {
      gravity: 0.06,
      phototropism: [0, 0, 0],
      wobble: 0.015,
      wobbleSeed: 0.7,
    },
  });

  // === Trunk mesh: tube + bark material ===================================
  const tube = addNode(g, 'branch/tube', {
    position: { x: COL * 3, y: 0 },
    inputValues: { sides: 8, uvTilingV: 0.6 },
  });
  const bark = addNode(g, 'subgraph/bark-texture', {
    position: { x: COL * 3, y: -ROW * 1.4 },
    inputValues: {
      seed: 0.31,
      color_dark: [0.13, 0.07, 0.04, 1],
      color_light: [0.42, 0.28, 0.16, 1],
    },
  });
  const trunkMat = addNode(g, 'core/material', {
    position: { x: COL * 4, y: -ROW * 0.7 },
    inputValues: { roughness: 0.95, metallic: 0, detail_scale: 6, detail_strength: 0.6 },
  });
  const trunkEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 5, y: 0 },
  });

  // === Leaves: depth >= 2 (skip trunk + primary), thin twigs only ========
  const leafPoints = addNode(g, 'branch/sample-points', {
    position: { x: COL * 3, y: ROW * 2.3 },
    inputValues: {
      depthMin: 2,
      depthMax: 99,
      radiusMin: 0,
      radiusMax: 0.08,
      onlyTips: false,
      density: 60,
      seed: 0.5,
    },
  });
  const leafGeo = addNode(g, 'core/sphere', {
    position: { x: COL, y: ROW * 3.3 },
    inputValues: { radius: 1, segments: 6, rings: 4 },
  });
  const leafScatter = addNode(g, 'core/instance-geometry-on-points', {
    position: { x: COL * 4, y: ROW * 2.7 },
    inputValues: { scale: 0.12, align: true },
  });
  const leafColor = addNode(g, 'core/solid-color', {
    position: { x: COL * 3, y: ROW * 4.2 },
    inputValues: { color: [0.18, 0.42, 0.14, 1], resolution: 16 },
  });
  const leafMat = addNode(g, 'core/material', {
    position: { x: COL * 4, y: ROW * 4.2 },
    inputValues: { roughness: 0.9, metallic: 0 },
  });
  const leafEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 5, y: ROW * 3 },
  });

  // === Flowers: tips of the deepest branches only, lower density ========
  const flowerPoints = addNode(g, 'branch/sample-points', {
    position: { x: COL * 3, y: ROW * 5.5 },
    inputValues: {
      depthMin: 3,
      depthMax: 99,
      radiusMin: 0,
      radiusMax: 0.05,
      onlyTips: true,
      density: 1,
      seed: 0.85,
    },
  });
  const flowerGeo = addNode(g, 'core/sphere', {
    position: { x: COL, y: ROW * 6 },
    inputValues: { radius: 1, segments: 8, rings: 6 },
  });
  const flowerScatter = addNode(g, 'core/instance-geometry-on-points', {
    position: { x: COL * 4, y: ROW * 5.7 },
    inputValues: { scale: 0.07, align: true },
  });
  const flowerColor = addNode(g, 'core/solid-color', {
    position: { x: COL * 3, y: ROW * 6.8 },
    inputValues: { color: [0.95, 0.55, 0.7, 1], resolution: 16 },
  });
  const flowerMat = addNode(g, 'core/material', {
    position: { x: COL * 4, y: ROW * 6.8 },
    inputValues: { roughness: 0.8, metallic: 0 },
  });
  const flowerEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 5, y: ROW * 6 },
  });

  // === Merge: trunk + leaves → tree; tree + flowers → final =============
  const mergeTreeLeaves = addNode(g, 'core/scene-merge', {
    position: { x: COL * 7, y: ROW * 1.5 },
  });
  const mergeAll = addNode(g, 'core/scene-merge', {
    position: { x: COL * 8, y: ROW * 3 },
  });

  // === Edges =============================================================
  addEdge(g, { node: recursive.id, socket: 'branches' }, { node: tropism.id, socket: 'branches' });
  addEdge(g, { node: tropism.id, socket: 'branches' }, { node: tube.id, socket: 'branches' });
  addEdge(g, { node: tropism.id, socket: 'branches' }, { node: leafPoints.id, socket: 'branches' });
  addEdge(g, { node: tropism.id, socket: 'branches' }, { node: flowerPoints.id, socket: 'branches' });

  // Trunk wiring.
  addEdge(g, { node: tube.id, socket: 'geometry' }, { node: trunkEntity.id, socket: 'geometry' });
  addEdge(g, { node: bark.id, socket: 'basecolor' }, { node: trunkMat.id, socket: 'basecolor' });
  addEdge(g, { node: bark.id, socket: 'normal' }, { node: trunkMat.id, socket: 'normal' });
  addEdge(g, { node: bark.id, socket: 'detail_basecolor' }, { node: trunkMat.id, socket: 'detail_basecolor' });
  addEdge(g, { node: bark.id, socket: 'detail_normal' }, { node: trunkMat.id, socket: 'detail_normal' });
  addEdge(g, { node: trunkMat.id, socket: 'material' }, { node: trunkEntity.id, socket: 'material' });

  // Leaf wiring.
  addEdge(g, { node: leafPoints.id, socket: 'points' }, { node: leafScatter.id, socket: 'points' });
  addEdge(g, { node: leafGeo.id, socket: 'geometry' }, { node: leafScatter.id, socket: 'instance' });
  addEdge(g, { node: leafScatter.id, socket: 'geometry' }, { node: leafEntity.id, socket: 'geometry' });
  addEdge(g, { node: leafColor.id, socket: 'texture' }, { node: leafMat.id, socket: 'basecolor' });
  addEdge(g, { node: leafMat.id, socket: 'material' }, { node: leafEntity.id, socket: 'material' });

  // Flower wiring.
  addEdge(g, { node: flowerPoints.id, socket: 'points' }, { node: flowerScatter.id, socket: 'points' });
  addEdge(g, { node: flowerGeo.id, socket: 'geometry' }, { node: flowerScatter.id, socket: 'instance' });
  addEdge(g, { node: flowerScatter.id, socket: 'geometry' }, { node: flowerEntity.id, socket: 'geometry' });
  addEdge(g, { node: flowerColor.id, socket: 'texture' }, { node: flowerMat.id, socket: 'basecolor' });
  addEdge(g, { node: flowerMat.id, socket: 'material' }, { node: flowerEntity.id, socket: 'material' });

  // Merge.
  addEdge(g, { node: trunkEntity.id, socket: 'scene' }, { node: mergeTreeLeaves.id, socket: 'a' });
  addEdge(g, { node: leafEntity.id, socket: 'scene' }, { node: mergeTreeLeaves.id, socket: 'b' });
  addEdge(g, { node: mergeTreeLeaves.id, socket: 'scene' }, { node: mergeAll.id, socket: 'a' });
  addEdge(g, { node: flowerEntity.id, socket: 'scene' }, { node: mergeAll.id, socket: 'b' });
  addEdge(g, { node: mergeAll.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Branch Tree',
    category: 'Trees',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// Bush variant: shallower depth, more siblings at the base, no leader.
// Same node, different parameters — proves the family covers bushes.
export function buildBranchBushSubgraph(): SubgraphDef {
  const id = 'branch-bush';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 2 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 8, y: ROW * 2 },
  });

  const recursive = addNode(g, 'branch/recursive', {
    position: { x: COL, y: 0 },
    inputValues: {
      trunkHeight: 0.8,
      trunkRadius: 0.06,
      trunkSegments: 4,
      maxDepth: 3,
      branchesPerSegment: 3,
      branchStart: 0.0,
      branchAngle: 65,
      branchAngleJitter: 20,
      lengthRatio: 0.85,
      radiusRatio: 0.6,
      branchCurvature: 6,
      phyllotaxisAngle: 137.5,
      segmentRatio: 0.9,
      minSegmentsPerBranch: 3,
      tipRadiusFraction: 0.15,
      seed: 0.62,
    },
  });
  const tropism = addNode(g, 'branch/tropism', {
    position: { x: COL * 2, y: 0 },
    inputValues: {
      gravity: 0.08,
      phototropism: [0, 0.1, 0],
      wobble: 0.02,
      wobbleSeed: 0.3,
    },
  });
  const tube = addNode(g, 'branch/tube', {
    position: { x: COL * 3, y: 0 },
    inputValues: { sides: 6, uvTilingV: 1.2 },
  });
  const stemColor = addNode(g, 'core/solid-color', {
    position: { x: COL * 3, y: -ROW * 1.5 },
    inputValues: { color: [0.25, 0.18, 0.1, 1], resolution: 16 },
  });
  const stemMat = addNode(g, 'core/material', {
    position: { x: COL * 4, y: -ROW * 0.7 },
    inputValues: { roughness: 0.9, metallic: 0 },
  });
  const stemEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 5, y: 0 },
  });

  const leafPoints = addNode(g, 'branch/sample-points', {
    position: { x: COL * 3, y: ROW * 2 },
    inputValues: {
      depthMin: 1,
      depthMax: 99,
      radiusMin: 0,
      radiusMax: 0.04,
      onlyTips: false,
      density: 120,
      seed: 0.42,
    },
  });
  const leafGeo = addNode(g, 'core/sphere', {
    position: { x: COL, y: ROW * 3.2 },
    inputValues: { radius: 1, segments: 6, rings: 4 },
  });
  const leafScatter = addNode(g, 'core/instance-geometry-on-points', {
    position: { x: COL * 4, y: ROW * 2.4 },
    inputValues: { scale: 0.04, align: true },
  });
  const leafColor = addNode(g, 'core/solid-color', {
    position: { x: COL * 3, y: ROW * 4 },
    inputValues: { color: [0.22, 0.5, 0.18, 1], resolution: 16 },
  });
  const leafMat = addNode(g, 'core/material', {
    position: { x: COL * 4, y: ROW * 4 },
    inputValues: { roughness: 0.9, metallic: 0 },
  });
  const leafEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 5, y: ROW * 2.5 },
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 7, y: ROW * 1 },
  });

  addEdge(g, { node: recursive.id, socket: 'branches' }, { node: tropism.id, socket: 'branches' });
  addEdge(g, { node: tropism.id, socket: 'branches' }, { node: tube.id, socket: 'branches' });
  addEdge(g, { node: tropism.id, socket: 'branches' }, { node: leafPoints.id, socket: 'branches' });

  addEdge(g, { node: tube.id, socket: 'geometry' }, { node: stemEntity.id, socket: 'geometry' });
  addEdge(g, { node: stemColor.id, socket: 'texture' }, { node: stemMat.id, socket: 'basecolor' });
  addEdge(g, { node: stemMat.id, socket: 'material' }, { node: stemEntity.id, socket: 'material' });

  addEdge(g, { node: leafPoints.id, socket: 'points' }, { node: leafScatter.id, socket: 'points' });
  addEdge(g, { node: leafGeo.id, socket: 'geometry' }, { node: leafScatter.id, socket: 'instance' });
  addEdge(g, { node: leafScatter.id, socket: 'geometry' }, { node: leafEntity.id, socket: 'geometry' });
  addEdge(g, { node: leafColor.id, socket: 'texture' }, { node: leafMat.id, socket: 'basecolor' });
  addEdge(g, { node: leafMat.id, socket: 'material' }, { node: leafEntity.id, socket: 'material' });

  addEdge(g, { node: stemEntity.id, socket: 'scene' }, { node: merge.id, socket: 'a' });
  addEdge(g, { node: leafEntity.id, socket: 'scene' }, { node: merge.id, socket: 'b' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Branch Bush',
    category: 'Trees',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
