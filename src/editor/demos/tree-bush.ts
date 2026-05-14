import { addEdge, addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import type { CameraState } from '../store.js';
import { buildBarkTextureSubgraph } from './texture-subgraphs.js';
import {
  buildBranchBushSubgraph,
  buildBranchTreeSubgraph,
} from './tree-bush-subgraphs.js';

// Demo for the BranchGraph pipeline (branch/recursive → branch/tropism →
// branch/tube + branch/sample-points → instance-on-points).
//
// The main view renders a single procedural oak-style tree with leaves
// AND flowers — both placed on the SAME BranchGraph by two separate
// `branch/sample-points` invocations with different filters, exercising
// the plan's "two point lists from one structure" claim.
//
// A bush variant is included as a separate subgraph (drillable via the
// graph switcher; not wired into the main scene because we don't yet have
// a Scene-level transform to place them side by side).
export function createTreeBushDemo(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
  cameras: Record<string, CameraState>;
} {
  const bark = buildBarkTextureSubgraph();
  const tree = buildBranchTreeSubgraph();
  const bush = buildBranchBushSubgraph();

  const g = createGraph();
  const COL = 280;

  const treeInst = addNode(g, `subgraph/${tree.id}`, {
    position: { x: 0, y: 0 },
  });
  const output = addNode(g, 'core/output', {
    position: { x: COL * 2, y: 0 },
    inputValues: { fog_density: 0, ambient: [0.25, 0.25, 0.28, 1] },
  });
  addEdge(g, { node: treeInst.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  const cameras: Record<string, CameraState> = {
    main: { yaw: 0.4, pitch: 0.2, distance: 14, target: [0, 3, 0] },
    'branch-tree': { yaw: 0.4, pitch: 0.2, distance: 14, target: [0, 3, 0] },
    'branch-bush': { yaw: 0.4, pitch: 0.25, distance: 3, target: [0, 0.5, 0] },
    'bark-texture': { yaw: 0, pitch: 0.6, distance: 3, target: [0, 0, 0] },
  };

  return {
    graph: g,
    rootNodeId: output.id,
    subgraphs: [bark, tree, bush],
    cameras,
  };
}
