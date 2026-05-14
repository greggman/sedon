import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import type { CameraState } from '../store.js';
import { buildOakLeafSubgraph } from './leaf-subgraphs.js';
import { buildBarkTextureSubgraph } from './texture-subgraphs.js';
import {
  buildBranchBushSubgraph,
  buildBranchCanopyTreeSubgraph,
  buildBranchPalmSubgraph,
  buildBranchPineSubgraph,
  buildBranchTreeSubgraph,
} from './tree-bush-subgraphs.js';

// Demo for the BranchGraph pipeline. Five plant-family subgraphs lined up
// in world X, each placed via `core/single-point` →
// `core/instance-scene-on-points`. Drill into any of the five via the
// graph switcher to tune parameters.
//
//   • Branch Tree    — `branch/recursive`           (oak-style deciduous, with flowers)
//   • Branch Bush    — `branch/recursive`           (shallow + dense parameters)
//   • Branch Pine    — `branch/whorled-pine`        (monopodial + whorls)
//   • Branch Palm    — `branch/palm`                (single trunk + frond ring)
//   • Branch Canopy  — `branch/space-colonization`  (attractor-grown big canopy)
//
// All five share the same Realize-stage nodes: `branch/tube`,
// `branch/sample-points`, `branch/tropism`, plus the standard
// instance-on-points / scene-merge plumbing.
export function createTreeBushDemo(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
  cameras: Record<string, CameraState>;
} {
  const bark = buildBarkTextureSubgraph();
  const oakLeaf = buildOakLeafSubgraph();
  const tree = buildBranchTreeSubgraph();
  const bush = buildBranchBushSubgraph();
  const pine = buildBranchPineSubgraph();
  const palm = buildBranchPalmSubgraph();
  const canopy = buildBranchCanopyTreeSubgraph();

  const g = createGraph();
  const COL = 280;
  const ROW = 180;

  interface SpeciesEntry {
    id: string;
    x: number;
    rowIdx: number;
  }

  // World positions chosen by trial-and-error so the species don't visually
  // collide despite their different canopy widths.
  const species: SpeciesEntry[] = [
    { id: bush.id, x: -16, rowIdx: 0 },
    { id: tree.id, x: -9, rowIdx: 1 },
    { id: canopy.id, x: 0, rowIdx: 2 },
    { id: pine.id, x: 10, rowIdx: 3 },
    { id: palm.id, x: 18, rowIdx: 4 },
  ];

  const merges: { id: string; position: { x: number; y: number } }[] = [];
  const speciesOutputs: { id: string; socket: string }[] = [];

  for (const s of species) {
    const point = addNode(g, 'core/single-point', {
      position: { x: 0, y: s.rowIdx * ROW },
      inputValues: { position: [s.x, 0, 0], normal: [0, 1, 0] },
    });
    const subInst = addNode(g, `subgraph/${s.id}`, {
      position: { x: COL, y: s.rowIdx * ROW },
    });
    const scatter = addNode(g, 'core/instance-scene-on-points', {
      position: { x: COL * 2, y: s.rowIdx * ROW },
      inputValues: { scale: 1, align: false, seed: 0 },
    });
    addEdge(g, { node: point.id, socket: 'points' }, { node: scatter.id, socket: 'points' });
    addEdge(g, { node: subInst.id, socket: 'scene' }, { node: scatter.id, socket: 'instance' });
    speciesOutputs.push({ id: scatter.id, socket: 'scene' });
  }

  // Chain N scene-merges to combine all four species into one Scene.
  let current = speciesOutputs[0]!;
  for (let i = 1; i < speciesOutputs.length; i++) {
    const next = speciesOutputs[i]!;
    const m = addNode(g, 'core/scene-merge', {
      position: { x: COL * 3, y: (i - 0.5) * ROW },
    });
    addEdge(g, { node: current.id, socket: current.socket }, { node: m.id, socket: 'a' });
    addEdge(g, { node: next.id, socket: next.socket }, { node: m.id, socket: 'b' });
    merges.push({ id: m.id, position: { x: COL * 3, y: (i - 0.5) * ROW } });
    current = { id: m.id, socket: 'scene' };
  }

  const output = addNode(g, 'core/output', {
    position: { x: COL * 4, y: ROW * 1.5 },
    inputValues: { fog_density: 0, ambient: [0.25, 0.25, 0.28, 1] },
  });
  addEdge(g, { node: current.id, socket: current.socket }, { node: output.id, socket: 'scene' });

  const cameras: Record<string, CameraState> = {
    main: { yaw: 0.45, pitch: 0.18, distance: 44, target: [0, 5, 0] },
    'branch-tree': { yaw: 0.4, pitch: 0.2, distance: 14, target: [0, 3, 0] },
    'branch-bush': { yaw: 0.4, pitch: 0.25, distance: 3, target: [0, 0.5, 0] },
    'branch-pine': { yaw: 0.4, pitch: 0.18, distance: 22, target: [0, 5.5, 0] },
    'branch-palm': { yaw: 0.4, pitch: 0.2, distance: 18, target: [0, 4, 0] },
    'branch-canopy': { yaw: 0.4, pitch: 0.2, distance: 22, target: [0, 6, 0] },
    'bark-texture': { yaw: 0, pitch: 0.6, distance: 3, target: [0, 0, 0] },
    'oak-leaf': { yaw: 0, pitch: 0.6, distance: 3, target: [0, 0, 0] },
  };

  return {
    graph: g,
    rootNodeId: output.id,
    subgraphs: [bark, oakLeaf, tree, bush, pine, palm, canopy],
    cameras,
  };
}
