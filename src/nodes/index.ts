import { createNodeRegistry, type NodeRegistry } from '../core/node-def.js';
import { blendNode } from './blend.js';
import { colorizeNode } from './colorize.js';
import { cubeNode } from './cube.js';
import { distributeOnFacesNode } from './distribute-on-faces.js';
import { gridNode } from './grid.js';
import { heightfieldNode } from './heightfield.js';
import { heightfieldToMeshNode } from './heightfield-to-mesh.js';
import { instanceOnPointsNode } from './instance-on-points.js';
import { mapRangeNode } from './map-range.js';
import { materialNode } from './material.js';
import { mixNode } from './mix.js';
import { multiplyNode } from './multiply.js';
import { normalFromHeightNode } from './normal-from-height.js';
import { outputNode } from './output.js';
import { perlinNode } from './perlin.js';
import { planeNode } from './plane.js';
import { randomFloatCloudNode } from './random-float-cloud.js';
import { randomVec3CloudNode } from './random-vec3-cloud.js';
import { solidColorNode } from './solid-color.js';
import { sphereNode } from './sphere.js';
import { transformNode } from './transform.js';
import { warpNode } from './warp.js';
import { worleyNode } from './worley.js';

export const CORE_NODES = [
  mixNode,
  multiplyNode,
  mapRangeNode,
  sphereNode,
  cubeNode,
  planeNode,
  transformNode,
  distributeOnFacesNode,
  instanceOnPointsNode,
  randomVec3CloudNode,
  randomFloatCloudNode,
  heightfieldNode,
  heightfieldToMeshNode,
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
  heightfieldNode,
  heightfieldToMeshNode,
  instanceOnPointsNode,
  mapRangeNode,
  materialNode,
  mixNode,
  multiplyNode,
  normalFromHeightNode,
  outputNode,
  perlinNode,
  planeNode,
  randomFloatCloudNode,
  randomVec3CloudNode,
  solidColorNode,
  sphereNode,
  transformNode,
  warpNode,
  worleyNode,
};
