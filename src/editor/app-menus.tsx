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

// Sugar: a leaf that references action `actionId`. Display text /
// shortcut / enabled state all come from the resolved action (see
// `actionMenuLabel` in ./action.ts for the category-prefix-strip
// rule). The menu tree never restates display text — actions are
// the single source of truth.
function actionItem(actionId: string): MenuEntry {
  return { kind: 'action', actionId };
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
  const demoItems: MenuEntry[] = DEMOS.map((d) => actionItem(`demo.${d.id}`));
  const fileMenu: TopMenu = {
    label: 'File',
    items: [
      actionItem('file.new'),
      SEPARATOR,
      actionItem('file.save'),
      actionItem('file.load'),
      actionItem('file.save-to-url'),
      SEPARATOR,
      actionItem('file.save-selected'),
      actionItem('file.merge'),
      SEPARATOR,
      { kind: 'submenu', label: 'Demos', items: demoItems },
    ],
  };

  // ── Edit ─────────────────────────────────────────────
  const editMenu: TopMenu = {
    label: 'Edit',
    items: [
      actionItem('edit.undo'),
      actionItem('edit.redo'),
      SEPARATOR,
      actionItem('edit.copy'),
      actionItem('edit.paste'),
      actionItem('edit.paste-and-copy-deps'),
      SEPARATOR,
      actionItem('selection.extract-subgraph'),
    ],
  };

  // ── Add ──────────────────────────────────────────────
  // Group registered NodeDefs by category. Each leaf is an action
  // ref to `add.<kind>` — those actions are auto-registered by
  // buildActions() from the same registry, so the menu and the
  // palette can't disagree on what's addable.
  const grouped = new Map<string, string[]>();
  for (const def of registry.list()) {
    if (isSubgraphInternalKind(def.id)) continue;
    if (isSubgraphInstanceKind(def.id)) continue;
    const list = grouped.get(def.category) ?? [];
    list.push(def.id);
    grouped.set(def.category, list);
  }
  const categorySubmenus: MenuEntry[] = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, kinds]): MenuEntry => ({
      kind: 'submenu',
      label: category,
      items: kinds
        .sort((a, b) => a.localeCompare(b))
        .map((kind): MenuEntry => actionItem(`add.${kind}`)),
    }));
  const addMenu: TopMenu = {
    label: 'Add',
    items: [
      actionItem('add.new-subgraph'),
      SEPARATOR,
      ...categorySubmenus,
    ],
  };

  // ── View ─────────────────────────────────────────────
  const viewMenu: TopMenu = {
    label: 'View',
    items: [
      actionItem('view.frame-selected'),
      actionItem('view.cleanup'),
      SEPARATOR,
      actionItem('view.split-right'),
      actionItem('view.split-down'),
      SEPARATOR,
      actionItem('view.new-canvas'),
      actionItem('view.new-preview'),
      actionItem('view.new-assets'),
      SEPARATOR,
      actionItem('view.close'),
    ],
  };

  // ── Macro (developer-only — gated to ?allow-macros=1) ─
  // The actions themselves are only registered when the gate is on,
  // so we test the registry for `macro.record` to decide whether to
  // add the menu at all (avoids "<missing action>" rows).
  const macroMenu: TopMenu = {
    label: 'Macro',
    items: [
      actionItem('macro.record'),
      actionItem('macro.stop'),
      SEPARATOR,
      actionItem('macro.load'),
    ],
  };
  const macrosAllowed = actionMap.has('macro.record');

  // ── Help ─────────────────────────────────────────────
  const helpMenu: TopMenu = {
    label: 'Help',
    items: [
      actionItem('help.docs'),
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
