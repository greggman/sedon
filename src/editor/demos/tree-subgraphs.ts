import { addEdge, addNode, createGraph } from '../../core/graph.js';
import type { SubgraphDef } from '../../core/subgraph.js';

// Build a tree subgraph: cylinder trunk + (sphere | cone) foliage, each
// with its own solid-color material, merged into a 2-entity Scene. The
// boundary nodes are placed at left/right and the inner graph wires the
// instance-scene-on-points path entirely inside, so a parent graph just
// needs to pass `points` and (optionally) `tint` to get a populated Scene.
//
// `id` and `label` are visible in the editor; everything else is implicit.
function buildTreeSubgraph(opts: {
  id: string;
  label: string;
  trunk: {
    radius: number;
    height: number;
    segments: number;
    color: [number, number, number, number];
  };
  foliage: {
    kind: 'sphere' | 'cone';
    radius: number;
    height?: number; // cone only
    segments: number;
    rings?: number; // sphere only
    liftY: number;
    color: [number, number, number, number];
  };
}): SubgraphDef {
  const g = createGraph();
  const COL = 280;
  const ROW = 180;

  // Boundary nodes: input on the left, output on the right. Names match the
  // declared subgraph inputs/outputs below.
  const inputNode = addNode(g, `subgraph-input/${opts.id}`, {
    position: { x: 0, y: ROW * 1.5 },
  });
  const outputNode = addNode(g, `subgraph-output/${opts.id}`, {
    position: { x: COL * 6, y: ROW * 1.5 },
  });

  // Trunk chain.
  const trunkGeo = addNode(g, 'core/cylinder', {
    position: { x: COL, y: 0 },
    inputValues: {
      radius: opts.trunk.radius,
      height: opts.trunk.height,
      segments: opts.trunk.segments,
    },
  });
  const trunkColor = addNode(g, 'core/solid-color', {
    position: { x: COL * 2, y: 0 },
    inputValues: { color: opts.trunk.color, resolution: 16 },
  });
  const trunkMat = addNode(g, 'core/material', {
    position: { x: COL * 3, y: 0 },
    inputValues: { roughness: 0.95, metallic: 0 },
  });
  const trunkEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 4, y: 0 },
  });

  // Foliage chain.
  const foliageGeo = opts.foliage.kind === 'sphere'
    ? addNode(g, 'core/sphere', {
        position: { x: COL, y: ROW * 2 },
        inputValues: {
          radius: opts.foliage.radius,
          segments: opts.foliage.segments,
          rings: opts.foliage.rings ?? 12,
        },
      })
    : addNode(g, 'core/cone', {
        position: { x: COL, y: ROW * 2 },
        inputValues: {
          radius: opts.foliage.radius,
          height: opts.foliage.height ?? 1.6,
          segments: opts.foliage.segments,
        },
      });
  const foliageLift = addNode(g, 'core/transform', {
    position: { x: COL * 2, y: ROW * 2 },
    inputValues: {
      translate: [0, opts.foliage.liftY, 0],
      rotate: [0, 0, 0],
      scale: [1, 1, 1],
    },
  });
  const foliageColor = addNode(g, 'core/solid-color', {
    position: { x: COL * 2, y: ROW * 3 },
    inputValues: { color: opts.foliage.color, resolution: 16 },
  });
  const foliageMat = addNode(g, 'core/material', {
    position: { x: COL * 3, y: ROW * 3 },
    inputValues: { roughness: 0.9, metallic: 0 },
  });
  const foliageEntity = addNode(g, 'core/scene-entity', {
    position: { x: COL * 4, y: ROW * 2 },
  });

  // Merge into a 2-entity tree scene.
  const treeMerge = addNode(g, 'core/scene-merge', {
    position: { x: COL * 5, y: ROW },
  });

  // Standalone preview chain: tree-merge → core/output, bypassing the scatter.
  // When the subgraph is viewed by itself in the editor, this is the eval
  // root and the preview pane shows one tree at origin (the unscattered
  // trunk + foliage). When a parent uses this subgraph, the parent's
  // evaluator only follows the boundary-output path, so this core/output
  // is dead code from the parent's perspective — it evaluates but its
  // outputs are ignored.
  const previewOutput = addNode(g, 'core/output', {
    position: { x: COL * 6, y: ROW * 0.3 },
  });

  // Scatter on the input boundary's points (parent-facing path).
  const scatter = addNode(g, 'core/instance-scene-on-points', {
    position: { x: COL * 5, y: ROW * 2.5 },
    inputValues: { scale: 1, align: false, seed: 1 },
  });

  // Edges — trunk chain.
  addEdge(g, { node: trunkGeo.id, socket: 'geometry' }, { node: trunkEntity.id, socket: 'geometry' });
  addEdge(g, { node: trunkColor.id, socket: 'texture' }, { node: trunkMat.id, socket: 'basecolor' });
  addEdge(g, { node: trunkMat.id, socket: 'material' }, { node: trunkEntity.id, socket: 'material' });

  // Foliage chain.
  addEdge(g, { node: foliageGeo.id, socket: 'geometry' }, { node: foliageLift.id, socket: 'geometry' });
  addEdge(g, { node: foliageLift.id, socket: 'geometry' }, { node: foliageEntity.id, socket: 'geometry' });
  addEdge(g, { node: foliageColor.id, socket: 'texture' }, { node: foliageMat.id, socket: 'basecolor' });
  addEdge(g, { node: foliageMat.id, socket: 'material' }, { node: foliageEntity.id, socket: 'material' });

  // Tree merge.
  addEdge(g, { node: trunkEntity.id, socket: 'scene' }, { node: treeMerge.id, socket: 'a' });
  addEdge(g, { node: foliageEntity.id, socket: 'scene' }, { node: treeMerge.id, socket: 'b' });

  // Boundary input → scatter inputs (points + active mask + tint).
  addEdge(g, { node: inputNode.id, socket: 'points' }, { node: scatter.id, socket: 'points' });
  addEdge(g, { node: treeMerge.id, socket: 'scene' }, { node: scatter.id, socket: 'instance' });
  addEdge(g, { node: inputNode.id, socket: 'active' }, { node: scatter.id, socket: 'per_point_active' });
  addEdge(g, { node: inputNode.id, socket: 'tint' }, { node: scatter.id, socket: 'per_point_tint' });

  // Scatter → boundary output (parent-facing).
  addEdge(g, { node: scatter.id, socket: 'scene' }, { node: outputNode.id, socket: 'scene' });

  // Standalone preview: tree-merge → core/output, parallel to the scatter
  // chain above.
  addEdge(g, { node: treeMerge.id, socket: 'scene' }, { node: previewOutput.id, socket: 'scene' });

  return {
    id: opts.id,
    label: opts.label,
    category: 'Subgraphs',
    inputs: [
      { name: 'points', type: 'PointCloud' },
      { name: 'active', type: 'FloatCloud', optional: true, description: 'per-point active mask; only points with value >= 0.5 are realized' },
      { name: 'tint', type: 'Vec3Cloud', optional: true, description: 'per-point RGB tint multiplier' },
    ],
    outputs: [{ name: 'scene', type: 'Scene' }],
    graph: g,
    inputNodeId: inputNode.id,
    outputNodeId: outputNode.id,
  };
}

export function buildOakSubgraph(): SubgraphDef {
  return buildTreeSubgraph({
    id: 'oak-tree',
    label: 'Oak Tree',
    trunk: {
      radius: 0.08,
      height: 0.9,
      segments: 10,
      color: [0.32, 0.2, 0.1, 1],
    },
    foliage: {
      kind: 'sphere',
      radius: 0.4,
      segments: 16,
      rings: 12,
      liftY: 1.05,
      color: [0.22, 0.5, 0.16, 1],
    },
  });
}

export function buildPineSubgraph(): SubgraphDef {
  return buildTreeSubgraph({
    id: 'pine-tree',
    label: 'Pine Tree',
    trunk: {
      radius: 0.07,
      height: 0.55,
      segments: 10,
      color: [0.28, 0.18, 0.09, 1],
    },
    foliage: {
      kind: 'cone',
      radius: 0.5,
      height: 1.6,
      segments: 14,
      liftY: 0.3,
      color: [0.1, 0.32, 0.18, 1],
    },
  });
}
