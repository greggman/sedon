import { createNodeRegistry, type NodeRegistry } from '../core/node-def.js';
import { blendMaskNode } from './blend-mask.js';
import { blendNode } from './blend.js';
import { blurNode } from './blur.js';
import { branchMergeNode } from './branch-merge.js';
import { branchPalmNode } from './branch-palm.js';
import { branchRecursiveNode } from './branch-recursive.js';
import { branchSamplePointsNode } from './branch-sample-points.js';
import { branchSpaceColonizationNode } from './branch-space-colonization.js';
import { branchTropismNode } from './branch-tropism.js';
import { branchTubeNode } from './branch-tube.js';
import { branchWhorledPineNode } from './branch-whorled-pine.js';
import { singlePointNode } from './single-point.js';
import { cloudAltitudeNode } from './cloud-altitude.js';
import { cloudMultiplyNode } from './cloud-multiply.js';
import { cloudSlopeNode } from './cloud-slope.js';
import { cloudStepNode } from './cloud-step.js';
import { colorizeNode } from './colorize.js';
import { coneNode } from './cone.js';
import { cubeNode } from './cube.js';
import { cylinderNode } from './cylinder.js';
import { distanceTransformNode } from './distance-transform.js';
import { distributeInVolumeNode } from './distribute-in-volume.js';
import { distributeOnFacesNode } from './distribute-on-faces.js';
import { gridDistributeNode } from './grid-distribute.js';
import { gridNode } from './grid.js';
import { imageNode } from './image.js';
import { textureConvertNode } from './texture-convert.js';
import { textureMapRangeNode } from './texture-map-range.js';
import { textureToHeightfieldMeshNode } from './texture-to-heightfield-mesh.js';
import { instanceGeometryOnPointsNode } from './instance-geometry-on-points.js';
import { instanceSceneOnPointsNode } from './instance-scene-on-points.js';
import { leafMeshNode } from './leaf-mesh.js';
import { leafSkeletonNode } from './leaf-skeleton.js';
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
import { paletteNode } from './palette.js';
import { rampNode } from './ramp.js';
import { phyllotaxisPointsNode } from './phyllotaxis-points.js';
import { planeNode } from './plane.js';
import { radialPointsNode } from './radial-points.js';
import { randomFloatCloudNode } from './random-float-cloud.js';
import { randomVec3CloudNode } from './random-vec3-cloud.js';
import { grassNode } from './grass.js';
import { grassBladesNode } from './grass-blades.js';
import { pathMaskNode } from './path-mask.js';
import { ridgedNoiseNode } from './ridged-noise.js';
import { sceneEntityNode } from './scene-entity.js';
import { sceneMergeNode } from './scene-merge.js';
import { slopeFromHeightNode } from './slope-from-height.js';
import { solidColorNode } from './solid-color.js';
import { sphereNode } from './sphere.js';
import { stemPointsNode } from './stem-points.js';
import { hydraulicErosionNode } from './hydraulic-erosion.js';
import { pathCarveHeightfieldNode } from './path-carve-heightfield.js';
import { pathSplineNode } from './path-spline.js';
import { terrainLayerNode } from './terrain-layer.js';
import { waterPlaneNode } from './water-plane.js';
import { terrainRendererNode } from './terrain-renderer.js';
import { terrainMaterialNode } from './terrain-material.js';
import { terrainMultiLayerMaterialNode } from './terrain-multi-layer-material.js';
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
  distributeInVolumeNode,
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
  textureConvertNode,
  textureMapRangeNode,
  textureToHeightfieldMeshNode,
  solidColorNode,
  gridNode,
  imageNode,
  perlinNode,
  paletteNode,
  rampNode,
  worleyNode,
  ridgedNoiseNode,
  blendNode,
  blendMaskNode,
  blurNode,
  branchMergeNode,
  branchPalmNode,
  branchRecursiveNode,
  branchTropismNode,
  branchTubeNode,
  branchSamplePointsNode,
  branchSpaceColonizationNode,
  branchWhorledPineNode,
  singlePointNode,
  radialPointsNode,
  phyllotaxisPointsNode,
  stemPointsNode,
  distanceTransformNode,
  warpNode,
  colorizeNode,
  levelsNode,
  leafSkeletonNode,
  leafMeshNode,
  normalFromHeightNode,
  slopeFromHeightNode,
  materialNode,
  terrainMaterialNode,
  terrainLayerNode,
  terrainMultiLayerMaterialNode,
  terrainRendererNode,
  hydraulicErosionNode,
  pathSplineNode,
  pathCarveHeightfieldNode,
  waterPlaneNode,
  sceneEntityNode,
  sceneMergeNode,
  mergeSceneEntitiesNode,
  grassBladesNode,
  grassNode,
  pathMaskNode,
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
  blurNode,
  branchMergeNode,
  branchPalmNode,
  branchRecursiveNode,
  branchSamplePointsNode,
  branchSpaceColonizationNode,
  branchTropismNode,
  branchTubeNode,
  branchWhorledPineNode,
  distanceTransformNode,
  cloudAltitudeNode,
  cloudMultiplyNode,
  cloudSlopeNode,
  cloudStepNode,
  colorizeNode,
  grassBladesNode,
  grassNode,
  coneNode,
  cubeNode,
  cylinderNode,
  distributeInVolumeNode,
  distributeOnFacesNode,
  gridDistributeNode,
  gridNode,
  imageNode,
  textureConvertNode,
  textureMapRangeNode,
  textureToHeightfieldMeshNode,
  instanceGeometryOnPointsNode,
  instanceSceneOnPointsNode,
  leafMeshNode,
  leafSkeletonNode,
  levelsNode,
  mapRangeNode,
  materialNode,
  mergeGeometryNode,
  mergeSceneEntitiesNode,
  mixNode,
  multiplyNode,
  normalFromHeightNode,
  outputNode,
  pathMaskNode,
  perlinNode,
  paletteNode,
  rampNode,
  phyllotaxisPointsNode,
  planeNode,
  radialPointsNode,
  randomFloatCloudNode,
  randomVec3CloudNode,
  ridgedNoiseNode,
  sceneEntityNode,
  sceneMergeNode,
  slopeFromHeightNode,
  solidColorNode,
  sphereNode,
  stemPointsNode,
  hydraulicErosionNode,
  pathCarveHeightfieldNode,
  pathSplineNode,
  terrainLayerNode,
  terrainMaterialNode,
  terrainMultiLayerMaterialNode,
  terrainRendererNode,
  transformNode,
  waterPlaneNode,
  uvTransformNode,
  warpNode,
  worleyNode,
};
