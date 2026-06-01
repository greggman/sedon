import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Three smaller plants whose only job in the demo is to showcase the
// new point-distribution + leaf-mesh nodes:
//
//   • Flower   — core/radial-points fans petals around a center.
//                Stem (cylinder) + petal ring (leaf-mesh) + receptacle
//                (sphere). Demonstrates "the palm-frond fan, but as a
//                standalone source you can drop anywhere."
//
//   • Fern     — core/stem-points (alternate mode) places opposite-
//                pairs of leaves up a stem. Demonstrates the
//                botanically-flavoured stem placement.
//
//   • Sunflower disc — core/phyllotaxis-points spirals seed-meshes
//                across a flat receptacle. Demonstrates the golden-
//                angle spiral.
//
// Same pattern as the existing tree species: stem geometry from a
// primitive + leaf/petal scatter from instance-geometry-on-points +
// scene-merge at the end.

const COL = 280;
const ROW = 180;

export function buildFlowerSubgraph(): SubgraphDef {
  const id = 'flower';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 2 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 7, y: ROW * 2 } });

  // ----- Stem ---------------------------------------------------------
  const stemGeo = addNode(g, 'core/cylinder', {
    position: { x: 0, y: 0 },
    inputValues: { radius: 0.02, height: 0.8, segments: 8 },
  });
  // Cylinder is centered on origin; translate so its base sits on the
  // ground and the top sits at y=0.8.
  const stemXform = addNode(g, 'core/transform', {
    position: { x: COL, y: 0 },
    inputValues: { translate: [0, 0.4, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const stemMat = addNode(g, 'core/material', {
    position: { x: COL, y: ROW * 1.2 },
    inputValues: {
      basecolor: [0.22, 0.45, 0.18, 1],
      roughness: 0.85,
      metallic: 0,
    },
  });
  const stemEntity = addNode(g, 'core/scene-entity', { position: { x: COL * 2, y: ROW * 0.6 } });

  // ----- Petals -------------------------------------------------------
  // 8 petals fanned around the top of the stem. tilt=20° gives a
  // gently-opened flower (90 would be closed, 0 fully flat).
  const petalPoints = addNode(g, 'core/radial-points', {
    position: { x: 0, y: ROW * 3 },
    inputValues: {
      center: [0, 0.85, 0],
      axis: [0, 1, 0],
      count: 8,
      radiusOffset: 0,
      tilt: 25,
      tiltJitter: 4,
      baseAngle: 0,
      seed: 0.31,
    },
  });
  // Use a small leaf-mesh as the petal. Heavy cup so it tapers to a
  // point; modest curl so the petal lifts at the tip.
  const petalGeo = addNode(g, 'core/leaf-mesh', {
    position: { x: 0, y: ROW * 4.3 },
    inputValues: {
      length: 0.32,
      width: 0.14,
      curl: 0.06,
      bend: 0.01,
      cup: 0.55,
      lengthDivisions: 6,
      widthDivisions: 3,
    },
  });
  const petalScatter = addNode(g, 'core/instance-geometry-on-points', {
    position: { x: COL * 2, y: ROW * 3.5 },
    inputValues: { scale: 1, align: true },
  });
  const petalMat = addNode(g, 'core/material', {
    position: { x: COL, y: ROW * 5.5 },
    inputValues: {
      basecolor: [0.92, 0.32, 0.4, 1],
      roughness: 0.6,
      metallic: 0,
      alpha_cutoff: 0,
    },
  });
  const petalEntity = addNode(g, 'core/scene-entity', { position: { x: COL * 3, y: ROW * 4 } });

  // ----- Receptacle (yellow center) -----------------------------------
  const centerGeo = addNode(g, 'core/sphere', {
    position: { x: 0, y: ROW * 6.6 },
    inputValues: { radius: 0.06, segments: 12, rings: 8 },
  });
  const centerXform = addNode(g, 'core/transform', {
    position: { x: COL, y: ROW * 6.6 },
    inputValues: { translate: [0, 0.85, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const centerMat = addNode(g, 'core/material', {
    position: { x: COL, y: ROW * 7.6 },
    inputValues: {
      basecolor: [0.95, 0.78, 0.18, 1],
      roughness: 0.7,
      metallic: 0,
    },
  });
  const centerEntity = addNode(g, 'core/scene-entity', { position: { x: COL * 2, y: ROW * 7 } });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 5, y: ROW * 3 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
    ],
  });

  // Wiring.
  addEdge(g, { node: stemGeo.id, socket: 'geometry' }, { node: stemXform.id, socket: 'geometry' });
  addEdge(g, { node: stemXform.id, socket: 'geometry' }, { node: stemEntity.id, socket: 'geometry' });
  addEdge(g, { node: stemMat.id, socket: 'material' }, { node: stemEntity.id, socket: 'material' });

  addEdge(g, { node: petalPoints.id, socket: 'points' }, { node: petalScatter.id, socket: 'points' });
  addEdge(g, { node: petalGeo.id, socket: 'geometry' }, { node: petalScatter.id, socket: 'instance' });
  addEdge(g, { node: petalScatter.id, socket: 'geometry' }, { node: petalEntity.id, socket: 'geometry' });
  addEdge(g, { node: petalMat.id, socket: 'material' }, { node: petalEntity.id, socket: 'material' });

  addEdge(g, { node: centerGeo.id, socket: 'geometry' }, { node: centerXform.id, socket: 'geometry' });
  addEdge(g, { node: centerXform.id, socket: 'geometry' }, { node: centerEntity.id, socket: 'geometry' });
  addEdge(g, { node: centerMat.id, socket: 'material' }, { node: centerEntity.id, socket: 'material' });

  addEdge(g, { node: stemEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: petalEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: centerEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_2' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Flower',
    category: 'Plants',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

export function buildFernSubgraph(): SubgraphDef {
  const id = 'fern';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 2 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 7, y: ROW * 2 } });

  // ----- Stalk --------------------------------------------------------
  const stalkGeo = addNode(g, 'core/cylinder', {
    position: { x: 0, y: 0 },
    inputValues: { radius: 0.025, height: 1.6, segments: 8 },
  });
  const stalkXform = addNode(g, 'core/transform', {
    position: { x: COL, y: 0 },
    inputValues: { translate: [0, 0.8, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const stalkMat = addNode(g, 'core/material', {
    position: { x: COL, y: ROW * 1.2 },
    inputValues: {
      basecolor: [0.28, 0.38, 0.18, 1],
      roughness: 0.85,
      metallic: 0,
    },
  });
  const stalkEntity = addNode(g, 'core/scene-entity', { position: { x: COL * 2, y: ROW * 0.6 } });

  // ----- Leaves -------------------------------------------------------
  // Opposite-decussate arrangement: 2 leaves per node, 90° rotated
  // between successive nodes. Looks fern-like enough at distance.
  const leafPoints = addNode(g, 'core/stem-points', {
    position: { x: 0, y: ROW * 3 },
    inputValues: {
      start: [0, 0, 0],
      axis: [0, 1, 0],
      length: 1.5,
      nodes: 7,
      mode: 1,          // opposite
      whorlCount: 2,    // ignored for opposite
      nodeRotation: 90, // decussate
      startAngle: 0,
      tilt: 45,
      startOffset: 0.15,
      seed: 0.6,
    },
  });
  // Long thin lanceolate leaves with strong curl so they droop.
  const leafGeo = addNode(g, 'core/leaf-mesh', {
    position: { x: 0, y: ROW * 4.3 },
    inputValues: {
      length: 0.7,
      width: 0.16,
      curl: 0.25,
      bend: 0.03,
      cup: 0.5,
      lengthDivisions: 8,
      widthDivisions: 3,
    },
  });
  const leafScatter = addNode(g, 'core/instance-geometry-on-points', {
    position: { x: COL * 2, y: ROW * 3.5 },
    inputValues: { scale: 1, align: true },
  });
  const leafMat = addNode(g, 'core/material', {
    position: { x: COL, y: ROW * 5.5 },
    inputValues: {
      basecolor: [0.18, 0.42, 0.14, 1],
      roughness: 0.75,
      metallic: 0,
    },
  });
  const leafEntity = addNode(g, 'core/scene-entity', { position: { x: COL * 3, y: ROW * 4 } });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 5, y: ROW * 2.3 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });

  addEdge(g, { node: stalkGeo.id, socket: 'geometry' }, { node: stalkXform.id, socket: 'geometry' });
  addEdge(g, { node: stalkXform.id, socket: 'geometry' }, { node: stalkEntity.id, socket: 'geometry' });
  addEdge(g, { node: stalkMat.id, socket: 'material' }, { node: stalkEntity.id, socket: 'material' });

  addEdge(g, { node: leafPoints.id, socket: 'points' }, { node: leafScatter.id, socket: 'points' });
  addEdge(g, { node: leafGeo.id, socket: 'geometry' }, { node: leafScatter.id, socket: 'instance' });
  addEdge(g, { node: leafScatter.id, socket: 'geometry' }, { node: leafEntity.id, socket: 'geometry' });
  addEdge(g, { node: leafMat.id, socket: 'material' }, { node: leafEntity.id, socket: 'material' });

  addEdge(g, { node: stalkEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: leafEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Fern',
    category: 'Plants',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

export function buildSunflowerDiscSubgraph(): SubgraphDef {
  const id = 'sunflower-disc';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 2 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 7, y: ROW * 2 } });

  // ----- Disc receptacle (just a thin cylinder lying on its side) -----
  const discGeo = addNode(g, 'core/cylinder', {
    position: { x: 0, y: 0 },
    inputValues: { radius: 0.7, height: 0.08, segments: 24 },
  });
  const discXform = addNode(g, 'core/transform', {
    position: { x: COL, y: 0 },
    inputValues: { translate: [0, 1.2, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const discMat = addNode(g, 'core/material', {
    position: { x: COL, y: ROW * 1.2 },
    inputValues: {
      basecolor: [0.34, 0.18, 0.08, 1],
      roughness: 0.9,
      metallic: 0,
    },
  });
  const discEntity = addNode(g, 'core/scene-entity', { position: { x: COL * 2, y: ROW * 0.6 } });

  // ----- Stem (so it doesn't float) -----------------------------------
  const stalkGeo = addNode(g, 'core/cylinder', {
    position: { x: 0, y: ROW * 2.2 },
    inputValues: { radius: 0.04, height: 1.2, segments: 8 },
  });
  const stalkXform = addNode(g, 'core/transform', {
    position: { x: COL, y: ROW * 2.2 },
    inputValues: { translate: [0, 0.6, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const stalkMat = addNode(g, 'core/material', {
    position: { x: COL, y: ROW * 3.2 },
    inputValues: {
      basecolor: [0.22, 0.42, 0.16, 1],
      roughness: 0.85,
      metallic: 0,
    },
  });
  const stalkEntity = addNode(g, 'core/scene-entity', { position: { x: COL * 2, y: ROW * 2.8 } });

  // ----- Seed spiral --------------------------------------------------
  // 120 seeds across the disc face, packed by the golden angle.
  // length=0 keeps them on the disc plane; radius+radiusGrowth fills
  // out from a tight center to the disc rim.
  const seedPoints = addNode(g, 'core/phyllotaxis-points', {
    position: { x: 0, y: ROW * 4.4 },
    inputValues: {
      center: [0, 1.245, 0],
      axis: [0, 1, 0],
      length: 0,
      count: 120,
      angle: 137.508,
      radius: 0.05,
      radiusGrowth: 12,
      seed: 0.2,
    },
  });
  const seedGeo = addNode(g, 'core/cone', {
    position: { x: 0, y: ROW * 5.4 },
    inputValues: { radius: 0.025, height: 0.07, segments: 5 },
  });
  const seedScatter = addNode(g, 'core/instance-geometry-on-points', {
    position: { x: COL * 2, y: ROW * 4.8 },
    inputValues: { scale: 1, align: true },
  });
  const seedMat = addNode(g, 'core/material', {
    position: { x: COL, y: ROW * 6.6 },
    inputValues: {
      basecolor: [0.18, 0.11, 0.06, 1],
      roughness: 0.85,
      metallic: 0,
    },
  });
  const seedEntity = addNode(g, 'core/scene-entity', { position: { x: COL * 3, y: ROW * 5.3 } });

  // ----- Outer ring of yellow petals via radial-points ---------------
  const petalPoints = addNode(g, 'core/radial-points', {
    position: { x: 0, y: ROW * 7.8 },
    inputValues: {
      center: [0, 1.245, 0],
      axis: [0, 1, 0],
      count: 22,
      radiusOffset: 0,
      tilt: 6,
      tiltJitter: 3,
      baseAngle: 0,
      seed: 0.74,
    },
  });
  const petalGeo = addNode(g, 'core/leaf-mesh', {
    position: { x: 0, y: ROW * 8.8 },
    inputValues: {
      length: 0.55,
      width: 0.16,
      curl: 0.04,
      bend: 0.01,
      cup: 0.65,
      lengthDivisions: 6,
      widthDivisions: 3,
    },
  });
  const petalScatter = addNode(g, 'core/instance-geometry-on-points', {
    position: { x: COL * 2, y: ROW * 8.2 },
    inputValues: { scale: 1, align: true },
  });
  const petalMat = addNode(g, 'core/material', {
    position: { x: COL, y: ROW * 10 },
    inputValues: {
      basecolor: [0.96, 0.78, 0.14, 1],
      roughness: 0.55,
      metallic: 0,
    },
  });
  const petalEntity = addNode(g, 'core/scene-entity', { position: { x: COL * 3, y: ROW * 8.7 } });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 5, y: ROW * 4 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
      { name: 'scene_3', type: 'Scene', optional: true },
    ],
  });

  // Wiring.
  addEdge(g, { node: discGeo.id, socket: 'geometry' }, { node: discXform.id, socket: 'geometry' });
  addEdge(g, { node: discXform.id, socket: 'geometry' }, { node: discEntity.id, socket: 'geometry' });
  addEdge(g, { node: discMat.id, socket: 'material' }, { node: discEntity.id, socket: 'material' });

  addEdge(g, { node: stalkGeo.id, socket: 'geometry' }, { node: stalkXform.id, socket: 'geometry' });
  addEdge(g, { node: stalkXform.id, socket: 'geometry' }, { node: stalkEntity.id, socket: 'geometry' });
  addEdge(g, { node: stalkMat.id, socket: 'material' }, { node: stalkEntity.id, socket: 'material' });

  addEdge(g, { node: seedPoints.id, socket: 'points' }, { node: seedScatter.id, socket: 'points' });
  addEdge(g, { node: seedGeo.id, socket: 'geometry' }, { node: seedScatter.id, socket: 'instance' });
  addEdge(g, { node: seedScatter.id, socket: 'geometry' }, { node: seedEntity.id, socket: 'geometry' });
  addEdge(g, { node: seedMat.id, socket: 'material' }, { node: seedEntity.id, socket: 'material' });

  addEdge(g, { node: petalPoints.id, socket: 'points' }, { node: petalScatter.id, socket: 'points' });
  addEdge(g, { node: petalGeo.id, socket: 'geometry' }, { node: petalScatter.id, socket: 'instance' });
  addEdge(g, { node: petalScatter.id, socket: 'geometry' }, { node: petalEntity.id, socket: 'geometry' });
  addEdge(g, { node: petalMat.id, socket: 'material' }, { node: petalEntity.id, socket: 'material' });

  addEdge(g, { node: discEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: stalkEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: seedEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_2' });
  addEdge(g, { node: petalEntity.id, socket: 'scene' }, { node: merge.id, socket: 'scene_3' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Sunflower disc',
    category: 'Plants',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
