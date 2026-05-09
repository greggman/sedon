import { createNodeRegistry, type NodeRegistry } from '../core/node-def.js';
import { colorNode } from './color.js';
import { mixNode } from './mix.js';

export const CORE_NODES = [colorNode, mixNode];

export function createCoreNodeRegistry(): NodeRegistry {
  const r = createNodeRegistry();
  for (const def of CORE_NODES) r.register(def);
  return r;
}

export { colorNode, mixNode };
