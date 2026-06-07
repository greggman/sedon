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
import { bevelNode } from './bevel.js';
import { boxNode } from './box.js';
import { coneNode } from './cone.js';
import { computeNormalsNode } from './compute-normals.js';
import { cornerPointsNode } from './corner-points.js';
import { cubeNode } from './cube.js';
import { curve2dNode } from './curve-2d.js';
import { cylinderNode } from './cylinder.js';
import { extrudeNode } from './extrude.js';
import { extrudeOnPathNode } from './extrude-on-path.js';
import { insetNode } from './inset.js';
import { distanceTransformNode } from './distance-transform.js';
import { distributeInVolumeNode } from './distribute-in-volume.js';
import { distributeOnFacesNode } from './distribute-on-faces.js';
import { forEachPointNode } from './for-each-point.js';
import { gridDistributeNode } from './grid-distribute.js';
import { gridNode } from './grid.js';
import { imageNode } from './image.js';
import { textureConvertNode } from './texture-convert.js';
import { textureMapRangeNode } from './texture-map-range.js';
import { textureToHeightfieldMeshNode } from './texture-to-heightfield-mesh.js';
import { instanceGeometryOnPointsNode } from './instance-geometry-on-points.js';
import { instanceSceneOnPointsNode } from './instance-scene-on-points.js';
import { latheNode } from './lathe.js';
import { leafMeshNode } from './leaf-mesh.js';
import { leafSkeletonNode } from './leaf-skeleton.js';
import { levelsNode } from './levels.js';
import { mapRangeNode } from './map-range.js';
import { materialNode } from './material.js';
import { mergeGeometryNode } from './merge-geometry.js';
import { mergeSceneEntitiesNode } from './merge-scene-entities.js';
import { mirrorNode } from './mirror.js';
import { mixNode } from './mix.js';
import { multiplyNode } from './multiply.js';
import { normalFromHeightNode } from './normal-from-height.js';
import { outputNode } from './output.js';
import { perlinNode } from './perlin.js';
import { paletteNode } from './palette.js';
import { rampNode } from './ramp.js';
import { phyllotaxisPointsNode } from './phyllotaxis-points.js';
import { planeNode } from './plane.js';
import { accumulateFloatCloudNode } from './accumulate-float-cloud.js';
import { vec3CloudFromFloatsNode } from './vec3-cloud-from-floats.js';
import { pointListNode } from './point-list.js';
import { pointsAlongAxisNode } from './points-along-axis.js';
import { pointsLineNode } from './points-line.js';
import { radialPointsNode } from './radial-points.js';
import { randomFloatCloudNode } from './random-float-cloud.js';
import { randomVec3CloudNode } from './random-vec3-cloud.js';
import { grassNode } from './grass.js';
import { grassBladesNode } from './grass-blades.js';
import { pathMaskNode } from './path-mask.js';
import { ridgedNoiseNode } from './ridged-noise.js';
import { sceneEntityNode } from './scene-entity.js';
import { sceneMergeNode } from './scene-merge.js';
import { selectByAngleNode } from './select-by-angle.js';
import { selectByNormalNode } from './select-by-normal.js';
import { selectCombineNode } from './select-combine.js';
import { selectInvertNode } from './select-invert.js';
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
import { transformSceneNode } from './transform-scene.js';
import { uvTransformNode } from './uv-transform.js';
import { warpNode } from './warp.js';
import { worleyNode } from './worley.js';

export const CORE_NODES = [
  mixNode,
  multiplyNode,
  mapRangeNode,
  sphereNode,
  cubeNode,
  boxNode,
  cylinderNode,
  coneNode,
  planeNode,
  curve2dNode,
  latheNode,
  extrudeOnPathNode,
  mirrorNode,
  computeNormalsNode,
  selectByAngleNode,
  selectByNormalNode,
  selectInvertNode,
  selectCombineNode,
  bevelNode,
  extrudeNode,
  insetNode,
  transformNode,
  transformSceneNode,
  uvTransformNode,
  mergeGeometryNode,
  cornerPointsNode,
  distributeInVolumeNode,
  distributeOnFacesNode,
  forEachPointNode,
  gridDistributeNode,
  instanceGeometryOnPointsNode,
  instanceSceneOnPointsNode,
  randomVec3CloudNode,
  randomFloatCloudNode,
  vec3CloudFromFloatsNode,
  cloudAltitudeNode,
  cloudSlopeNode,
  cloudStepNode,
  cloudMultiplyNode,
  accumulateFloatCloudNode,
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
  pointsLineNode,
  pointsAlongAxisNode,
  radialPointsNode,
  phyllotaxisPointsNode,
  pointListNode,
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
  accumulateFloatCloudNode,
  cloudAltitudeNode,
  cloudMultiplyNode,
  cloudSlopeNode,
  cloudStepNode,
  colorizeNode,
  grassBladesNode,
  grassNode,
  bevelNode,
  boxNode,
  coneNode,
  computeNormalsNode,
  cornerPointsNode,
  cubeNode,
  curve2dNode,
  cylinderNode,
  extrudeNode,
  extrudeOnPathNode,
  insetNode,
  latheNode,
  selectByAngleNode,
  selectByNormalNode,
  selectCombineNode,
  selectInvertNode,
  mirrorNode,
  distributeInVolumeNode,
  distributeOnFacesNode,
  forEachPointNode,
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
  pointListNode,
  pointsAlongAxisNode,
  pointsLineNode,
  radialPointsNode,
  randomFloatCloudNode,
  randomVec3CloudNode,
  vec3CloudFromFloatsNode,
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
  transformSceneNode,
  waterPlaneNode,
  uvTransformNode,
  warpNode,
  worleyNode,
};
