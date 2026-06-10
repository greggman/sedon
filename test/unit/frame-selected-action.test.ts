// `frameSelectedInActiveCanvas` is the View → Frame Selected menu
// action. It routes by active panel kind:
//
//   • Preview active → calls the registered preview's frameSelected.
//   • Canvas active  → calls rf.fitView on selected (or all) nodes.
//
// Regression context: when nothing was selected, the canvas branch
// USED to fit-all but a refactor broke the fallback — and there was
// no test, so it went unnoticed. The user caught it by inspection.
//
// These tests stand in fake `rf` / preview handlers, register them
// through the public registry APIs, and assert which one ran with
// what arguments.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frameSelectedInActiveCanvas } from '../../src/editor/commands.js';
import {
  registerCanvasRf,
  unregisterCanvasRf,
} from '../../src/editor/rf-registry.js';
import {
  registerPreview,
  unregisterPreview,
} from '../../src/editor/preview-registry.js';
import type { ReactFlowInstance } from '@xyflow/react';

interface FakeRfRecord {
  fitViewCalls: { padding?: number; nodes?: { id: string }[] | undefined; duration?: number }[];
  nodes: { id: string; selected?: boolean }[];
}

function makeFakeRf(nodes: { id: string; selected?: boolean }[]): {
  rf: ReactFlowInstance;
  record: FakeRfRecord;
} {
  const record: FakeRfRecord = { fitViewCalls: [], nodes };
  const rf = {
    getNodes: () => record.nodes,
    fitView: (opts: { padding?: number; nodes?: { id: string }[]; duration?: number }) => {
      record.fitViewCalls.push({
        ...(opts.padding !== undefined ? { padding: opts.padding } : {}),
        ...(opts.nodes !== undefined ? { nodes: opts.nodes } : {}),
        ...(opts.duration !== undefined ? { duration: opts.duration } : {}),
      });
      return true;
    },
  } as unknown as ReactFlowInstance;
  return { rf, record };
}

// Each test cleans up after itself so registrations don't leak.
// Module-level singletons would otherwise interact across cases.
function withCanvas(
  nodes: { id: string; selected?: boolean }[],
  fn: (record: FakeRfRecord) => void,
): void {
  const { rf, record } = makeFakeRf(nodes);
  registerCanvasRf('canvas-test', rf);
  try {
    fn(record);
  } finally {
    unregisterCanvasRf('canvas-test');
  }
}

test('canvas active, some nodes selected → fitView targets ONLY the selected nodes', () => {
  withCanvas(
    [
      { id: 'a', selected: false },
      { id: 'b', selected: true },
      { id: 'c', selected: false },
      { id: 'd', selected: true },
    ],
    (record) => {
      frameSelectedInActiveCanvas();
      assert.equal(record.fitViewCalls.length, 1);
      const call = record.fitViewCalls[0]!;
      assert.deepEqual(call.nodes, [{ id: 'b' }, { id: 'd' }]);
    },
  );
});

test('canvas active, NOTHING selected → fitView called WITHOUT a `nodes` list', () => {
  // Regression: when target was all-nodes and we passed them as the
  // `nodes:` option, ReactFlow's nodes-list path no-ops if none of the
  // listed ids are selected — so passing "everything" via the list
  // never framed anything. The fix is to omit `nodes` entirely when
  // nothing is selected, which hits ReactFlow's all-nodes path.
  withCanvas(
    [
      { id: 'a', selected: false },
      { id: 'b', selected: false },
      { id: 'c' /* selected omitted entirely */ },
    ],
    (record) => {
      frameSelectedInActiveCanvas();
      assert.equal(record.fitViewCalls.length, 1, 'expected one fitView call');
      const call = record.fitViewCalls[0]!;
      assert.equal(call.nodes, undefined, '`nodes` option must be omitted for all-nodes fit');
      assert.equal(call.padding, 0.2, 'padding should still be passed');
    },
  );
});

test('canvas active, NO nodes at all → does nothing (no fitView call)', () => {
  withCanvas([], (record) => {
    frameSelectedInActiveCanvas();
    assert.equal(record.fitViewCalls.length, 0, 'empty canvas should not call fitView');
  });
});

test('preview registered, no canvas → routes to the preview handler', () => {
  // No canvas registered. With the test environment having no
  // DockView, the preview-registry falls back to lastTouched, so a
  // registered preview is picked up.
  let frameSelectedCalls = 0;
  registerPreview('preview-test', {
    frameSelected: () => { frameSelectedCalls++; },
  });
  try {
    frameSelectedInActiveCanvas();
    assert.equal(frameSelectedCalls, 1, 'preview frameSelected should fire as the canvas fallback');
  } finally {
    unregisterPreview('preview-test');
  }
});

test('both canvas and preview registered, no active dockview panel → prefers canvas', () => {
  // With no dockview panel active (test env), the function consults
  // `getActiveCanvasRf` first; if a canvas is registered it wins
  // over the preview. The preview-active branch (`activePanelIsPreview`)
  // only fires when dockview reports a preview as active.
  let previewCalls = 0;
  registerPreview('preview-test', {
    frameSelected: () => { previewCalls++; },
  });
  withCanvas([{ id: 'a' }], (record) => {
    frameSelectedInActiveCanvas();
    assert.equal(record.fitViewCalls.length, 1, 'canvas branch should win when both registered');
    assert.equal(previewCalls, 0, 'preview handler should NOT fire when canvas is available');
  });
  unregisterPreview('preview-test');
});
