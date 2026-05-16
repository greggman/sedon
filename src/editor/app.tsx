import {
  DockviewReact,
  themeAbyss,
  type BuiltInContextMenuItem,
  type DockviewReadyEvent,
  type GetTabContextMenuItemsParams,
  type ReactContextMenuItemConfig,
} from 'dockview';
import { useCallback, useEffect, useState } from 'react';
import { CleanupButton } from './cleanup-button.js';
import { CommandPalette } from './command-palette.js';
import { DemosMenu } from './demos-menu.js';
import { setDockviewApi } from './dockview-handle.js';
import { FileMenu } from './file-menu.js';
import { GraphSwitcher } from './graph-switcher.js';
import { NewSubgraphButton } from './new-subgraph-button.js';
import { PANEL_COMPONENTS } from './panels.js';
import { bumpPopoutGeneration } from './popout-bus.js';

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
// One ReactFlowProvider wraps the whole app so the toolbar's FileMenu
// can use `useReactFlow()` while the canvas panel owns the actual RF
// instance. With a single canvas this is the natural shape; multi-
// canvas (Phase 2b) will scope per-panel RF providers and route file-
// menu's position-commit through the store instead of through RF.
export function App() {
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
        <GraphSwitcher />
        <DemosMenu />
        <NewSubgraphButton />
        <CleanupButton />
        <FileMenu />
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
