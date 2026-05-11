import type { Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import { createInitialGraph } from '../initial-graph.js';
import { createCityDemo } from './city.js';
import { createForestDemo } from './forest.js';

export interface Demo {
  id: string;
  label: string;
  /**
   * Build the project state for this demo. Returns the main graph + its
   * root output node + an optional list of subgraph defs that the demo
   * uses. The store loads all of them at once and the registry is rebuilt
   * to include the subgraph wrappers.
   */
  build: () => { graph: Graph; rootNodeId: string; subgraphs?: SubgraphDef[] };
}

export const DEMOS: Demo[] = [
  { id: 'basic', label: 'Basic', build: createInitialGraph },
  { id: 'forest', label: 'Forest', build: createForestDemo },
  { id: 'city', label: 'City', build: createCityDemo },
];
