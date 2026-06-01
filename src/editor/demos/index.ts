import type { Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import { createBasicScene } from '../initial-graph.js';
import type { CameraState } from '../store.js';
import { createBevelTestDemo } from './bevel-test.js';
import { createCityDemo } from './city.js';
import { createCubeOnWaterDemo } from './cube-on-water.js';
import { createForEachPointDemo } from './for-each-point.js';
import { createForestDemo } from './forest.js';
import { createGrassTestDemo } from './grass-test.js';
import { createLeafDemo } from './leaf.js';
import { createMultiLayerTerrainDemo } from './multi-layer-terrain.js';
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
  { id: 'basic', label: 'Basic', build: createBasicScene },
  { id: 'forest', label: 'Forest', build: createForestDemo },
  { id: 'city', label: 'City', build: createCityDemo },
  { id: 'leaf', label: 'Leaf', build: createLeafDemo },
  { id: 'tree-bush', label: 'Tree & Bush', build: createTreeBushDemo },
  { id: 'grass-test', label: 'Grass Test', build: createGrassTestDemo },
  { id: 'multi-layer-terrain', label: 'Terrain Layers (test)', build: createMultiLayerTerrainDemo },
  { id: 'cube-on-water', label: 'Cube on Water (reflection test)', build: createCubeOnWaterDemo },
  { id: 'for-each-point', label: 'For-Each-Point (cabinet test)', build: createForEachPointDemo },
  { id: 'bevel-test', label: 'Bevel (direction test)', build: createBevelTestDemo },
];
