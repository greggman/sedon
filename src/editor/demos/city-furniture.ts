import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Street-furniture subgraphs for the city demo. Each builds a small
// self-contained scene at the origin with its base sitting on y=0,
// so the main scene can instance them on points (sidewalk corners,
// road centerlines, etc.) without any post-translate.
//
// Conventions:
//   • Units are metres. A 5m lamp post means it's 5m tall in the
//     scene's world.
//   • Geometry is centred in X / Z, base at y=0. The city's
//     `instance-scene-on-points` puts each wrapper instance at its
//     point's xyz directly.
//   • Materials are baked in (not exposed as wrapper inputs) so the
//     wrappers drop in without parameters. Body colors / metallic-
//     roughness values were picked to read at city-overview camera
//     distance, not for close-up photorealism.
//   • Output is a single `scene: Scene` — every part inside the
//     subgraph merges into that one scene so a wrapper instance is
//     drawn as one Scene with N entities.

const COL = 240;
const ROW = 160;

// === Lamp post ========================================================
//
// Slim vertical pole + small box housing at the top + a sphere for the
// bulb. The bulb sits inside the housing box, with most of the sphere
// hidden — what shows below the housing reads as "warm glow under the
// shade." Until emissive lands on core/material the bulb is just a
// bright basecolor (high value + low metallic) so it pops against the
// asphalt at city-overview distance.
//
// Wrapper has no inputs — drop one on a sidewalk corner and you get
// a complete light.
export function buildLampPostSubgraph(): SubgraphDef {
  const id = 'city-lamp-post';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 4 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 6, y: ROW * 4 },
  });

  // ── Pole: a 5m cylinder lifted so its base sits at y=0.
  const poleGeo = addNode(g, 'core/cylinder', {
    position: { x: COL, y: 0 },
    inputValues: { radius: 0.08, height: 5, segments: 16 },
  });
  const poleLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: 0 },
    inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const poleMat = addNode(g, 'core/material', {
    position: { x: COL * 2, y: ROW },
    inputValues: { basecolor: [0.18, 0.18, 0.2, 1], roughness: 0.55, metallic: 0.6 },
  });
  const poleEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW * 0.5 },
  });

  // ── Housing: a small box hanging off the top of the pole.
  const housingGeo = addNode(g, 'core/box', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { width: 0.35, height: 0.25, depth: 0.35 },
  });
  const housingLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: { translate: [0, 4.82, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const housingMat = addNode(g, 'core/material', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { basecolor: [0.12, 0.12, 0.13, 1], roughness: 0.4, metallic: 0.7 },
  });
  const housingEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW * 2.5 },
  });

  // ── Bulb: a small sphere just below the housing, with a hot warm
  // basecolor so the lamp reads as lit. Real emissive lands in a
  // later chunk; until then this is the best we can do without
  // changing the lighting model.
  const bulbGeo = addNode(g, 'core/sphere', {
    position: { x: COL, y: ROW * 5 },
    inputValues: { radius: 0.18, segments: 16, rings: 12 },
  });
  const bulbLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: ROW * 5 },
    inputValues: { translate: [0, 4.62, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const bulbMat = addNode(g, 'core/material', {
    position: { x: COL * 2, y: ROW * 6 },
    inputValues: { basecolor: [1.0, 0.92, 0.7, 1], roughness: 0.3, metallic: 0 },
  });
  const bulbEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW * 5.5 },
  });

  // ── Merge all three sub-scenes into one Scene the wrapper exports.
  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 5, y: ROW * 3 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
    ],
  });

  // Wire each part: geo → lift → entity, material → entity, entity → merge.
  addEdge(g, { node: poleGeo.id, socket: 'geometry' }, { node: poleLift.id, socket: 'geometry' });
  addEdge(g, { node: poleLift.id, socket: 'geometry' }, { node: poleEnt.id, socket: 'geometry' });
  addEdge(g, { node: poleMat.id, socket: 'material' }, { node: poleEnt.id, socket: 'material' });

  addEdge(g, { node: housingGeo.id, socket: 'geometry' }, { node: housingLift.id, socket: 'geometry' });
  addEdge(g, { node: housingLift.id, socket: 'geometry' }, { node: housingEnt.id, socket: 'geometry' });
  addEdge(g, { node: housingMat.id, socket: 'material' }, { node: housingEnt.id, socket: 'material' });

  addEdge(g, { node: bulbGeo.id, socket: 'geometry' }, { node: bulbLift.id, socket: 'geometry' });
  addEdge(g, { node: bulbLift.id, socket: 'geometry' }, { node: bulbEnt.id, socket: 'geometry' });
  addEdge(g, { node: bulbMat.id, socket: 'material' }, { node: bulbEnt.id, socket: 'material' });

  addEdge(g, { node: poleEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: housingEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: bulbEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_2' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Lamp Post',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Traffic signal ===================================================
//
// Vertical pole with a horizontal arm sticking out at the top and a
// three-light head hanging from the arm. The lights are colored
// spheres flush with the front face of the head box; they read as
// red/yellow/green stoplights at city-overview distance even without
// emissive (their basecolors are saturated enough to pop).
export function buildTrafficSignalSubgraph(): SubgraphDef {
  const id = 'city-traffic-signal';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 6 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 7, y: ROW * 6 },
  });

  // ── Pole: 6m vertical cylinder, base at y=0.
  const poleGeo = addNode(g, 'core/cylinder', {
    position: { x: COL, y: 0 },
    inputValues: { radius: 0.1, height: 6, segments: 16 },
  });
  const poleLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: 0 },
    inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const darkMat = addNode(g, 'core/material', {
    position: { x: 0, y: ROW * 2 },
    inputValues: { basecolor: [0.1, 0.1, 0.1, 1], roughness: 0.5, metallic: 0.5 },
  });
  const poleEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: 0 },
  });

  // ── Arm: 4m horizontal cylinder, axis along X. Default cylinders
  // are Y-up, so rotate Z by 90° to swing the axis horizontal.
  const armGeo = addNode(g, 'core/cylinder', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { radius: 0.06, height: 4, segments: 12 },
  });
  const armLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: { translate: [4, 5.7, 0], rotate: [0, 0, Math.PI / 2], scale: [1, 1, 1] },
  });
  const armEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW * 2 },
  });

  // ── Head: the rectangular housing the lights hang in. Width is
  // along Y to stack the lights vertically; the box's deep face
  // pokes forward (positive Z) so the lights face traffic.
  const headGeo = addNode(g, 'core/box', {
    position: { x: COL, y: ROW * 3 },
    inputValues: { width: 0.45, height: 1.3, depth: 0.35 },
  });
  const headLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { translate: [3.8, 5, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const headEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW * 3 },
  });

  // ── Three lights: red on top, yellow middle, green bottom. Spheres
  // sit slightly forward of the head's front face (+Z) so they
  // round-out from the housing.
  const lights: { color: [number, number, number, number]; y: number; row: number }[] = [
    { color: [1.0, 0.15, 0.15, 1], y: 5.5, row: 4 },
    { color: [1.0, 0.85, 0.2,  1], y: 5.0, row: 5 },
    { color: [0.2, 0.95, 0.35, 1], y: 4.5, row: 6 },
  ];
  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 6, y: ROW * 3 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
      { name: 'scene_3', type: 'Scene', optional: true },
      { name: 'scene_4', type: 'Scene', optional: true },
      { name: 'scene_5', type: 'Scene', optional: true },
    ],
  });

  // Wire pole, arm, head to dark material + merge.
  addEdge(g, { node: poleGeo.id, socket: 'geometry' }, { node: poleLift.id, socket: 'geometry' });
  addEdge(g, { node: poleLift.id, socket: 'geometry' }, { node: poleEnt.id, socket: 'geometry' });
  addEdge(g, { node: darkMat.id, socket: 'material' }, { node: poleEnt.id, socket: 'material' });

  addEdge(g, { node: armGeo.id, socket: 'geometry' }, { node: armLift.id, socket: 'geometry' });
  addEdge(g, { node: armLift.id, socket: 'geometry' }, { node: armEnt.id, socket: 'geometry' });
  addEdge(g, { node: darkMat.id, socket: 'material' }, { node: armEnt.id, socket: 'material' });

  addEdge(g, { node: headGeo.id, socket: 'geometry' }, { node: headLift.id, socket: 'geometry' });
  addEdge(g, { node: headLift.id, socket: 'geometry' }, { node: headEnt.id, socket: 'geometry' });
  addEdge(g, { node: darkMat.id, socket: 'material' }, { node: headEnt.id, socket: 'material' });

  addEdge(g, { node: poleEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: armEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: headEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_2' });

  // Lights — each is geometry + material + entity, all going into
  // the merge under their respective scene_3..5 slot.
  lights.forEach((light, i) => {
    const lGeo = addNode(g, 'core/sphere', {
      position: { x: COL, y: ROW * light.row },
      inputValues: { radius: 0.14, segments: 16, rings: 12 },
    });
    const lLift = addNode(g, 'core/transform-geometry', {
      position: { x: COL * 2, y: ROW * light.row },
      inputValues: { translate: [3.8, light.y, 0.2], rotate: [0, 0, 0], scale: [1, 1, 1] },
    });
    const lMat = addNode(g, 'core/material', {
      position: { x: COL * 3, y: ROW * light.row },
      inputValues: { basecolor: light.color, roughness: 0.4, metallic: 0 },
    });
    const lEnt = addNode(g, 'core/scene-entity', {
      position: { x: COL * 4, y: ROW * light.row },
    });
    addEdge(g, { node: lGeo.id, socket: 'geometry' }, { node: lLift.id, socket: 'geometry' });
    addEdge(g, { node: lLift.id, socket: 'geometry' }, { node: lEnt.id, socket: 'geometry' });
    addEdge(g, { node: lMat.id, socket: 'material' }, { node: lEnt.id, socket: 'material' });
    addEdge(g, { node: lEnt.id, socket: 'scene' }, { node: merge.id, socket: `scene_${3 + i}` });
  });

  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Traffic Signal',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Fire hydrant =====================================================
//
// Iconic squat red cylinder + dome cap + two side bolt caps. All
// proportions intentionally heavy / blocky to read at city-overview
// distance.
export function buildFireHydrantSubgraph(): SubgraphDef {
  const id = 'city-fire-hydrant';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 4 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 6, y: ROW * 4 },
  });

  // Shared red material — most of the hydrant.
  const redMat = addNode(g, 'core/material', {
    position: { x: 0, y: ROW * 2 },
    inputValues: { basecolor: [0.82, 0.12, 0.1, 1], roughness: 0.5, metallic: 0.1 },
  });

  // ── Body: squat cylinder, 0.7m tall, 0.2m radius.
  const bodyGeo = addNode(g, 'core/cylinder', {
    position: { x: COL, y: 0 },
    inputValues: { radius: 0.2, height: 0.7, segments: 16 },
  });
  const bodyLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: 0 },
    inputValues: { translate: [0, 0, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const bodyEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: 0 },
  });

  // ── Dome: sphere on top — most of it sits ABOVE the body but a
  // small fraction overlaps for a flush join.
  const domeGeo = addNode(g, 'core/sphere', {
    position: { x: COL, y: ROW },
    inputValues: { radius: 0.22, segments: 16, rings: 12 },
  });
  const domeLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: ROW },
    inputValues: { translate: [0, 0.75, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const domeEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW },
  });

  // ── Side bolt caps: two short cylinders sticking out left/right.
  // Cylinder axis is Y-up by default → rotate Z by 90° so the axis
  // is along X.
  const leftCapGeo = addNode(g, 'core/cylinder', {
    position: { x: COL, y: ROW * 2 },
    inputValues: { radius: 0.08, height: 0.18, segments: 12 },
  });
  const leftCapLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: { translate: [-0.19, 0.5, 0], rotate: [0, 0, Math.PI / 2], scale: [1, 1, 1] },
  });
  const leftCapEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW * 2 },
  });

  const rightCapGeo = addNode(g, 'core/cylinder', {
    position: { x: COL, y: ROW * 3 },
    inputValues: { radius: 0.08, height: 0.18, segments: 12 },
  });
  const rightCapLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { translate: [0.37, 0.5, 0], rotate: [0, 0, Math.PI / 2], scale: [1, 1, 1] },
  });
  const rightCapEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: ROW * 3 },
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 5, y: ROW * 1.5 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
      { name: 'scene_3', type: 'Scene', optional: true },
    ],
  });

  // Wire all four parts to the shared red material + merge.
  for (const [geo, lift, ent] of [
    [bodyGeo, bodyLift, bodyEnt],
    [domeGeo, domeLift, domeEnt],
    [leftCapGeo, leftCapLift, leftCapEnt],
    [rightCapGeo, rightCapLift, rightCapEnt],
  ] as const) {
    addEdge(g, { node: geo.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
    addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
    addEdge(g, { node: redMat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  }
  addEdge(g, { node: bodyEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: domeEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: leftCapEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_2' });
  addEdge(g, { node: rightCapEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_3' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Fire Hydrant',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Car ==============================================================
//
// Two stacked boxes (lower body + smaller cabin/greenhouse) plus four
// wheels at the corners. Boxy on purpose — at the city-overview camera
// distance the silhouette is what registers, and a sloped windshield
// reads as visual noise from above. Body color can be swapped on the
// instance by editing the wrapper's `body_color` input.
export function buildCarSubgraph(): SubgraphDef {
  const id = 'city-car';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, {
    position: { x: 0, y: ROW * 5 },
  });
  const outputNode = addNode(g, `subgraph-output/${id}`, {
    position: { x: COL * 7, y: ROW * 5 },
  });

  // Dimensions (in metres). World units use right-handed Y-up; the
  // car's length runs along Z (forward), width along X (left/right),
  // height along Y.
  const carLength = 4.5;
  const carWidth = 1.8;
  const bodyHeight = 0.9;   // from y=0.3 to y=1.2 (wheels half-buried below)
  const cabinHeight = 0.7;  // sits on top of the body, y=1.2 to y=1.9
  const wheelRadius = 0.35;
  const wheelWidth = 0.25;

  // Body color comes from the wrapper input so a city scatter can
  // randomise per-instance car colors.
  const bodyMat = addNode(g, 'core/material', {
    position: { x: COL, y: ROW * 4 },
    inputValues: { roughness: 0.35, metallic: 0.5 },
  });
  // Glass / cabin color — slight tint, glossy-ish.
  const glassMat = addNode(g, 'core/material', {
    position: { x: COL, y: ROW * 5 },
    inputValues: { basecolor: [0.12, 0.16, 0.2, 1], roughness: 0.25, metallic: 0 },
  });
  // Wheels — flat dark.
  const wheelMat = addNode(g, 'core/material', {
    position: { x: COL, y: ROW * 6 },
    inputValues: { basecolor: [0.05, 0.05, 0.06, 1], roughness: 0.7, metallic: 0 },
  });

  // ── Body box, lifted so its bottom is just above wheel hubs.
  const bodyGeo = addNode(g, 'core/box', {
    position: { x: COL * 2, y: 0 },
    inputValues: { width: carWidth, height: bodyHeight, depth: carLength },
  });
  const bodyLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 3, y: 0 },
    inputValues: { translate: [0, 0.3 + bodyHeight / 2, 0], rotate: [0, 0, 0], scale: [1, 1, 1] },
  });
  const bodyEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 4, y: 0 },
  });

  // ── Cabin (greenhouse) — shorter in length than the body, slightly
  // narrower, sitting on top. Reads as the roof at overview distance.
  const cabinGeo = addNode(g, 'core/box', {
    position: { x: COL * 2, y: ROW },
    inputValues: { width: carWidth - 0.1, height: cabinHeight, depth: carLength - 1.8 },
  });
  const cabinLift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 3, y: ROW },
    inputValues: {
      translate: [0, 0.3 + bodyHeight + cabinHeight / 2, -0.1],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  const cabinEnt = addNode(g, 'core/scene-entity', {
    position: { x: COL * 4, y: ROW },
  });

  // ── Four wheels. Cylinder axis is Y-up by default; rotate Z by 90°
  // so the axle runs along X (across the car's width). Position each
  // at one of the four corners, half-buried below y=0 so the bottom
  // tangent sits at the ground level.
  const wheelHalfLength = carLength / 2 - wheelRadius - 0.2;
  const wheelHalfWidth = carWidth / 2 - wheelWidth / 2 + 0.01;
  const wheelPositions: [number, number, number][] = [
    [ wheelHalfWidth + 0.215, wheelRadius,  wheelHalfLength],
    [-wheelHalfWidth, wheelRadius,  wheelHalfLength],
    [ wheelHalfWidth + 0.215, wheelRadius, -wheelHalfLength],
    [-wheelHalfWidth, wheelRadius, -wheelHalfLength],
  ];

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 6, y: ROW * 2.5 },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
      { name: 'scene_2', type: 'Scene', optional: true },
      { name: 'scene_3', type: 'Scene', optional: true },
      { name: 'scene_4', type: 'Scene', optional: true },
      { name: 'scene_5', type: 'Scene', optional: true },
    ],
  });

  // Body + cabin wiring.
  addEdge(g, { node: bodyGeo.id, socket: 'geometry' }, { node: bodyLift.id, socket: 'geometry' });
  addEdge(g, { node: bodyLift.id, socket: 'geometry' }, { node: bodyEnt.id, socket: 'geometry' });
  addEdge(g, { node: bodyMat.id, socket: 'material' }, { node: bodyEnt.id, socket: 'material' });
  addEdge(g, { node: bodyEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_0' });

  addEdge(g, { node: cabinGeo.id, socket: 'geometry' }, { node: cabinLift.id, socket: 'geometry' });
  addEdge(g, { node: cabinLift.id, socket: 'geometry' }, { node: cabinEnt.id, socket: 'geometry' });
  addEdge(g, { node: glassMat.id, socket: 'material' }, { node: cabinEnt.id, socket: 'material' });
  addEdge(g, { node: cabinEnt.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });

  // body_color from the wrapper input goes into bodyMat.basecolor.
  addEdge(g, { node: inputNode.id, socket: 'body_color' }, { node: bodyMat.id, socket: 'basecolor' });

  // Wheel wiring — one geometry + lift + entity per corner.
  wheelPositions.forEach((pos, i) => {
    const wGeo = addNode(g, 'core/cylinder', {
      position: { x: COL * 2, y: ROW * (3 + i * 0.8) },
      inputValues: { radius: wheelRadius, height: wheelWidth, segments: 16 },
    });
    const wLift = addNode(g, 'core/transform-geometry', {
      position: { x: COL * 3, y: ROW * (3 + i * 0.8) },
      inputValues: { translate: pos, rotate: [0, 0, Math.PI / 2], scale: [1, 1, 1] },
    });
    const wEnt = addNode(g, 'core/scene-entity', {
      position: { x: COL * 4, y: ROW * (3 + i * 0.8) },
    });
    addEdge(g, { node: wGeo.id, socket: 'geometry' }, { node: wLift.id, socket: 'geometry' });
    addEdge(g, { node: wLift.id, socket: 'geometry' }, { node: wEnt.id, socket: 'geometry' });
    addEdge(g, { node: wheelMat.id, socket: 'material' }, { node: wEnt.id, socket: 'material' });
    addEdge(g, { node: wEnt.id, socket: 'scene' }, { node: merge.id, socket: `scene_${2 + i}` });
  });

  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Car',
    category: 'Subgraphs',
    inputs: [
      { name: 'body_color', type: 'Vec4', default: [0.7, 0.15, 0.18, 1] },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
