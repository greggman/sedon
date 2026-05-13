import { addNode, createGraph, type Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import { buildOakLeafSubgraph } from './leaf-subgraphs.js';

// Leaf demo. Sets up a single leaf-authoring subgraph wrapper as the
// project's root so the preview pane immediately shows the leaf's
// `shape` and `veins` tiles. The user clicks into the wrapper (or
// chooses the subgraph from the graph switcher) to tune the
// underlying leaf/skeleton parameters without dragging nodes in from
// the menu each session.
//
// As leaf/colorize and leaf/normal land, the subgraph grows to feed
// real albedo and normal outputs; the demo doesn't need to change —
// the user is already pointed at the right subgraph.
export function createLeafDemo(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs: SubgraphDef[];
} {
  const leaf = buildOakLeafSubgraph();

  const g = createGraph();
  const wrapper = addNode(g, `subgraph/${leaf.id}`, {
    position: { x: 280, y: 0 },
  });

  return {
    graph: g,
    rootNodeId: wrapper.id,
    subgraphs: [leaf],
  };
}
