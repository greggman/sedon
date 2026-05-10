import type { Graph } from '../../core/graph.js';
import { createForestDemo } from './forest.js';

export interface Demo {
  id: string;
  label: string;
  build: () => { graph: Graph; rootNodeId: string };
}

export const DEMOS: Demo[] = [
  { id: 'forest', label: 'Forest', build: createForestDemo },
];
