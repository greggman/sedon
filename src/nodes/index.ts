import { createNodeRegistry, type NodeRegistry } from '../core/node-def.js';
import { blendNode } from './blend.js';
import { colorizeNode } from './colorize.js';
import { gridNode } from './grid.js';
import { materialNode } from './material.js';
import { mixNode } from './mix.js';
import { outputNode } from './output.js';
import { perlinNode } from './perlin.js';
import { solidColorNode } from './solid-color.js';
import { sphereNode } from './sphere.js';
import { warpNode } from './warp.js';
import { worleyNode } from './worley.js';

export const CORE_NODES = [
  mixNode,
  sphereNode,
  solidColorNode,
  gridNode,
  perlinNode,
  worleyNode,
  blendNode,
  warpNode,
  colorizeNode,
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
  gridNode,
  materialNode,
  mixNode,
  outputNode,
  perlinNode,
  solidColorNode,
  sphereNode,
  warpNode,
  worleyNode,
};
