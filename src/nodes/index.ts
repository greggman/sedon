import { createNodeRegistry, type NodeRegistry } from '../core/node-def.js';
import { blendMaskNode } from './blend-mask.js';
import { blendNode } from './blend.js';
import { cloudAltitudeNode } from './cloud-altitude.js';
import { cloudMultiplyNode } from './cloud-multiply.js';
import { cloudSlopeNode } from './cloud-slope.js';
import { cloudStepNode } from './cloud-step.js';
import { colorizeNode } from './colorize.js';
import { coneNode } from './cone.js';
import { cubeNode } from './cube.js';
import { cylinderNode } from './cylinder.js';
import { distributeOnFacesNode } from './distribute-on-faces.js';
import { gridDistributeNode } from './grid-distribute.js';
import { gridNode } from './grid.js';
import { heightfieldNode } from './heightfield.js';
import { heightfieldToMeshNode } from './heightfield-to-mesh.js';
import { instanceGeometryOnPointsNode } from './instance-geometry-on-points.js';
import { instanceSceneOnPointsNode } from './instance-scene-on-points.js';
import { levelsNode } from './levels.js';
import { mapRangeNode } from './map-range.js';
import { materialNode } from './material.js';
import { mergeGeometryNode } from './merge-geometry.js';
import { mergeSceneEntitiesNode } from './merge-scene-entities.js';
import { mixNode } from './mix.js';
import { multiplyNode } from './multiply.js';
import { normalFromHeightNode } from './normal-from-height.js';
import { outputNode } from './output.js';
import { perlinNode } from './perlin.js';
import { planeNode } from './plane.js';
import { randomFloatCloudNode } from './random-float-cloud.js';
import { randomVec3CloudNode } from './random-vec3-cloud.js';
import { sceneEntityNode } from './scene-entity.js';
import { sceneMergeNode } from './scene-merge.js';
import { slopeFromHeightNode } from './slope-from-height.js';
import { solidColorNode } from './solid-color.js';
import { sphereNode } from './sphere.js';
import { terrainMaterialNode } from './terrain-material.js';
import { transformNode } from './transform.js';
import { uvTransformNode } from './uv-transform.js';
import { warpNode } from './warp.js';
import { worleyNode } from './worley.js';

export const CORE_NODES = [
  mixNode,
  multiplyNode,
  mapRangeNode,
  sphereNode,
  cubeNode,
  cylinderNode,
  coneNode,
  planeNode,
  transformNode,
  uvTransformNode,
  mergeGeometryNode,
  distributeOnFacesNode,
  gridDistributeNode,
  instanceGeometryOnPointsNode,
  instanceSceneOnPointsNode,
  randomVec3CloudNode,
  randomFloatCloudNode,
  cloudAltitudeNode,
  cloudSlopeNode,
  cloudStepNode,
  cloudMultiplyNode,
  heightfieldNode,
  heightfieldToMeshNode,
  solidColorNode,
  gridNode,
  perlinNode,
  worleyNode,
  blendNode,
  blendMaskNode,
  warpNode,
  colorizeNode,
  levelsNode,
  normalFromHeightNode,
  slopeFromHeightNode,
  materialNode,
  terrainMaterialNode,
  sceneEntityNode,
  sceneMergeNode,
  mergeSceneEntitiesNode,
  outputNode,
];

export function createCoreNodeRegistry(): NodeRegistry {
  const r = createNodeRegistry();
  for (const def of CORE_NODES) r.register(def);
  return r;
}

export {
  blendMaskNode,
  blendNode,
  cloudAltitudeNode,
  cloudMultiplyNode,
  cloudSlopeNode,
  cloudStepNode,
  colorizeNode,
  coneNode,
  cubeNode,
  cylinderNode,
  distributeOnFacesNode,
  gridDistributeNode,
  gridNode,
  heightfieldNode,
  heightfieldToMeshNode,
  instanceGeometryOnPointsNode,
  instanceSceneOnPointsNode,
  levelsNode,
  mapRangeNode,
  materialNode,
  mergeGeometryNode,
  mergeSceneEntitiesNode,
  mixNode,
  multiplyNode,
  normalFromHeightNode,
  outputNode,
  perlinNode,
  planeNode,
  randomFloatCloudNode,
  randomVec3CloudNode,
  sceneEntityNode,
  sceneMergeNode,
  slopeFromHeightNode,
  solidColorNode,
  sphereNode,
  terrainMaterialNode,
  transformNode,
  uvTransformNode,
  warpNode,
  worleyNode,
};
