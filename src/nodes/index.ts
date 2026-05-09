import { createNodeRegistry, type NodeRegistry } from '../core/node-def.js';
import { blendNode } from './blend.js';
import { colorNode } from './color.js';
import { gridNode } from './grid.js';
import { materialNode } from './material.js';
import { mixNode } from './mix.js';
import { outputNode } from './output.js';
import { solidColorNode } from './solid-color.js';
import { sphereNode } from './sphere.js';

export const CORE_NODES = [
  colorNode,
  mixNode,
  sphereNode,
  solidColorNode,
  gridNode,
  blendNode,
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
  colorNode,
  gridNode,
  materialNode,
  mixNode,
  outputNode,
  solidColorNode,
  sphereNode,
};
