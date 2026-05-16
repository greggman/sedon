import { useMemo } from 'react';
import { getDockviewApi } from './dockview-handle.js';
import { loadProject, saveProject } from './file-ops.js';
import { useEditorStore } from './store.js';

// Catalog of "no-argument" actions invokable from the command palette.
// Each entry is a callable + a human-readable label + an optional
// keyboard shortcut hint (the palette only renders the hint — actual
// global keybindings live in app.tsx).
//
// The list is built per-render via a hook so it can close over the
// active React Flow instance (Save/Load need rf.getNodes / setNodes).
// Everything else reaches into the store or the DockView singleton
// directly, so no React context is captured.

export interface PaletteCommand {
  id: string;
  label: string;
  shortcut?: string;
  /** False means "currently disabled" — the palette still shows it dimmed. */
  enabled?: boolean;
  run: () => void | Promise<void>;
}

export function useCommands(): PaletteCommand[] {
  // Static catalog — no React Flow context needed any more (file-ops
  // operate purely on the store). useMemo just avoids handing a fresh
  // array to the palette every parent render.
  return useMemo(() => buildCommands(), []);
}

function buildCommands(): PaletteCommand[] {
  return [
    {
      id: 'file.save',
      label: 'File: Save Project',
      shortcut: 'Cmd/Ctrl+S',
      run: () => saveProject(),
    },
    {
      id: 'file.load',
      label: 'File: Load Project…',
      shortcut: 'Cmd/Ctrl+O',
      run: () => loadProject(),
    },
    {
      id: 'edit.undo',
      label: 'Edit: Undo',
      shortcut: 'Cmd/Ctrl+Z',
      run: () => useEditorStore.getState().undo(),
    },
    {
      id: 'edit.redo',
      label: 'Edit: Redo',
      shortcut: 'Cmd/Ctrl+Shift+Z',
      run: () => useEditorStore.getState().redo(),
    },
    {
      id: 'view.split-right',
      label: 'View: Split Right',
      run: () => splitActivePanel('right'),
    },
    {
      id: 'view.split-down',
      label: 'View: Split Down',
      run: () => splitActivePanel('below'),
    },
    {
      id: 'view.close',
      label: 'View: Close Active Panel',
      run: () => closeActivePanel(),
    },
    {
      id: 'view.new-canvas',
      label: 'View: Create Canvas View',
      run: () => createPanel('node-canvas', 'Canvas'),
    },
    {
      id: 'view.new-preview',
      label: 'View: Create Preview View',
      run: () => createPanel('preview', 'Preview'),
    },
    {
      id: 'view.new-assets',
      label: 'View: Create Asset View',
      run: () => createPanel('assets', 'Assets'),
    },
  ];
}

// Generate a panel id distinct from any existing panel. Used by every
// view-creating command so reopening a panel after closing it doesn't
// collide with a stale id elsewhere in the DockView model.
function freshPanelId(component: string): string {
  return `${component}-${crypto.randomUUID().slice(0, 8)}`;
}

function splitActivePanel(direction: 'right' | 'below'): void {
  const api = getDockviewApi();
  if (!api) return;
  const active = api.activePanel;
  if (!active) {
    // No active panel (e.g. all closed) — fall back to placing a new
    // canvas at the top level so the user isn't stuck with nowhere to
    // split from.
    createPanel('node-canvas', 'Canvas');
    return;
  }
  // Duplicate the active panel's type rather than always creating a
  // canvas. "Split Right" on a Preview yields a second Preview, which
  // is what users expect from editor splits.
  const component = active.view.contentComponent;
  api.addPanel({
    id: freshPanelId(component),
    component,
    title: defaultTitle(component),
    position: { referencePanel: active.id, direction },
  });
}

function closeActivePanel(): void {
  const api = getDockviewApi();
  if (!api) return;
  const active = api.activePanel;
  if (!active) return;
  api.removePanel(active);
}

function createPanel(component: string, title: string): void {
  const api = getDockviewApi();
  if (!api) return;
  api.addPanel({
    id: freshPanelId(component),
    component,
    title,
  });
}

function defaultTitle(component: string): string {
  switch (component) {
    case 'node-canvas':
      return 'Canvas';
    case 'preview':
      return 'Preview';
    case 'assets':
      return 'Assets';
    default:
      return component;
  }
}
