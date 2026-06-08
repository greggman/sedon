// Build-time-only registry of demo builders. NOT imported by the
// runtime editor — `scripts/build.mjs` imports this module, calls
// each `build()`, serializes the result through `save-load.ts`'s
// `serializeSaveFile`, and writes one `.sedon` file per demo into
// `dist/demos/`. At runtime, the editor fetches those files instead
// of executing this code, so demo bundles stay out of the editor
// JS payload.
//
// The corresponding lightweight metadata list (id + label, no
// builders) lives in `./index.ts` and IS imported by the runtime.
// Both lists must stay in sync; the metadata list is the source of
// truth for menu order and labels.

import type { Graph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';
import type { CameraState } from '../store.js';
import { createBasicScene } from '../initial-graph.js';
import { createBevelTestDemo } from './bevel-test.js';
import { createCityDemo } from './city.js';
import { createCityFurniturePreviewDemo } from './city-furniture-preview.js';
import { createCubeOnWaterDemo } from './cube-on-water.js';
import { createForEachPointDemo } from './for-each-point.js';
import { createForestDemo } from './forest.js';
import { createFurnitureDemo } from './furniture.js';
import { createGrassTestDemo } from './grass-test.js';
import { createLeafDemo } from './leaf.js';
import { createMultiLayerTerrainDemo } from './multi-layer-terrain.js';
import { createTreeBushDemo } from './tree-bush.js';

export interface BuildableDemo {
  id: string;
  build: () => {
    graph: Graph;
    rootNodeId: string;
    subgraphs?: SubgraphDef[];
    cameras?: Record<string, CameraState>;
  };
}

export const BUILD_TIME_DEMOS: BuildableDemo[] = [
  { id: 'basic', build: createBasicScene },
  { id: 'forest', build: createForestDemo },
  { id: 'furniture', build: createFurnitureDemo },
  { id: 'city', build: createCityDemo },
  { id: 'city-furniture-preview', build: createCityFurniturePreviewDemo },
  { id: 'leaf', build: createLeafDemo },
  { id: 'tree-bush', build: createTreeBushDemo },
  { id: 'grass-test', build: createGrassTestDemo },
  { id: 'multi-layer-terrain', build: createMultiLayerTerrainDemo },
  { id: 'cube-on-water', build: createCubeOnWaterDemo },
  { id: 'for-each-point', build: createForEachPointDemo },
  { id: 'bevel-test', build: createBevelTestDemo },
];
