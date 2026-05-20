// Regression: a sweep scheduled while activeEvals=0 must NOT run if
// `activeEvals` is non-zero when its rAF callback finally fires.
//
// User trace: switching from Tree-Bush → Forest produced
//   "Destroyed texture [Texture (unlabeled 512x512 px, ...)] used in
//    a submit."
//
// Sequence:
//   1. User clicks Forest. React commit unmounts tree-bush asset
//      thumbnails.
//   2. Each unmount calls unregisterConsumer → doSweep. activeEvals=0
//      → scheduleSweep posts a rAF.
//   3. Post-commit, the new canvas/preview/asset effects fire. Each
//      calls beginCacheEval → activeEvals > 0. Forest's main eval
//      starts. It allocates fresh GPU textures and stores their
//      cache entries.
//   4. Forest's eval hits a real async boundary (heightfield-to-mesh's
//      mapAsync). The microtask chain releases the task.
//   5. The rAF from step 2 fires now. Without this fix, sweep runs:
//      freshly-allocated forest entries aren't in any consumer's
//      `primary` yet (reportWorking only fires at the END of the
//      eval), so the live-set excludes them → just-allocated textures
//      get DESTROYED.
//   6. Forest's eval resumes. Downstream nodes read the now-destroyed
//      textures from the local `outputs` map and build bind groups
//      → next submit fails.
//
// Fix: `doSweepNow` re-checks `activeEvals` at firing time. If
// non-zero, it marks `pendingSweep` and bails; `endCacheEval` will
// flush once everyone's done.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  beginCacheEval,
  endCacheEval,
  reportConsumerWorkingSet,
  unregisterConsumer,
} from '../../src/editor/cache-coordinator.js';
import { useEditorStore } from '../../src/editor/store.js';

// Node doesn't ship a global `requestAnimationFrame` by default; the
// cache-coordinator's `scheduleSweep` calls it directly. Install a
// thin polyfill that exposes when the rAF actually fires so the test
// can drive it deterministically.
type RafCb = (t: number) => void;
const rafQueue: RafCb[] = [];
(globalThis as { requestAnimationFrame: (cb: RafCb) => number }).requestAnimationFrame = (cb) => {
  rafQueue.push(cb);
  return rafQueue.length;
};

function flushOneRaf(): void {
  const cb = rafQueue.shift();
  if (cb) cb(performance.now());
}

interface FakeResource {
  id: string;
  destroyed: boolean;
  destroy(): void;
}

function makeResource(id: string): FakeResource {
  const r: FakeResource = {
    id,
    destroyed: false,
    destroy() { r.destroyed = true; },
  };
  return r;
}

function seedCacheEntry(fp: string, resourceId: string): FakeResource {
  const r = makeResource(resourceId);
  // walkGpuResources matches Texture2DValue by its `{texture, format,
  // width, height}` shape — wrap in that envelope so sweepCache
  // actually finds and (potentially) destroys our fake resource. The
  // outer record is the node's outputs map; the inner Texture2DValue
  // holds the destroyable handle. Stripping the envelope makes the
  // sweep walk past without ever visiting r.destroy.
  useEditorStore.getState().evalCache.entries.set(fp, {
    out: { texture: r, format: 'rgba8unorm', width: 1, height: 1 },
  });
  return r;
}

// Each test uses unique consumer ids so leftover state from previous
// tests in the same file (cache-coordinator's `consumers` map is
// module-scope, not reset between tests) doesn't pollute liveness.
let consumerSeq = 0;
function freshConsumerId(): string {
  return `race-test-consumer-${++consumerSeq}`;
}

function drainRafs(): void {
  while (rafQueue.length > 0) flushOneRaf();
}

test('doSweepNow that fires while an eval is in flight defers; the in-flight texture is NOT destroyed', () => {
  useEditorStore.getState().evalCache.entries.clear();
  rafQueue.length = 0;

  // Pre-existing consumer holds an old entry. Without ANY consumer,
  // every entry is unreferenced and gets swept on the first rAF —
  // the test would pass trivially without exercising the activeEvals
  // guard.
  const oldFp = 'fp-old';
  const oldRes = seedCacheEntry(oldFp, 'old-resource');
  const survivor = freshConsumerId();
  reportConsumerWorkingSet(survivor, new Set([oldFp]));
  drainRafs(); // drain whatever the initial report scheduled
  assert.equal(oldRes.destroyed, false, 'baseline: old resource alive (in survivor primary)');

  // Step 1: an unrelated consumer unmounts. doSweep posts a rAF
  // (activeEvals === 0 at this moment).
  const transient = freshConsumerId();
  reportConsumerWorkingSet(transient, new Set([oldFp]));
  drainRafs();
  unregisterConsumer(transient);
  assert.equal(rafQueue.length, 1, 'unregisterConsumer scheduled exactly one sweep rAF');

  // Step 2: a NEW consumer's eval begins BEFORE that rAF fires.
  beginCacheEval();

  // Step 3: the in-flight eval allocates a fresh resource and stores
  // its entry. reportWorking has NOT been called yet.
  const inflightFp = 'fp-new';
  const inflightRes = seedCacheEntry(inflightFp, 'new-resource');

  // Step 4: the deferred rAF fires NOW. Without the fix it would
  // destroy `inflightRes` (not in any primary) — the regression.
  flushOneRaf();
  assert.equal(
    inflightRes.destroyed,
    false,
    'in-flight resource must NOT be destroyed by a sweep that fires while activeEvals > 0',
  );

  // Step 5: the eval finishes, reports, and ends.
  const newConsumer = freshConsumerId();
  reportConsumerWorkingSet(newConsumer, new Set([inflightFp]));
  endCacheEval();
  drainRafs(); // endCacheEval flushed the deferred sweep
  assert.equal(inflightRes.destroyed, false, 'after reportWorking the in-flight resource stays alive');
  assert.equal(oldRes.destroyed, false, 'old resource still alive (referenced by survivor)');

  // Clean up the consumer slots this test created — module-scope
  // state would otherwise leak into the next test in this file.
  unregisterConsumer(survivor);
  unregisterConsumer(newConsumer);
  drainRafs();
});

test('a sweep that fires with activeEvals=0 still runs (no regression in the normal path)', () => {
  useEditorStore.getState().evalCache.entries.clear();
  rafQueue.length = 0;

  // Seed a single entry that no consumer references.
  const orphan = seedCacheEntry('fp-orphan', 'orphan');

  // Register a consumer that holds a DIFFERENT fp, then drop it —
  // that triggers a doSweep. The orphan is not in any primary, so
  // the sweep should evict + destroy it.
  const c = freshConsumerId();
  reportConsumerWorkingSet(c, new Set(['fp-some-other']));
  drainRafs();
  unregisterConsumer(c);
  drainRafs();

  assert.equal(
    orphan.destroyed,
    true,
    'orphan entry (no consumer references it) is destroyed on a normal sweep',
  );
});
