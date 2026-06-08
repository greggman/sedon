import { useMemo } from 'react';
import type { NodeRegistry } from '../core/node-def.js';
import { isSubgraphInstanceKind, isSubgraphInternalKind } from '../core/subgraph.js';
import { useActionMap } from './actions.js';
import { DEMOS } from './demos/index.js';
import type { Action } from './action.js';
import type { MenuEntry, TopMenu } from './menubar.js';
import { useRegistry } from './registry.js';

// Build the application menu tree. Leaves are ACTION REFERENCES — no
// inline `run` handlers. Every callable here is registered once in
// ./actions.ts, which both this menu and the command palette consume.
// That's the structural invariant that keeps the two surfaces in
// sync: adding an entry in actions.ts makes it palette-searchable for
// free, and referencing it from a menu tree below makes it
// menu-clickable. The MenuEntry type no longer permits inline
// handlers, so the drift bug ("New Subgraph…" in the menu but not the
// palette) is impossible by construction.

// Sugar: a leaf that references action `actionId`, optionally
// overriding the displayed label. Plain action refs (no label
// override) use the action's `label` field — usually a category-
// prefixed string like "Edit: Undo". Menu trees override when the
// category is implicit in the menu's parent.
function actionItem(actionId: string, label?: string): MenuEntry {
  return label !== undefined
    ? { kind: 'action', actionId, label }
    : { kind: 'action', actionId };
}

const SEPARATOR: MenuEntry = { kind: 'separator' };

// Live-state inputs to buildAppMenus. Held off React-context so
// tests can build the menu tree without a renderer.
export interface AppMenusInput {
  /** The resolved action set, used to gate the Macro submenu so it
   *  only appears when the gate (?allow-macros=1) actually registered
   *  the macro.* actions. The menu builder doesn't otherwise consume
   *  action contents — leaves carry ids only, resolved at render. */
  actionMap: ReadonlyMap<string, Action>;
  /** Drives the Add menu's category grouping. */
  registry: NodeRegistry;
}

export function buildAppMenus(input: AppMenusInput): TopMenu[] {
  const { actionMap, registry } = input;

  // ── File ─────────────────────────────────────────────
  const demoItems: MenuEntry[] = DEMOS.map((d) => actionItem(`demo.${d.id}`, d.label));
  const fileMenu: TopMenu = {
    label: 'File',
    items: [
      actionItem('file.new', 'New Scene'),
      SEPARATOR,
      actionItem('file.save', 'Save…'),
      actionItem('file.load', 'Load…'),
      actionItem('file.save-to-url', 'Save to URL'),
      SEPARATOR,
      actionItem('file.save-selected', 'Save Selected…'),
      actionItem('file.merge', 'Merge…'),
      SEPARATOR,
      { kind: 'submenu', label: 'Demos', items: demoItems },
    ],
  };

  // ── Edit ─────────────────────────────────────────────
  const editMenu: TopMenu = {
    label: 'Edit',
    items: [
      actionItem('edit.undo', 'Undo'),
      actionItem('edit.redo', 'Redo'),
      SEPARATOR,
      actionItem('edit.copy', 'Copy'),
      actionItem('edit.paste', 'Paste'),
      actionItem('edit.paste-and-copy-deps', 'Paste and Copy Deps'),
    ],
  };

  // ── Add ──────────────────────────────────────────────
  // Group registered NodeDefs by category. Each leaf is an action
  // ref to `add.<kind>` — those actions are auto-registered by
  // buildActions() from the same registry, so the menu and the
  // palette can't disagree on what's addable.
  const grouped = new Map<string, { id: string; label: string }[]>();
  for (const def of registry.list()) {
    if (isSubgraphInternalKind(def.id)) continue;
    if (isSubgraphInstanceKind(def.id)) continue;
    const list = grouped.get(def.category) ?? [];
    list.push({ id: def.id, label: def.id });
    grouped.set(def.category, list);
  }
  const categorySubmenus: MenuEntry[] = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, defs]): MenuEntry => ({
      kind: 'submenu',
      label: category,
      items: defs
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((d): MenuEntry => actionItem(`add.${d.id}`, d.label)),
    }));
  const addMenu: TopMenu = {
    label: 'Add',
    items: [
      actionItem('add.new-subgraph', 'New Subgraph…'),
      SEPARATOR,
      ...categorySubmenus,
    ],
  };

  // ── View ─────────────────────────────────────────────
  const viewMenu: TopMenu = {
    label: 'View',
    items: [
      actionItem('view.frame-selected', 'Frame Selected'),
      actionItem('view.cleanup', 'Cleanup (Auto-layout)'),
      SEPARATOR,
      actionItem('view.split-right', 'Split Right'),
      actionItem('view.split-down', 'Split Down'),
      SEPARATOR,
      actionItem('view.new-canvas', 'New Canvas View'),
      actionItem('view.new-preview', 'New Preview View'),
      actionItem('view.new-assets', 'New Assets View'),
      SEPARATOR,
      actionItem('view.close', 'Close Active Panel'),
    ],
  };

  // ── Macro (developer-only — gated to ?allow-macros=1) ─
  // The actions themselves are only registered when the gate is on,
  // so we test the registry for `macro.record` to decide whether to
  // add the menu at all (avoids "<missing action>" rows).
  const macroMenu: TopMenu = {
    label: 'Macro',
    items: [
      actionItem('macro.record', 'Record'),
      actionItem('macro.stop', 'Stop Recording'),
      SEPARATOR,
      actionItem('macro.load', 'Load…'),
    ],
  };
  const macrosAllowed = actionMap.has('macro.record');

  // ── Help ─────────────────────────────────────────────
  const helpMenu: TopMenu = {
    label: 'Help',
    items: [
      actionItem('help.docs', 'Node Documentation'),
    ],
  };

  return [
    fileMenu,
    editMenu,
    addMenu,
    viewMenu,
    ...(macrosAllowed ? [macroMenu] : []),
    helpMenu,
  ];
}

export function useAppMenus(): TopMenu[] {
  // Subscribe to actionMap so the menu re-renders when the action
  // set changes (e.g. recording flips macro.* enabled, or a new
  // subgraph adds an Add: <kind> entry the Add submenu indexes).
  const actionMap = useActionMap();
  const registry = useRegistry();
  return useMemo(
    () => buildAppMenus({ actionMap, registry }),
    [actionMap, registry],
  );
}

// Re-export for app.tsx so the MenuBar can be wired with the same
// resolved map the palette uses. Keeping the export here means
// app.tsx only needs to know about one module for menus.
export { useActionMap } from './actions.js';
export type { Action };
