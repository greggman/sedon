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

  // === Leaves: real oak-leaf cards on thin twigs (depth >= 2) ==========
  // Plane rotated 90° so it stands up extending radially from the
  // branch; alpha-cutout material reveals the leaf silhouette.
  const leafPoints = addNode(g, 'branch/sample-points', {
    position: { x: COL * 3, y: ROW * 2.3 },
    inputValues: {
      depthMin: 2,
      depthMax: 99,
      radiusMin: 0,
      radiusMax: 0.08,
      onlyTips: false,
      density: 40,
      tipCount: 1,
      seed: 0.5,
    },
  });
  const leafGeo = addNode(g, 'core/plane', {
    position: { x: COL, y: ROW * 3.3 },
    inputValues: { size: [0.7, 1], divisions: [1, 1] },
  });
  const leafLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: ROW * 3.3 },
    inputValues: {
      translate: [0, 0.5, 0],
      rotate: [Math.PI / 2, 0, 0],
      scale: [1, 1, 1],
    },
  });
  const leafScatter = addNode(g, 'core/instance-geometry-on-points', {
    position: { x: COL * 4, y: ROW * 2.7 },
    inputValues: { scale: 0.18, align: true, seed: 0.5 },
  });
  const leafCard = addNode(g, 'subgraph/oak-leaf', {
    position: { x: COL * 3, y: ROW * 4.2 },
  });
  const leafMat = addNode(g, 'core/material', {
    position: { x: COL * 4, y: ROW * 4.2 },
    inputValues: { roughness: 0.85, metallic: 0, alpha_cutoff: 0.5 },
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
  const flowerMat = addNode(g, 'core/material', {
    position: { x: COL * 4, y: ROW * 6.8 },
    inputValues: {
      basecolor: [0.95, 0.55, 0.7, 1],
      roughness: 0.8,
      metallic: 0,
    },
  });
  const flowerEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 5, y: ROW * 6 },
  });

  // === Merge: trunk + leaves + flowers → final ===========================
  // `core/scene-merge` is variadic — one merge with three sockets covers
  // every producer; no intermediate merges needed.
  const mergeAll = addNode(g, 'core/scene-merge', {
    position: { x: COL * 8, y: ROW * 3 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
    ],
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
  addEdge(g, { node: leafGeo.id, socket: 'geometry' }, { node: leafLift.id, socket: 'geometry' });
  addEdge(g, { node: leafLift.id, socket: 'geometry' }, { node: leafScatter.id, socket: 'instance' });
  addEdge(g, { node: leafScatter.id, socket: 'geometry' }, { node: leafEntity.id, socket: 'geometry' });
  addEdge(g, { node: leafCard.id, socket: 'albedo' }, { node: leafMat.id, socket: 'basecolor' });
  addEdge(g, { node: leafCard.id, socket: 'normal' }, { node: leafMat.id, socket: 'normal' });
  addEdge(g, { node: leafMat.id, socket: 'material' }, { node: leafEntity.id, socket: 'material' });

  // Flower wiring.
  addEdge(g, { node: flowerPoints.id, socket: 'points' }, { node: flowerScatter.id, socket: 'points' });
  addEdge(g, { node: flowerGeo.id, socket: 'geometry' }, { node: flowerScatter.id, socket: 'instance' });
  addEdge(g, { node: flowerScatter.id, socket: 'geometry' }, { node: flowerEntity.id, socket: 'geometry' });
  addEdge(g, { node: flowerMat.id, socket: 'material' }, { node: flowerEntity.id, socket: 'material' });

  // Merge: trunk + leaves + flowers → final scene.
  addEdge(g, { node: trunkEntity.id, socket: 'scene' }, { node: mergeAll.id, socket: 'scene_0' });
  addEdge(g, { node: leafEntity.id, socket: 'scene' }, { node: mergeAll.id, socket: 'scene_1' });
  addEdge(g, { node: flowerEntity.id, socket: 'scene' }, { node: mergeAll.id, socket: 'scene_2' });
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
  const stemMat = addNode(g, 'core/material', {
    position: { x: COL * 4, y: -ROW * 0.7 },
    inputValues: {
      basecolor: [0.25, 0.18, 0.1, 1],
      roughness: 0.9,
      metallic: 0,
    },
  });
  const stemEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 5, y: 0 },
  });

  // Real oak-leaf cards (shared subgraph). Bush leaves are smaller —
  // tighter plane size, lower instance scale.
  const leafPoints = addNode(g, 'branch/sample-points', {
    position: { x: COL * 3, y: ROW * 2 },
    inputValues: {
      depthMin: 1,
      depthMax: 99,
      radiusMin: 0,
      radiusMax: 0.04,
      onlyTips: false,
      density: 80,
      tipCount: 1,
      seed: 0.42,
    },
  });
  const leafGeo = addNode(g, 'core/plane', {
    position: { x: COL, y: ROW * 3.2 },
    inputValues: { size: [0.7, 1], divisions: [1, 1] },
  });
  const leafLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: ROW * 3.2 },
    inputValues: {
      translate: [0, 0.5, 0],
      rotate: [Math.PI / 2, 0, 0],
      scale: [1, 1, 1],
    },
  });
  const leafScatter = addNode(g, 'core/instance-geometry-on-points', {
    position: { x: COL * 4, y: ROW * 2.4 },
    inputValues: { scale: 0.06, align: true, seed: 0.42 },
  });
  const leafCard = addNode(g, 'subgraph/oak-leaf', {
    position: { x: COL * 3, y: ROW * 4 },
  });
  const leafMat = addNode(g, 'core/material', {
    position: { x: COL * 4, y: ROW * 4 },
    inputValues: { roughness: 0.85, metallic: 0, alpha_cutoff: 0.5 },
  });
  const leafEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 5, y: ROW * 2.5 },
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 7, y: ROW * 1 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });

  addEdge(g, { node: recursive.id, socket: 'branches' }, { node: tropism.id, socket: 'branches' });
  addEdge(g, { node: tropism.id, socket: 'branches' }, { node: tube.id, socket: 'branches' });
  addEdge(g, { node: tropism.id, socket: 'branches' }, { node: leafPoints.id, socket: 'branches' });

  addEdge(g, { node: tube.id, socket: 'geometry' }, { node: stemEntity.id, socket: 'geometry' });
  addEdge(g, { node: stemMat.id, socket: 'material' }, { node: stemEntity.id, socket: 'material' });

  addEdge(g, { node: leafPoints.id, socket: 'points' }, { node: leafScatter.id, socket: 'points' });
  addEdge(g, { node: leafGeo.id, socket: 'geometry' }, { node: leafLift.id, socket: 'geometry' });
  addEdge(g, { node: leafLift.id, socket: 'geometry' }, { node: leafScatter.id, socket: 'instance' });
  addEdge(g, { node: leafScatter.id, socket: 'geometry' }, { node: leafEntity.id, socket: 'geometry' });
  addEdge(g, { node: leafCard.id, socket: 'albedo' }, { node: leafMat.id, socket: 'basecolor' });
  addEdge(g, { node: leafCard.id, socket: 'normal' }, { node: leafMat.id, socket: 'normal' });
  addEdge(g, { node: leafMat.id, socket: 'material' }, { node: leafEntity.id, socket: 'material' });

  addEdge(g, { node: stemEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: leafEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
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

// Palm: single unbranched trunk + a fan of frond instances at the tip.
// Fronds come from `branch/sample-points` with onlyTips=true and
// tipCount>1, then instanced via cone meshes (placeholder for proper
// frond meshes from the leaf pipeline).
export function buildBranchPalmSubgraph(): SubgraphDef {
  const id = 'branch-palm';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 2 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 8, y: ROW * 2 },
  });

  const palm = addNode(g, 'branch/palm', {
    position: { x: COL, y: 0 },
    inputValues: {
      height: 8,
      trunkRadiusBase: 0.16,
      trunkRadiusTip: 0.1,
      trunkSegments: 14,
      leanAngle: 6,
      leanCurvature: 0.6,
      leanAzimuth: 0,
      seed: 0.41,
    },
  });

  const tube = addNode(g, 'branch/tube', {
    position: { x: COL * 3, y: 0 },
    inputValues: { sides: 10, uvTilingV: 0.5 },
  });
  // Palm trunks are fibrous/vertical-ringed — the bark-texture vertical
  // fibers actually read fine here; just shift colors toward a paler
  // tan/grey than oak bark.
  const bark = addNode(g, 'subgraph/bark-texture', {
    position: { x: COL * 3, y: -ROW * 1.4 },
    inputValues: {
      seed: 0.41,
      color_dark: [0.22, 0.17, 0.11, 1],
      color_light: [0.55, 0.45, 0.32, 1],
    },
  });
  const trunkMat = addNode(g, 'core/material', {
    position: { x: COL * 4, y: -ROW * 0.7 },
    inputValues: { roughness: 0.92, metallic: 0, detail_scale: 5, detail_strength: 0.5 },
  });
  const trunkEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 5, y: 0 },
  });

  // Fronds: tipCount=14 emits 14 points at the trunk tip, normals fanned
  // radially around the tip tangent. Instance a long cone at each — the
  // cone's local +Y axis aligns to the radial direction, so its tip
  // points outward.
  const frondPoints = addNode(g, 'branch/sample-points', {
    position: { x: COL * 3, y: ROW * 2.3 },
    inputValues: {
      depthMin: 0,
      depthMax: 0,
      radiusMin: 0,
      radiusMax: 99,
      onlyTips: true,
      density: 0,
      tipCount: 14,
      seed: 0.41,
    },
  });
  const frondGeo = addNode(g, 'core/cone', {
    position: { x: COL, y: ROW * 3.4 },
    inputValues: { radius: 0.12, height: 2.4, segments: 6 },
  });
  const frondScatter = addNode(g, 'core/instance-geometry-on-points', {
    position: { x: COL * 4, y: ROW * 2.7 },
    inputValues: { scale: 1, align: true },
  });
  const frondMat = addNode(g, 'core/material', {
    position: { x: COL * 4, y: ROW * 4.2 },
    inputValues: {
      basecolor: [0.18, 0.45, 0.18, 1],
      roughness: 0.85,
      metallic: 0,
    },
  });
  const frondEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 5, y: ROW * 3 },
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 7, y: ROW * 1.5 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });

  addEdge(g, { node: palm.id, socket: 'branches' }, { node: tube.id, socket: 'branches' });
  addEdge(g, { node: palm.id, socket: 'branches' }, { node: frondPoints.id, socket: 'branches' });

  addEdge(g, { node: tube.id, socket: 'geometry' }, { node: trunkEntity.id, socket: 'geometry' });
  addEdge(g, { node: bark.id, socket: 'basecolor' }, { node: trunkMat.id, socket: 'basecolor' });
  addEdge(g, { node: bark.id, socket: 'normal' }, { node: trunkMat.id, socket: 'normal' });
  addEdge(g, { node: bark.id, socket: 'detail_basecolor' }, { node: trunkMat.id, socket: 'detail_basecolor' });
  addEdge(g, { node: bark.id, socket: 'detail_normal' }, { node: trunkMat.id, socket: 'detail_normal' });
  addEdge(g, { node: trunkMat.id, socket: 'material' }, { node: trunkEntity.id, socket: 'material' });

  addEdge(g, { node: frondPoints.id, socket: 'points' }, { node: frondScatter.id, socket: 'points' });
  addEdge(g, { node: frondGeo.id, socket: 'geometry' }, { node: frondScatter.id, socket: 'instance' });
  addEdge(g, { node: frondScatter.id, socket: 'geometry' }, { node: frondEntity.id, socket: 'geometry' });
  addEdge(g, { node: frondMat.id, socket: 'material' }, { node: frondEntity.id, socket: 'material' });

  addEdge(g, { node: trunkEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: frondEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Branch Palm',
    category: 'Trees',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// Whorled pine: monopodial trunk with conical whorls of branches. Tropism
// after the generator gives the branches their characteristic droop.
export function buildBranchPineSubgraph(): SubgraphDef {
  const id = 'branch-pine';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 2 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 9, y: ROW * 2 },
  });

  const pine = addNode(g, 'branch/whorled-pine', {
    position: { x: COL, y: 0 },
    inputValues: {
      trunkHeight: 11,
      trunkRadiusBase: 0.32,
      trunkRadiusTip: 0.04,
      trunkSegments: 16,
      trunkLean: 0,
      whorlCount: 8,
      whorlStart: 0.22,
      whorlEnd: 0.95,
      branchesPerWhorl: 6,
      whorlPhaseOffset: 35,
      branchLengthAtBase: 2.6,
      branchLengthAtTop: 0.5,
      branchAngle: 80,
      branchSegments: 6,
      branchRadiusFraction: 0.25,
      branchTipRadiusFraction: 0.15,
      subBranchCount: 0,
      subBranchLengthRatio: 0.4,
      subBranchAngle: 55,
      seed: 0.58,
    },
  });
  const tropism = addNode(g, 'branch/tropism', {
    position: { x: COL * 2, y: 0 },
    inputValues: {
      gravity: 0.18,
      phototropism: [0, 0, 0],
      wobble: 0.01,
      wobbleSeed: 0.5,
    },
  });
  const tube = addNode(g, 'branch/tube', {
    position: { x: COL * 3, y: 0 },
    inputValues: { sides: 8, uvTilingV: 0.6 },
  });
  const bark = addNode(g, 'subgraph/bark-texture', {
    position: { x: COL * 3, y: -ROW * 1.4 },
    inputValues: {
      seed: 0.72,
      color_dark: [0.1, 0.06, 0.03, 1],
      color_light: [0.36, 0.22, 0.12, 1],
    },
  });
  const trunkMat = addNode(g, 'core/material', {
    position: { x: COL * 4, y: -ROW * 0.7 },
    inputValues: { roughness: 0.95, metallic: 0, detail_scale: 6, detail_strength: 0.5 },
  });
  const trunkEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 5, y: 0 },
  });

  // Pine needles: dense scatter on the whorl branches (depth >= 1).
  // Use small dark-green spheres as needle-cluster placeholders.
  const needlePoints = addNode(g, 'branch/sample-points', {
    position: { x: COL * 4, y: ROW * 2.3 },
    inputValues: {
      depthMin: 1,
      depthMax: 99,
      radiusMin: 0,
      radiusMax: 0.1,
      onlyTips: false,
      density: 80,
      tipCount: 1,
      seed: 0.55,
    },
  });
  const needleGeo = addNode(g, 'core/sphere', {
    position: { x: COL, y: ROW * 3.4 },
    inputValues: { radius: 1, segments: 6, rings: 4 },
  });
  const needleScatter = addNode(g, 'core/instance-geometry-on-points', {
    position: { x: COL * 5, y: ROW * 2.7 },
    inputValues: { scale: 0.09, align: true },
  });
  const needleMat = addNode(g, 'core/material', {
    position: { x: COL * 5, y: ROW * 4.2 },
    inputValues: {
      basecolor: [0.08, 0.28, 0.16, 1],
      roughness: 0.9,
      metallic: 0,
    },
  });
  const needleEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 6, y: ROW * 3 },
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 8, y: ROW * 1.5 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });

  addEdge(g, { node: pine.id, socket: 'branches' }, { node: tropism.id, socket: 'branches' });
  addEdge(g, { node: tropism.id, socket: 'branches' }, { node: tube.id, socket: 'branches' });
  addEdge(g, { node: tropism.id, socket: 'branches' }, { node: needlePoints.id, socket: 'branches' });

  addEdge(g, { node: tube.id, socket: 'geometry' }, { node: trunkEntity.id, socket: 'geometry' });
  addEdge(g, { node: bark.id, socket: 'basecolor' }, { node: trunkMat.id, socket: 'basecolor' });
  addEdge(g, { node: bark.id, socket: 'normal' }, { node: trunkMat.id, socket: 'normal' });
  addEdge(g, { node: bark.id, socket: 'detail_basecolor' }, { node: trunkMat.id, socket: 'detail_basecolor' });
  addEdge(g, { node: bark.id, socket: 'detail_normal' }, { node: trunkMat.id, socket: 'detail_normal' });
  addEdge(g, { node: trunkMat.id, socket: 'material' }, { node: trunkEntity.id, socket: 'material' });

  addEdge(g, { node: needlePoints.id, socket: 'points' }, { node: needleScatter.id, socket: 'points' });
  addEdge(g, { node: needleGeo.id, socket: 'geometry' }, { node: needleScatter.id, socket: 'instance' });
  addEdge(g, { node: needleScatter.id, socket: 'geometry' }, { node: needleEntity.id, socket: 'geometry' });
  addEdge(g, { node: needleMat.id, socket: 'material' }, { node: needleEntity.id, socket: 'material' });

  addEdge(g, { node: trunkEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: needleEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Branch Pine',
    category: 'Trees',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// Space-colonization canopy tree. Scatters attractor points on the surface
// of a lifted sphere, then grows a tree from origin toward them — produces
// the irregular forking + canopy-conforming silhouette characteristic of
// big deciduous trees (oak, maple, beech).
export function buildBranchCanopyTreeSubgraph(): SubgraphDef {
  const id = 'branch-canopy';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 2 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 10, y: ROW * 2 },
  });

  // === Attractor envelope: a sphere lifted into the canopy zone. ========
  const crownSphere = addNode(g, 'core/sphere', {
    position: { x: 0, y: 0 },
    inputValues: { radius: 4, segments: 14, rings: 10 },
  });
  const crownLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL, y: 0 },
    inputValues: { translate: [0, 9, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  // Volume-fill the sphere instead of just sampling its skin —
  // distribute-on-faces gave a hollow shell of attractors that left
  // the space-colonization growth with no interior structure to chase
  // (Runions's paper canonically uses a volume envelope).
  const attractors = addNode(g, 'core/distribute-in-volume', {
    position: { x: COL * 2, y: 0 },
    inputValues: { density: 1.5, seed: 123 },
  });

  // === Grow toward attractors ==========================================
  const sc = addNode(g, 'branch/space-colonization', {
    position: { x: COL * 3, y: 0 },
    inputValues: {
      trunkStart: [0, 0, 0],
      trunkInitialDirection: [0, 1, 0],
      attractorRadius: 3.5,
      killRadius: 0.5,
      segmentLength: 0.4,
      maxIterations: 300,
      upBias: 0.18,
      rootRadius: 0.35,
      tipRadius: 0.03,
      radiusExponent: 2.5,
    },
  });
  const tropism = addNode(g, 'branch/tropism', {
    position: { x: COL * 4, y: 0 },
    inputValues: {
      gravity: 0.03,
      phototropism: [0, 0, 0],
      wobble: 0.005,
      wobbleSeed: 0.2,
    },
  });

  // === Trunk geometry ===================================================
  const tube = addNode(g, 'branch/tube', {
    position: { x: COL * 5, y: 0 },
    inputValues: { sides: 8, uvTilingV: 0.6 },
  });
  const bark = addNode(g, 'subgraph/bark-texture', {
    position: { x: COL * 5, y: -ROW * 1.4 },
    inputValues: {
      seed: 0.62,
      color_dark: [0.15, 0.09, 0.05, 1],
      color_light: [0.48, 0.32, 0.19, 1],
    },
  });
  const trunkMat = addNode(g, 'core/material', {
    position: { x: COL * 6, y: -ROW * 0.7 },
    inputValues: { roughness: 0.95, metallic: 0, detail_scale: 6, detail_strength: 0.55 },
  });
  const trunkEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 7, y: 0 },
  });

  // === Leaves: real leaf-textured cards on thin twigs ==================
  // The plane mesh is rotated 90° around X so its local +Y axis is the
  // leaf's outward direction (base at y=0, tip at y=1). After
  // instance-on-points aligns local +Y to each point's radial normal,
  // cards stand up perpendicular to the branch surface — leaves extend
  // outward like real leaves. The cutout pipeline reveals the leaf
  // silhouette via alpha discard; a non-zero scatter seed adds per-leaf
  // yaw jitter so neighbors don't all face the same direction.
  const leafPoints = addNode(g, 'branch/sample-points', {
    position: { x: COL * 5, y: ROW * 2.3 },
    inputValues: {
      // depthMin 0 keeps trunk segments eligible too — the new radius
      // taper means only the THIN end of the trunk passes radiusMax
      // anyway, so this fills out the canopy crown without dressing
      // the trunk's base.
      depthMin: 0,
      depthMax: 99,
      radiusMin: 0,
      radiusMax: 0.06,
      onlyTips: false,
      // Dropped from 50 to match the new radius taper + the dedup'd
      // space-colonization growth: more sub-branches qualify for leaves
      // now, so a lower per-branch density adds up to roughly the same
      // total foliage with cards not overlapping each other. The
      // earlier "100s of leaves on one branch" wasn't density-driven —
      // it was hundreds of overlapping siblings from a
      // space-colonization cancellation bug, since fixed.
      density: 9,
      tipCount: 1,
      seed: 0.35,
    },
  });
  const leafGeo = addNode(g, 'core/plane', {
    position: { x: COL, y: ROW * 3.4 },
    inputValues: { size: [0.7, 1], divisions: [1, 1] },
  });
  const leafLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: ROW * 3.4 },
    inputValues: {
      translate: [0, 0.5, 0],
      rotate: [Math.PI / 2, 0, 0],
      scale: [1, 1, 1],
    },
  });
  const leafScatter = addNode(g, 'core/instance-geometry-on-points', {
    position: { x: COL * 6, y: ROW * 2.7 },
    // scale=1: the oak-leaf plane is already authored at a natural
    // foliage size; the previous 0.15 was a workaround for the dense
    // bottle-brush packing, which the algorithm-side fixes
    // (sat_add'd radii + cancellation-dedup'd siblings) made
    // unnecessary.
    inputValues: { scale: 1, align: true, seed: 0.7 },
  });
  const leafCard = addNode(g, 'subgraph/oak-leaf', {
    position: { x: COL * 5, y: ROW * 4.2 },
  });
  const leafMat = addNode(g, 'core/material', {
    position: { x: COL * 6, y: ROW * 4.2 },
    inputValues: { roughness: 0.85, metallic: 0, alpha_cutoff: 0.5 },
  });
  const leafEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 7, y: ROW * 3 },
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 9, y: ROW * 1.5 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });

  // === Edges ===========================================================
  addEdge(g, { node: crownSphere.id, socket: 'geometry' }, { node: crownLift.id, socket: 'geometry' });
  addEdge(g, { node: crownLift.id, socket: 'geometry' }, { node: attractors.id, socket: 'geometry' });
  addEdge(g, { node: attractors.id, socket: 'points' }, { node: sc.id, socket: 'attractors' });
  addEdge(g, { node: sc.id, socket: 'branches' }, { node: tropism.id, socket: 'branches' });
  addEdge(g, { node: tropism.id, socket: 'branches' }, { node: tube.id, socket: 'branches' });
  addEdge(g, { node: tropism.id, socket: 'branches' }, { node: leafPoints.id, socket: 'branches' });

  addEdge(g, { node: tube.id, socket: 'geometry' }, { node: trunkEntity.id, socket: 'geometry' });
  addEdge(g, { node: bark.id, socket: 'basecolor' }, { node: trunkMat.id, socket: 'basecolor' });
  addEdge(g, { node: bark.id, socket: 'normal' }, { node: trunkMat.id, socket: 'normal' });
  addEdge(g, { node: bark.id, socket: 'detail_basecolor' }, { node: trunkMat.id, socket: 'detail_basecolor' });
  addEdge(g, { node: bark.id, socket: 'detail_normal' }, { node: trunkMat.id, socket: 'detail_normal' });
  addEdge(g, { node: trunkMat.id, socket: 'material' }, { node: trunkEntity.id, socket: 'material' });

  addEdge(g, { node: leafPoints.id, socket: 'points' }, { node: leafScatter.id, socket: 'points' });
  addEdge(g, { node: leafGeo.id, socket: 'geometry' }, { node: leafLift.id, socket: 'geometry' });
  addEdge(g, { node: leafLift.id, socket: 'geometry' }, { node: leafScatter.id, socket: 'instance' });
  addEdge(g, { node: leafScatter.id, socket: 'geometry' }, { node: leafEntity.id, socket: 'geometry' });
  addEdge(g, { node: leafCard.id, socket: 'albedo' }, { node: leafMat.id, socket: 'basecolor' });
  addEdge(g, { node: leafCard.id, socket: 'normal' }, { node: leafMat.id, socket: 'normal' });
  addEdge(g, { node: leafMat.id, socket: 'material' }, { node: leafEntity.id, socket: 'material' });

  addEdge(g, { node: trunkEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: leafEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Branch Canopy',
    category: 'Trees',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
