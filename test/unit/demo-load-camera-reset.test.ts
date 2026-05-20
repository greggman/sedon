// Regression: loading a new project must reset per-panel saved
// cameras so the new project's per-graph framings apply.
//
// User symptom: "the forest graph no longer works". Trace: user
// drags the Preview camera in Tree-Bush, the gesture commits to
// `useLayoutStore.previewCameras[panelId]['main']`. They then click
// Demos → Forest. Forest's `cameras['main']` (distance=95, target=
// [0,8,0]) is in the editor store's projectCameras, but Preview's
// camera-load effect resolves the fallback chain
//
//   panelCameras?.[id] ?? recentPreviewCameras[id] ?? projectCameras[id]
//
// and the panelCameras entry from Tree-Bush wins. The Preview is
// rendered with the old drag — for Forest's 100m terrain, that puts
// the camera INSIDE the ground, looking at sky. Nothing renders.
//
// Fix: `setGraph` itself resets `useLayoutStore` for the new project.
// The reset isn't a separate step that callers have to remember;
// it's part of the project-load contract baked into setGraph. The
// public `resetForNewProject` action stays for file-ops, which
// resets-then-restores in one swap.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraph } from '../../src/core/graph.js';
import { useLayoutStore } from '../../src/editor/layout-store.js';
import { useEditorStore, type CameraState } from '../../src/editor/store.js';

function freshLayoutStore(): void {
  useLayoutStore.setState({
    pinnedGraphIds: {},
    canvasGraphIds: {},
    canvasViewports: {},
    recentCanvasViewports: {},
    previewCameras: {},
    recentPreviewCameras: {},
    lastActiveCanvasPanelId: null,
    lastActivePreviewPanelId: null,
  });
}

test('resetForNewProject clears every per-graph session slice', () => {
  freshLayoutStore();
  const layout = useLayoutStore.getState();

  layout.setPanelPinnedGraph('preview-1', 'old-graph');
  layout.setCanvasGraphId('canvas-1', 'old-graph');
  layout.saveCanvasViewport('canvas-1', 'old-graph', { x: 10, y: 20, zoom: 1.5 });
  layout.savePreviewCamera('preview-1', 'old-graph', {
    yaw: 1, pitch: 1, distance: 50, target: [0, 0, 0],
  });

  const before = useLayoutStore.getState();
  assert.ok(Object.keys(before.pinnedGraphIds).length > 0);
  assert.ok(Object.keys(before.canvasGraphIds).length > 0);
  assert.ok(Object.keys(before.canvasViewports).length > 0);
  assert.ok(Object.keys(before.recentCanvasViewports).length > 0);
  assert.ok(Object.keys(before.previewCameras).length > 0);
  assert.ok(Object.keys(before.recentPreviewCameras).length > 0);

  useLayoutStore.getState().resetForNewProject();
  const after = useLayoutStore.getState();

  assert.deepEqual(after.pinnedGraphIds, {}, 'pinnedGraphIds cleared');
  assert.deepEqual(after.canvasGraphIds, {}, 'canvasGraphIds cleared');
  assert.deepEqual(after.canvasViewports, {}, 'canvasViewports cleared');
  assert.deepEqual(after.recentCanvasViewports, {}, 'recentCanvasViewports cleared');
  assert.deepEqual(after.previewCameras, {}, 'previewCameras cleared');
  assert.deepEqual(after.recentPreviewCameras, {}, 'recentPreviewCameras cleared');
});

// Mirror the Preview component's fallback chain (preview.tsx):
//   panelCameras?.[id] ?? recentPreviewCameras[id] ?? projectCameras[id]
// Kept here so a refactor that changes the order (or drops a tier)
// would need to update this test too — the ordering is the contract.
function resolvePreviewCamera(panelId: string, graphId: string): CameraState | undefined {
  const layout = useLayoutStore.getState();
  const editor = useEditorStore.getState();
  return (
    layout.previewCameras[panelId]?.[graphId] ??
    layout.recentPreviewCameras[graphId] ??
    editor.cameras[graphId]
  );
}

test('panel-saved cameras outrank projectCameras in the resolution chain', () => {
  // Locks in the half of the contract that motivates the reset at
  // all: without per-panel state outranking project cameras, demos
  // wouldn't pick up the user's intentional gesture either. Future
  // refactors that try to "simplify" by inverting the chain (project
  // wins always) would break gesture persistence — fail this test
  // and force a deliberate redesign of the camera-load story.
  freshLayoutStore();
  useEditorStore.setState({ cameras: { main: { yaw: 0, pitch: 0, distance: 3, target: [0, 0, 0] } } });

  const dragged: CameraState = { yaw: 9, pitch: 9, distance: 9, target: [9, 9, 9] };
  useLayoutStore.getState().savePreviewCamera('preview-1', 'main', dragged);

  assert.deepEqual(
    resolvePreviewCamera('preview-1', 'main'),
    dragged,
    'panelCameras must beat projectCameras when both exist for the same graph id',
  );
});

test('setGraph (project load) resets the layout store automatically — caller cannot forget', () => {
  // The whole point of folding resetForNewProject INTO setGraph:
  // any caller that loads a new project gets the reset for free.
  // This test exercises the call path verbatim — no explicit reset,
  // just setGraph — and verifies the resolved Preview camera ends
  // up as the new project's per-graph framing, not the saved drag.
  freshLayoutStore();

  // === Project A: load + user drags the camera in the Preview pane.
  useEditorStore.getState().setGraph(
    createGraph(),
    'root-a',
    [],
    { main: { yaw: 0, pitch: 0.4, distance: 3, target: [0, 0, 0] } },
  );
  useLayoutStore.getState().savePreviewCamera('preview-1', 'main', {
    yaw: 1.2, pitch: 0.6, distance: 8, target: [3, 0, 0],
  });
  // Sanity: the dragged camera DOES win over Project A's framing.
  assert.equal(
    resolvePreviewCamera('preview-1', 'main')?.distance,
    8,
    'user drag persists within a single project (panelCameras wins)',
  );

  // === Project B: load Forest-scale framing. NO explicit
  // resetForNewProject — setGraph must do it on its own.
  const projectBMain: CameraState = { yaw: 0.4, pitch: 0.45, distance: 95, target: [0, 8, 0] };
  useEditorStore.getState().setGraph(
    createGraph(),
    'root-b',
    [],
    { main: projectBMain },
  );

  assert.deepEqual(
    resolvePreviewCamera('preview-1', 'main'),
    projectBMain,
    'project load must clear panelCameras automatically — without this, the Preview pane keeps the drag from the OLD project and the user sees "sky inside the terrain"',
  );
});
