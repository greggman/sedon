import { addEdge, addNode, createGraph, type Graph } from '../core/graph.js';
import type { SubgraphDef } from '../core/subgraph.js';
import type { CameraState } from './store.js';

// Default scene loaded async after first paint when no URL override
// is present. The synchronous boot path uses `createBasicScene` so
// the store has SOMETHING valid before React mounts — the default
// demo loads on top of that a few ms later via fetch. This is the
// price of moving demo graphs out of the bundle: a one-frame flash
// of the basic sphere on first load. A small regression vs. shipping
// forest's graph data in JS, but ~3MB of bundle traded for ~16ms of
// UX is the right call.
export const DEFAULT_SCENE_ID = 'forest';

// "Basic" starter graph (the original initial scene): grid texture +
// sphere → material → scene-entity → output. Still available via the
// Demos menu and `?scene=basic`; just no longer the default landing
// scene.
export function createBasicScene(): { graph: Graph; rootNodeId: string } {
  const g = createGraph();

  const grid = addNode(g, 'tex/grid', {
    position: { x: 0, y: 0 },
    inputValues: {
      fg: [0.05, 0.05, 0.1, 1],
      bg: [0.95, 0.85, 0.4, 1],
      divisions: [12, 12],
      line_width: 0.06,
    },
  });
  const material = addNode(g, 'material/pbr', {
    position: { x: 280, y: 0 },
  });
  const sphere = addNode(g, 'geom/sphere', {
    position: { x: 0, y: 280 },
    inputValues: { radius: 1, segments: 64, rings: 32 },
  });
  const sceneEntity = addNode(g, 'scene/entity', {
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

// Synchronous initial state for the editor store. ALWAYS returns the
// basic scene now — every other demo has moved out of the bundle and
// into fetched .sedon files, so we can't build them synchronously
// here without re-importing the build-time module (which would pull
// every demo's graph data back into the JS payload).
//
// main.tsx is responsible for the post-mount async load: it reads
// `?scene=<id>` / falls back to DEFAULT_SCENE_ID and calls
// `loadDemoById` once React is rendered. The user sees a single
// frame of the basic sphere before the chosen demo replaces it —
// acceptable for the ~3MB bundle win.
export function createInitialGraph(): {
  graph: Graph;
  rootNodeId: string;
  subgraphs?: SubgraphDef[];
  cameras?: Record<string, CameraState>;
} {
  return createBasicScene();
}

/**
 * Read `?scene=<id>` from the URL, or fall back to DEFAULT_SCENE_ID
 * when no override is present. Returns null when the URL explicitly
 * requests the basic scene (which is already loaded synchronously)
 * or when the `?json=<…>` URL-load path is active (handled by
 * main.tsx before this would be consulted).
 */
export function getPostMountSceneToLoad(): string | null {
  if (typeof window === 'undefined') return null;
  const requested = new URLSearchParams(window.location.search).get('scene');
  const id = requested ?? DEFAULT_SCENE_ID;
  // basic is already loaded synchronously — no async work to do.
  if (id === 'basic') return null;
  return id;
}
