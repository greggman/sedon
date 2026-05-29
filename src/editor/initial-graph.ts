import { addEdge, addNode, createGraph, type Graph } from '../core/graph.js';
import type { SubgraphDef } from '../core/subgraph.js';
import { DEMOS } from './demos/index.js';
import type { CameraState } from './store.js';

// Default scene when no URL override is present. Pick a meaningful
// demo so first-time visitors see something interesting rather than a
// trivial sphere.
const DEFAULT_SCENE_ID = 'forest';

// "Basic" starter graph (the original initial scene): grid texture +
// sphere → material → scene-entity → output. Still available via the
// Demos menu and `?scene=basic`; just no longer the default landing
// scene.
export function createBasicScene(): { graph: Graph; rootNodeId: string } {
  const g = createGraph();

  const grid = addNode(g, 'core/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: [0.05, 0.05, 0.1, 1],
      bg: [0.95, 0.85, 0.4, 1],
      divisions: [12, 12],
      line_width: 0.06,
    },
  });
  const material = addNode(g, 'core/material', {
    position: { x: 280, y: 0 },
  });
  const sphere = addNode(g, 'core/sphere', {
    position: { x: 0, y: 280 },
    inputValues: { radius: 1, segments: 64, rings: 32 },
  });
  const sceneEntity = addNode(g, 'core/scene-entity', {
    position: { x: 560, y: 140 },
  });
  const output = addNode(g, 'core/output', {
    position: { x: 800, y: 140 },
  });

  addEdge(g, { node: grid.id, socket: 'texture' }, { node: material.id, socket: 'basecolor' });
  addEdge(g, { node: sphere.id, socket: 'geometry' }, { node: sceneEntity.id, socket: 'geometry' });
  addEdge(g, { node: material.id, socket: 'material' }, { node: sceneEntity.id, socket: 'material' });
  addEdge(g, { node: sceneEntity.id, socket: 'scene' }, { node: output.id, socket: 'scene' });

  return { graph: g, rootNodeId: output.id };
}

// Picks which demo to seed the store with. Reads `?scene=<id>` from
// the URL synchronously (so the store has the right initial state by
// the time React mounts and no placeholder flashes), falls back to
// the default. The `?json=<…>` URL-load path bypasses this entirely:
// main.tsx checks for that param BEFORE rendering and overrides via
// `setGraph` once async decompression completes.
//
// Returning the broader demo shape `{ graph, rootNodeId, subgraphs?,
// cameras? }` means store init goes through `projectStateSlice` and
// picks up subgraphs/cameras automatically — same path as runtime
// demo loads via the Demos menu.
export function createInitialGraph(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs?: SubgraphDef[];
  cameras?: Record<string, CameraState>;
} {
  let requested: string | null = null;
  if (typeof window !== 'undefined') {
    requested = new URLSearchParams(window.location.search).get('scene');
  }
  const id = requested ?? DEFAULT_SCENE_ID;
  const demo = DEMOS.find((d) => d.id === id);
  if (demo) return demo.build();
  // Unknown id → fall back to default. Don't throw: a bad URL
  // shouldn't break the app, just ignore the override.
  const fallback = DEMOS.find((d) => d.id === DEFAULT_SCENE_ID);
  if (fallback) return fallback.build();
  // No default registered either: emergency fallback to basic.
  return createBasicScene();
}
