import type { Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import { createInitialGraph } from '../initial-graph.js';
import type { CameraState } from '../store.js';
import { createCityDemo } from './city.js';
import { createForestDemo } from './forest.js';
import { createLeafDemo } from './leaf.js';
import { createTreeBushDemo } from './tree-bush.js';

export interface Demo {
  id: string;
  label: string;
  /**
   * Build the project state for this demo. Returns the main graph + its
   * root output node + an optional list of subgraph defs + optional
   * initial cameras (keyed by editing id: 'main' or a subgraph id). When
   * cameras aren't provided the default orbit camera is used.
   */
  build: () => {
    graph: Graph;
    rootNodeId: string;
    subgraphs?: SubgraphDef[];
    cameras?: Record<string, CameraState>;
  };
}

export const DEMOS: Demo[] = [
  { id: 'basic', label: 'Basic', build: createInitialGraph },
  { id: 'forest', label: 'Forest', build: createForestDemo },
  { id: 'city', label: 'City', build: createCityDemo },
  { id: 'leaf', label: 'Leaf', build: createLeafDemo },
  { id: 'tree-bush', label: 'Tree & Bush', build: createTreeBushDemo },
];
