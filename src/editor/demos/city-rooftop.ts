import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Rooftop fittings that read as "real city" from above and from the
// street at low pitches: HVAC condensers and the iconic NYC-style
// wooden water tank. These are the cheapest visual upgrades for the
// Spider-Man-2-NYC silhouette goal — they put irregular shapes on
// what would otherwise be flat concrete pads.
//
// Both subgraphs are pure "static" assets (no inputs). A downstream
// `core/box-face-points` on a building's +Y face produces a small
// grid of placement points; a `core/instance-scene-on-points` with
// the HVAC scene as `instance` then drops one unit per point. Same
// pattern for water tanks. Per-instance variety lives in the SCATTER
// inputs (yaw jitter, per_point_active mask) — the asset itself is a
// fixed mesh whose Geometry + Material refs the renderer shares
// across every roof in the city via ref-equality batching.
//
// Sizes are kept generic — a "typical" rooftop fitting that reads OK
// at distances from 5 m to 500 m. If you want bigger/smaller, scatter
// at a per-point scale.

const COL = 240;
const ROW = 160;

// Stack a single sized box with a flat-PBR material and wrap it as a
// scene entity. Used as the inner building block of every rooftop
// fixture below. `baseY` is the world-Y of the box's BASE (not its
// centre) since the iconic-form of "drop me on a rooftop point"
// expects local +Y = up off the roof.
function addRoofBox(
  g: ReturnType<typeof createGraph>,
  opts: {
    width: number;
    depth: number;
    height: number;
    baseY: number;
    materialInputs: Record<string, unknown>;
    yOffset: number;
    textureNode?: ReturnType<typeof addNode>;
  },
): ReturnType<typeof addNode> {
  const { width, depth, height, baseY, materialInputs, yOffset, textureNode } = opts;
  const geo = addNode(g, 'core/box', {
    position: { x: COL, y: yOffset },
    inputValues: { width, height, depth },
  });
  const lift = addNode(g, 'core/transform-geometry', {
    position: { x: COL * 2, y: yOffset },
    inputValues: {
      translate: [0, baseY + height / 2, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  const mat = addNode(g, 'core/material', {
    position: { x: COL * 2, y: yOffset + ROW * 0.5 },
    inputValues: materialInputs,
  });
  const ent = addNode(g, 'core/scene-entity', {
    position: { x: COL * 3, y: yOffset },
  });
  addEdge(g, { node: geo.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
  addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
  addEdge(g, { node: mat.id, socket: 'material' }, { node: ent.id, socket: 'material' });
  if (textureNode) {
    addEdge(g, { node: textureNode.id, socket: 'texture' }, { node: mat.id, socket: 'basecolor' });
  }
  return ent;
}

// === HVAC unit: rooftop AC condenser =============================
//
// A blocky grey-metal box that reads as "industrial fitting" from
// any distance. Two sub-boxes: the main condenser body and a slightly
// taller intake/grille on top. Solid metal-looking PBR (medium
// metallic, low-medium roughness) — no texture, the form alone
// reads correctly at city-overview scale.
//
// Footprint: 3 m × 2 m × 2 m main + 2.4 m × 1.6 m × 0.4 m intake.
// Local +Y is up off the roof, base sits on Y=0 so a scatter that
// places this on a roof point just translates to that point.
export function buildHvacUnitSubgraph(): SubgraphDef {
  const id = 'city-roof-hvac';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 4, y: ROW } });

  // Main condenser body — weathered grey-blue metal.
  const body = addRoofBox(g, {
    width: 3, depth: 2, height: 2, baseY: 0,
    materialInputs: {
      basecolor: [0.55, 0.58, 0.60, 1],
      roughness: 0.55,
      metallic: 0.6,
    },
    yOffset: 0,
  });
  // Intake/grille on top — slightly darker, smaller footprint.
  const intake = addRoofBox(g, {
    width: 2.4, depth: 1.6, height: 0.4, baseY: 2,
    materialInputs: {
      basecolor: [0.35, 0.38, 0.40, 1],
      roughness: 0.7,
      metallic: 0.4,
    },
    yOffset: ROW * 2,
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 3, y: ROW },
    extraInputs: [
      { name: 'scene_0', type: 'Scene', optional: true },
      { name: 'scene_1', type: 'Scene', optional: true },
    ],
  });
  addEdge(g, { node: body.id,   socket: 'scene' }, { node: merge.id, socket: 'scene_0' });
  addEdge(g, { node: intake.id, socket: 'scene' }, { node: merge.id, socket: 'scene_1' });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Rooftop HVAC',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

// === Water tank: NYC wooden rooftop tower ========================
//
// Wood-stave cylindrical tank on a 4-leg steel base. The iconic NYC
// rooftop silhouette — every Spider-Man swing-by needs at least one.
//
// Construction:
//   • 4 thin legs (steel-grey boxes) lifting the tank 2 m off the roof
//   • Tank body: 4 m tall × 1.5 m radius wooden cylinder
//   • Conical wood cap on top (also a short cylinder; a true cone is
//     overkill at the city distance we care about)
//
// Wood look comes from material colour alone (warm brown, high
// roughness, low metallic) — a banded plank texture would be more
// authentic but reads as noise at city overview scale.
export function buildWaterTankSubgraph(): SubgraphDef {
  const id = 'city-roof-water-tank';
  const g = createGraph();

  const inputNode = addNode(g, `subgraph-input/${id}`, { position: { x: 0, y: ROW * 3 } });
  const outputNode = addNode(g, `subgraph-output/${id}`, { position: { x: COL * 4, y: ROW * 3 } });

  // Wood material — shared across body and cap.
  const woodMat = (yOffset: number) => addNode(g, 'core/material', {
    position: { x: COL * 2, y: yOffset + ROW * 0.5 },
    inputValues: {
      basecolor: [0.42, 0.27, 0.18, 1], // weathered red-brown
      roughness: 0.85,
      metallic: 0,
    },
  });

  // Steel-leg material (the four supports below the tank).
  const legMat = (yOffset: number) => addNode(g, 'core/material', {
    position: { x: COL * 2, y: yOffset + ROW * 0.5 },
    inputValues: {
      basecolor: [0.25, 0.27, 0.30, 1],
      roughness: 0.45,
      metallic: 0.7,
    },
  });

  // Stack a sized cylinder + a lift transform + an entity. Tank body
  // lives on Y so the geometry needs lifting from "centred at origin"
  // to "base at baseY".
  const addCylinderEntity = (opts: {
    radius: number; height: number; segments: number; baseY: number;
    materialNode: ReturnType<typeof addNode>;
    yOffset: number;
  }) => {
    const geo = addNode(g, 'core/cylinder', {
      position: { x: COL, y: opts.yOffset },
      inputValues: { radius: opts.radius, height: opts.height, segments: opts.segments },
    });
    const lift = addNode(g, 'core/transform-geometry', {
      position: { x: COL * 2, y: opts.yOffset },
      inputValues: {
        translate: [0, opts.baseY + opts.height / 2, 0],
        rotate: [0, 0, 0],
        scale: [1, 1, 1],
      },
    });
    const ent = addNode(g, 'core/scene-entity', {
      position: { x: COL * 3, y: opts.yOffset },
    });
    addEdge(g, { node: geo.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
    addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
    addEdge(g, { node: opts.materialNode.id, socket: 'material' }, { node: ent.id, socket: 'material' });
    return ent;
  };

  // --- Four legs (steel boxes), 2 m tall, offset to the corners of a
  // 2.2 m square (= just inside the tank's 1.5 m radius footprint).
  const legPositions: [number, number][] = [
    [-1.0, -1.0], [1.0, -1.0], [1.0, 1.0], [-1.0, 1.0],
  ];
  const legEnts: ReturnType<typeof addNode>[] = [];
  legPositions.forEach((p, i) => {
    const yOff = i * ROW * 0.5;
    const geo = addNode(g, 'core/box', {
      position: { x: COL, y: yOff },
      inputValues: { width: 0.18, height: 2, depth: 0.18 },
    });
    const lift = addNode(g, 'core/transform-geometry', {
      position: { x: COL * 2, y: yOff },
      inputValues: {
        translate: [p[0], 1, p[1]],
        rotate: [0, 0, 0],
        scale: [1, 1, 1],
      },
    });
    const ent = addNode(g, 'core/scene-entity', {
      position: { x: COL * 3, y: yOff },
    });
    addEdge(g, { node: geo.id, socket: 'geometry' }, { node: lift.id, socket: 'geometry' });
    addEdge(g, { node: lift.id, socket: 'geometry' }, { node: ent.id, socket: 'geometry' });
    const legMatNode = legMat(yOff);
    addEdge(g, { node: legMatNode.id, socket: 'material' }, { node: ent.id, socket: 'material' });
    legEnts.push(ent);
  });

  // --- Tank body: wood cylinder, base at Y = 2 (top of legs).
  const tankBody = addCylinderEntity({
    radius: 1.5, height: 4, segments: 16, baseY: 2,
    materialNode: woodMat(ROW * 3),
    yOffset: ROW * 3,
  });
  // --- Cap: shorter wider cylinder on top — a stand-in for the
  // conical wooden cap that reads as a tank from any distance.
  const tankCap = addCylinderEntity({
    radius: 1.6, height: 0.4, segments: 16, baseY: 6,
    materialNode: woodMat(ROW * 4),
    yOffset: ROW * 4,
  });

  const merge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 3.5, y: ROW * 3 },
    extraInputs: legEnts.map((_, i) => ({ name: `scene_${i}`, type: 'Scene' as const })).concat([
      { name: `scene_${legEnts.length}`,     type: 'Scene' },
      { name: `scene_${legEnts.length + 1}`, type: 'Scene' },
    ]),
  });
  legEnts.forEach((leg, i) => {
    addEdge(g, { node: leg.id, socket: 'scene' }, { node: merge.id, socket: `scene_${i}` });
  });
  addEdge(g, { node: tankBody.id, socket: 'scene' }, { node: merge.id, socket: `scene_${legEnts.length}` });
  addEdge(g, { node: tankCap.id,  socket: 'scene' }, { node: merge.id, socket: `scene_${legEnts.length + 1}` });
  addEdge(g, { node: merge.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  return {
    id,
    label: 'Rooftop water tank',
    category: 'Subgraphs',
    inputs: [],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}
