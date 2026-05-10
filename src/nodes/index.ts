import { createNodeRegistry, type NodeRegistry } from '../core/node-def.js';
import { blendNode } from './blend.js';
import { colorizeNode } from './colorize.js';
import { cubeNode } from './cube.js';
import { distributeOnFacesNode } from './distribute-on-faces.js';
import { gridNode } from './grid.js';
import { instanceOnPointsNode } from './instance-on-points.js';
import { materialNode } from './material.js';
import { mixNode } from './mix.js';
import { normalFromHeightNode } from './normal-from-height.js';
import { outputNode } from './output.js';
import { perlinNode } from './perlin.js';
import { planeNode } from './plane.js';
import { solidColorNode } from './solid-color.js';
import { sphereNode } from './sphere.js';
import { transformNode } from './transform.js';
import { warpNode } from './warp.js';
import { worleyNode } from './worley.js';

export const CORE_NODES = [
  mixNode,
  sphereNode,
  cubeNode,
  planeNode,
  transformNode,
  distributeOnFacesNode,
  instanceOnPointsNode,
  solidColorNode,
  gridNode,
  perlinNode,
  worleyNode,
  blendNode,
  warpNode,
  colorizeNode,
  normalFromHeightNode,
  materialNode,
  outputNode,
];

export function createCoreNodeRegistry(): NodeRegistry {
  const r = createNodeRegistry();
  for (const def of CORE_NODES) r.register(def);
  return r;
}

export {
  blendNode,
  colorizeNode,
  cubeNode,
  distributeOnFacesNode,
  gridNode,
  instanceOnPointsNode,
  materialNode,
  mixNode,
  normalFromHeightNode,
  outputNode,
  perlinNode,
  planeNode,
  solidColorNode,
  sphereNode,
  transformNode,
  warpNode,
  worleyNode,
};
