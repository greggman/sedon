import {
  DockviewReact,
  themeAbyss,
  type BuiltInContextMenuItem,
  type DockviewReadyEvent,
  type GetTabContextMenuItemsParams,
  type ReactContextMenuItemConfig,
} from 'dockview';
import { useCallback, useEffect, useState } from 'react';
import { useAppMenus } from './app-menus.js';
import { CommandPalette } from './command-palette.js';
import { GithubLink } from './github-link.js';
import { setDockviewApi } from './dockview-handle.js';
import { GraphSwitcher } from './graph-switcher.js';
import { MenuBar } from './menubar.js';
import { PANEL_COMPONENTS } from './panels.js';
import { bumpPopoutGeneration } from './popout-bus.js';
import { useLayoutStore } from './layout-store.js';

// App shell:
//
//   ┌─────────────────────────────────────────┐
//   │ Top toolbar (graph switcher, demos, …)  │
//   ├─────────────────────────────────────────┤
//   │ DockView root                           │
//   │  ┌──────────────────┬──────────────────┐│
//   │  │  Node Canvas     │   Preview        ││
//   │  │                  │                  ││
//   │  └──────────────────┴──────────────────┘│
//   └─────────────────────────────────────────┘
//
// Toolbar widgets (GraphSwitcher, GithubLink) sit alongside the
// MenuBar — the menu hosts commands (Save/Load/Demos/Undo/Add/Frame/etc),
// the toolbar hosts persistent context indicators (current graph,
// external links).
export function App() {
  const menus = useAppMenus();
  // Initial DockView layout: a canvas panel on the left, a preview
  // panel split to its right. `onReady` fires once when DockView's
  // internal model is initialised. We seed the model imperatively here
  // because Phase 2a doesn't persist layout to the save file yet —
  // that lands in a follow-up alongside the rest of the layout-store
  // work.
  const onReady = useCallback((event: DockviewReadyEvent) => {
    // Expose the DockView API to imperative callers (command palette,
    // future keyboard shortcuts). Cleared on App unmount via the
    // effect below so a re-mount doesn't see a stale reference.
    setDockviewApi(event.api);
    // Popout open/close moves a panel's DOM to a different document.
    // WebGPU canvases inside that DOM keep their GPUCanvasContext, but
    // the context's swap chain is tied to the old document, so they
    // render black or throw on the next submit. Bumping the popout
    // generation signals every canvas to re-configure against its new
    // ownerDocument. onDidMovePanel covers panel moves between groups
    // (incl. popout-into-new-group and popout-back-to-main); we also
    // listen to add/remove group as a belt-and-suspenders catch.
    event.api.onDidMovePanel(() => bumpPopoutGeneration());
    event.api.onDidAddGroup(() => bumpPopoutGeneration());
    event.api.onDidRemoveGroup(() => bumpPopoutGeneration());
    // Track the most-recent canvas / preview panel the user activated.
    // Asset-view actions ("Open in Canvas", "Open in Preview") route to
    // these. Setters are no-ops when activePanel is undefined (e.g. all
    // panels closed) — the last value sticks until something else
    // becomes active, which matches user intuition ("re-open in the one
    // I just had").
    const layout = useLayoutStore.getState();
    event.api.onDidActivePanelChange((panel) => {
      if (!panel) return;
      const kind = panel.view.contentComponent;
      if (kind === 'node-canvas') layout.setLastActiveCanvasPanelId(panel.id);
      else if (kind === 'preview') layout.setLastActivePreviewPanelId(panel.id);
    });
    // Clean up last-active references if the panel they point at is
    // closed — otherwise a stale id leads asset actions to target a
    // dead panel.
    event.api.onDidRemovePanel((panel) => {
      const l = useLayoutStore.getState();
      if (l.lastActiveCanvasPanelId === panel.id) l.setLastActiveCanvasPanelId(null);
      if (l.lastActivePreviewPanelId === panel.id) l.setLastActivePreviewPanelId(null);
      l.clearCanvasGraphId(panel.id);
    });
    event.api.addPanel({
      id: 'assets-main',
      component: 'assets',
      title: 'Assets',
    });
    event.api.addPanel({
      id: 'canvas-main',
      component: 'node-canvas',
      title: 'Canvas',
      position: { referencePanel: 'assets-main', direction: 'right' },
    });
    event.api.addPanel({
      id: 'preview-main',
      component: 'preview',
      title: 'Preview',
      position: { referencePanel: 'canvas-main', direction: 'right' },
    });
  }, []);
  useEffect(() => () => setDockviewApi(null), []);

  // Cmd/Ctrl+Shift+P opens the command palette. We listen at the window
  // level so the shortcut works regardless of which panel currently has
  // focus, but bail when typing in inputs/textareas so it doesn't fight
  // text editing in inspectors / rename fields.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return;
      if (e.key !== 'p' && e.key !== 'P') return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      setPaletteOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Right-click tab → menu with the standard close items plus
  // "Pop out to window". Popout creates a real OS-level browser window
  // hosting the panel's DOM (Sedon's WebGPU device is shared across
  // windows, so canvases keep working). DockView serves popout.html as
  // the new window's base; the panel's React tree lives in the parent
  // and portals render into the popout's body.
  const getTabContextMenuItems = useCallback(
    (
      params: GetTabContextMenuItemsParams,
    ): (BuiltInContextMenuItem | ReactContextMenuItemConfig)[] => {
      return [
        'close',
        'closeOthers',
        'closeAll',
        'separator',
        {
          label: 'Pop out to window',
          action: () => {
            void params.api.addPopoutGroup(params.panel);
          },
        },
      ];
    },
    [],
  );

  // No top-level ReactFlowProvider: each NodeCanvasPanel mounts its own
  // so two canvases editing the same graph have independent viewports.
  // Toolbar items that used to call useReactFlow() now write through
  // the editor store; CleanupButton resolves an active canvas via
  // rf-registry instead.
  return (
    <div className="sedon-app">
      <div className="sedon-top-toolbar">
        <MenuBar menus={menus} />
        <div className="sedon-top-toolbar-spacer" />
        <GraphSwitcher />
        <GithubLink />
      </div>
      <div className="sedon-dockview-container">
        <DockviewReact
          components={PANEL_COMPONENTS}
          onReady={onReady}
          theme={themeAbyss}
          getTabContextMenuItems={getTabContextMenuItems}
        />
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
