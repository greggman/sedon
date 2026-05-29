import { addEdge, addNode, createGraph } from '../core/graph.js';
import type { NodeDef } from '../core/node-def.js';
import type { FloatCloudValue, PointCloudValue } from '../core/resources.js';

export const cloudAltitudeNode: NodeDef = {
  id: 'core/cloud-altitude',
  category: 'Distribution/Attributes',
  inputs: [
    {
      name: 'points',
      type: 'PointCloud',
      description: 'source point cloud — each point\'s Y coordinate becomes the output value at the same index',
    },
  ],
  outputs: [
    {
      name: 'values',
      type: 'FloatCloud',
      description: 'one Float per point: the raw world-space Y coordinate (NOT normalised). Combine with [core/cloud-step](../../core/cloud-step) to threshold, or feed directly into `per_point_active` if your point set has Y values straddling 0.5',
    },
  ],
  doc: {
    summary: 'Read each point\'s Y coordinate as a FloatCloud — altitude-driven scatter masks.',
    description: `
A trivial value extractor: emits each point's raw Y coordinate (NOT
normalised). On a sphere centred at origin radius 1 the range is
[-1, 1]; on a terrain heightfield it's the altitudes (metres) in the
texture itself — the per-vertex Y the mesher baked in.

The typical use is altitude-banded scattering: pipe through
[core/cloud-step](../../core/cloud-step) with a threshold to get a
binary "above the snow line" or "below sea level" mask, then feed
into the \`per_point_active\` input of an instancer.

Pair with [core/cloud-slope](../../core/cloud-slope) +
[core/cloud-multiply](../../core/cloud-multiply) for compound
conditions ("high altitude AND flat" for snowfields,
"low altitude AND steep" for cliff bases).
`,
    sampleGraph: () => {
      const g = createGraph();
      // Sphere → distribute → altitude → per_point_active.
      // Sphere centred at origin radius 1; altitude > 0.5 = top cap shows.
      const sphere = addNode(g, 'core/sphere', {
        id: 'sphere',
        position: { x: 0, y: 0 },
        inputValues: { radius: 1, segments: 32, rings: 16 },
      });
      const points = addNode(g, 'core/distribute-on-faces', {
        id: 'points',
        position: { x: 280, y: 0 },
        inputValues: { density: 30, seed: 0 },
      });
      const altitude = addNode(g, 'core/cloud-altitude', {
        id: 'altitude',
        position: { x: 560, y: 0 },
        inputValues: {},
      });
      const cube = addNode(g, 'core/cube', {
        id: 'cube',
        position: { x: 0, y: 200 },
        inputValues: { size: 1 },
      });
      const basecolor = addNode(g, 'core/solid-color', {
        id: 'basecolor',
        position: { x: 0, y: 380 },
        inputValues: { color: [0.65, 0.0, 0.0, 1], resolution: 32 },
      });
      const material = addNode(g, 'core/material', {
        id: 'material',
        position: { x: 280, y: 380 },
        inputValues: { roughness: 0.5, metallic: 0 },
      });
      const entity = addNode(g, 'core/scene-entity', {
        id: 'entity',
        position: { x: 560, y: 200 },
        inputValues: {},
      });
      const inst = addNode(g, 'core/instance-scene-on-points', {
        id: 'inst',
        position: { x: 840, y: 100 },
        inputValues: { scale: 0.05, align: true, seed: 0 },
      });
      addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: points.id, socket: 'geometry' });
      addEdge(g, { node: points.id, socket: 'points' }, { node: altitude.id, socket: 'points' });
      addEdge(g, { node: basecolor.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
      addEdge(g, { node: cube.id, socket: 'geometry' }, { node: entity.id, socket: 'geometry' });
      addEdge(g, { node: material.id, socket: 'material' }, { node: entity.id, socket: 'material' });
      addEdge(g, { node: points.id, socket: 'points' }, { node: inst.id, socket: 'points' });
      addEdge(g, { node: entity.id, socket: 'scene' }, { node: inst.id, socket: 'instance' });
      addEdge(g, { node: altitude.id, socket: 'values' }, { node: inst.id, socket: 'per_point_active' });
      return { graph: g, rootNodeId: 'inst' };
    },
  },
  evaluate(_ctx, inputs): { values: FloatCloudValue } {
    const points = inputs.points as PointCloudValue;
    const count = points.count;
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      values[i] = points.positions[i * 3 + 1]!;
    }
    return { values: { count, values } };
  },
};
