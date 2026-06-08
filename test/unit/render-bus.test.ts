// render-bus is the editor's coalescing render scheduler. It's shared
// state (module-level), so all tests in this file run against the same
// bus instance — each test captures the bus's current force-serial up
// front and asserts deltas, rather than absolute values.
//
// The bus uses `requestAnimationFrame` (a browser global). Node doesn't
// have it; we install a controllable polyfill at module load time so the
// tests can drive ticks deterministically.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// rAF polyfill: store the pending callback in a holder we can fire on
// demand. Installed BEFORE importing render-bus so the bus binds to
// this version.
type RafCallback = (nowMs: number) => void;
const rafQueue: RafCallback[] = [];
let rafIdCounter = 0;
(globalThis as unknown as { requestAnimationFrame: (cb: RafCallback) => number })
  .requestAnimationFrame = (cb: RafCallback) => {
    rafQueue.push(cb);
    return ++rafIdCounter;
  };
function fireRaf(): void {
  const queued = rafQueue.splice(0, rafQueue.length);
  let now = 0;
  for (const cb of queued) cb(now++);
}

// render-bus imports `flushUnusedPools` from src/render/scene.js, which
// transitively drags in the WebGPU renderer. The renderer module's
// top-level code runs (declares pipelines, layouts) but doesn't touch
// `navigator.gpu` until something asks for a device — these tests don't,
// so the import should be inert. If a future change makes the import
// touch the GPU, mock the scene module here.
const bus = await import('../../src/editor/render-bus.js');

test('requestRender coalesces multiple calls in the same frame', () => {
  let fired = 0;
  const unsub = bus.subscribeRender(() => { fired++; });
  bus.requestRender();
  bus.requestRender();
  bus.requestRender();
  assert.equal(fired, 0, 'callback does not fire before the rAF runs');
  fireRaf();
  assert.equal(fired, 1, 'three requestRender calls in one frame fire the callback once');
  unsub();
});

test('subscribeRender returns a working unsubscribe', () => {
  let fired = 0;
  const unsub = bus.subscribeRender(() => { fired++; });
  bus.requestRender();
  fireRaf();
  assert.equal(fired, 1);
  unsub();
  bus.requestRender();
  fireRaf();
  assert.equal(fired, 1, 'no further fires after unsubscribe');
});

test('plain requestRender() does NOT bump the force-serial', () => {
  const before = bus.currentForceSerial();
  bus.requestRender();
  bus.requestRender();
  fireRaf();
  bus.requestRender();
  fireRaf();
  assert.equal(
    bus.currentForceSerial(),
    before,
    'unforced pokes (camera, resize, animation tick) must leave force-serial alone — '
    + 'otherwise per-tile dirty checks degrade to redraw-on-every-tick',
  );
});

test('requestRender({ force: true }) bumps the force-serial', () => {
  const before = bus.currentForceSerial();
  bus.requestRender({ force: true });
  assert.equal(
    bus.currentForceSerial(),
    before + 1,
    'force: true bumps the serial immediately (not on rAF) so a synchronous '
    + 'force + dirty-check sequence sees the new value',
  );
  bus.requestRender({ force: true });
  assert.equal(bus.currentForceSerial(), before + 2);
  fireRaf();
});

test('force-serial increments are independent of coalescing', () => {
  // Two forced calls coalesce into ONE rAF fire, but BOTH bumps land —
  // the force-serial is not "one per frame", it's "one per requestRender
  // call with force:true". Otherwise a node-canvas eval-finish and a
  // preview-pane eval-commit in the same frame would lose one of the
  // bumps and a tile that drew between them would skip the second.
  const before = bus.currentForceSerial();
  let fired = 0;
  const unsub = bus.subscribeRender(() => { fired++; });
  bus.requestRender({ force: true });
  bus.requestRender({ force: true });
  assert.equal(bus.currentForceSerial(), before + 2);
  fireRaf();
  assert.equal(fired, 1, 'two requestRender calls still coalesce into one rAF');
  unsub();
});

test('subscriber gets called with a monotonically-increasing frameSerial', () => {
  const serials: number[] = [];
  const unsub = bus.subscribeRender((fs) => { serials.push(fs); });
  bus.requestRender();
  fireRaf();
  bus.requestRender();
  fireRaf();
  bus.requestRender();
  fireRaf();
  assert.equal(serials.length, 3);
  assert.ok(serials[1]! > serials[0]!, 'frameSerial increases across frames');
  assert.ok(serials[2]! > serials[1]!);
  unsub();
});
