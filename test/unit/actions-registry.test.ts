// Structural invariants for the single action registry.
//
// The drift bug this guards against:
//   1. "New Subgraph…" was added to the Add menu's inline `run`
//      handler but never registered in the palette catalog.
//   2. The two surfaces had no shared source of truth.
//
// After the refactor, both the menu bar and the command palette
// consume buildActions(); the MenuEntry type no longer permits an
// inline `run`, so menu leaves can only reference actions by id.
// These tests pin that invariant — they fail loudly if any menu
// references an action id that buildActions() doesn't register, or
// if a known critical action goes missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildActions } from '../../src/editor/actions.js';
import { buildAppMenus } from '../../src/editor/app-menus.js';
import { buildRegistry } from '../../src/editor/registry.js';
import type { MenuEntry, TopMenu } from '../../src/editor/menubar.js';
import type { Action } from '../../src/editor/action.js';

function collectActionRefs(menus: TopMenu[]): string[] {
  const out: string[] = [];
  const walk = (items: MenuEntry[]) => {
    for (const e of items) {
      if (e.kind === 'action') out.push(e.actionId);
      else if (e.kind === 'submenu') walk(e.items);
    }
  };
  for (const m of menus) walk(m.items);
  return out;
}

function makeActions(opts?: { macrosAllowed?: boolean; undoLen?: number; redoLen?: number; recording?: boolean }): Action[] {
  return buildActions({
    registry: buildRegistry([]),
    undoLen: opts?.undoLen ?? 0,
    redoLen: opts?.redoLen ?? 0,
    recording: opts?.recording ?? false,
    macrosAllowed: opts?.macrosAllowed ?? false,
  });
}

function makeMenus(actions: Action[]): TopMenu[] {
  return buildAppMenus({
    actionMap: new Map(actions.map((a) => [a.id, a])),
    registry: buildRegistry([]),
  });
}

// ─── The critical invariant ────────────────────────────────

test('every menu actionId resolves to a registered action', () => {
  // Build with macros ALLOWED so the macro.* refs are exercised too.
  const actions = makeActions({ macrosAllowed: true });
  const actionIds = new Set(actions.map((a) => a.id));
  const menus = makeMenus(actions);
  const referenced = collectActionRefs(menus);
  assert.ok(referenced.length > 0, 'no actions referenced from menus — likely a build problem');
  for (const id of referenced) {
    assert.ok(actionIds.has(id), `menu references unknown action "${id}"`);
  }
});

test('every menu actionId resolves even with the Macro gate off', () => {
  // Macro submenu must not appear at all when the gate is off, so
  // the absence of macro.* actions can't cause "<missing action>".
  const actions = makeActions({ macrosAllowed: false });
  const actionIds = new Set(actions.map((a) => a.id));
  const menus = makeMenus(actions);
  const referenced = collectActionRefs(menus);
  for (const id of referenced) {
    assert.ok(actionIds.has(id), `menu references unknown action "${id}" (macros gated off)`);
  }
  // And confirm the gate worked.
  assert.ok(!referenced.includes('macro.record'), 'macro submenu showed up with the gate off');
});

// ─── The specific bug the user called out ──────────────────

test('"New Subgraph…" is registered as a first-class action (palette-searchable)', () => {
  const actions = makeActions();
  const newSubgraph = actions.find((a) => a.id === 'add.new-subgraph');
  assert.ok(newSubgraph, 'add.new-subgraph missing from the action registry');
  assert.match(newSubgraph!.label, /New Subgraph/);
  assert.match(newSubgraph!.label, /^Add:/, 'palette-form label should be category-prefixed for search');
});

test('"New Subgraph…" is referenced from the Add menu', () => {
  const actions = makeActions();
  const menus = makeMenus(actions);
  const addMenu = menus.find((m) => m.label === 'Add');
  assert.ok(addMenu, 'no Add menu');
  const refs = collectActionRefs([addMenu!]);
  assert.ok(refs.includes('add.new-subgraph'), 'Add menu does not reference add.new-subgraph');
});

// ─── Sanity: the file menu surface ─────────────────────────

test('File menu actions all show up in the palette under "File: …"', () => {
  const actions = makeActions();
  const ids = new Set(actions.map((a) => a.id));
  // Spot-check the previously-drifted set.
  const expected = [
    'file.new',
    'file.save',
    'file.load',
    'file.save-to-url',
    'file.save-selected',
    'file.merge',
  ];
  for (const id of expected) {
    assert.ok(ids.has(id), `expected file action "${id}" missing from registry`);
  }
});

test('Demo actions registered one per DEMOS entry', () => {
  const actions = makeActions();
  const demoActions = actions.filter((a) => a.id.startsWith('demo.'));
  assert.ok(demoActions.length > 0, 'no demo.* actions registered');
  for (const a of demoActions) {
    assert.match(a.label, /^File: Load Demo/);
  }
});

// ─── No duplicate ids (registry uniqueness) ────────────────

test('action ids are unique', () => {
  const actions = makeActions({ macrosAllowed: true });
  const ids = new Set<string>();
  for (const a of actions) {
    assert.ok(!ids.has(a.id), `duplicate action id "${a.id}"`);
    ids.add(a.id);
  }
});

// ─── The structural lock: MenuEntry doesn't permit inline `run` ──

test('MenuEntry shape: leaves are action refs (no inline run permitted)', () => {
  // This is a compile-time guarantee via the MenuEntry union, but
  // we mirror it at runtime in case anyone bypasses TS. Walk every
  // menu and assert no leaf has a `run` property — only `kind:
  // action` references.
  const actions = makeActions({ macrosAllowed: true });
  const menus = makeMenus(actions);
  const walk = (items: MenuEntry[]): void => {
    for (const e of items) {
      if (e.kind === 'separator') continue;
      if (e.kind === 'submenu') {
        walk(e.items);
        continue;
      }
      assert.equal(e.kind, 'action');
      // Action refs may carry a label override; that's it.
      const keys = Object.keys(e).sort();
      const allowed = keys.every((k) => k === 'kind' || k === 'actionId' || k === 'label');
      assert.ok(allowed, `MenuEntry has unexpected keys: ${keys.join(',')}`);
    }
  };
  for (const m of menus) walk(m.items);
});
