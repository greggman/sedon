import {
  DockviewReact,
  themeAbyss,
  type BuiltInContextMenuItem,
  type DockviewReadyEvent,
  type GetTabContextMenuItemsParams,
  type ReactContextMenuItemConfig,
} from 'dockview';
import { useCallback, useEffect, useState } from 'react';
import { useActionMap } from './actions.js';
import { useAppMenus } from './app-menus.js';
import { getActiveAssetPanel } from './asset-clipboard.js';
import { copySelection, pasteFromClipboard } from './clipboard-ops.js';
import { frameSelectedInActiveCanvas } from './commands.js';
import { CommandPalette } from './command-palette.js';
import { navigateCanvasBack, navigateCanvasForward } from './open-graph.js';
import { GithubLink } from './github-link.js';
import { getDockviewApi, setDockviewApi } from './dockview-handle.js';
import { GraphSwitcher } from './graph-switcher.js';
import { MenuBar } from './menubar.js';
import { PANEL_COMPONENTS } from './panels.js';
import { bumpPopoutGeneration } from './popout-bus.js';
import { useLayoutStore } from './layout-store.js';
import { getCanvasRf } from './rf-registry.js';

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
  // Resolved action map for the MenuBar — same registry the
  // CommandPalette reads. Keeping them on one source means a new
  // entry in actions.ts is searchable in the palette automatically
  // and click-runnable from any menu tree that references it.
  const actionMap = useActionMap();
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
    // Initial layout:
    //   ┌──────────┬───────────┐
    //   │  Canvas  │           │
    //   ├──────────┤  Preview  │
    //   │  Assets  │           │
    //   └──────────┴───────────┘
    // Canvas + Assets share the left column with a horizontal split;
    // Preview spans full height on the right. The order matters —
    // preview goes BEFORE assets so it ends up in the right-hand group
    // (full height) rather than splitting only the canvas column.
    event.api.addPanel({
      id: 'canvas-main',
      component: 'node-canvas',
      title: 'Canvas',
    });
    event.api.addPanel({
      id: 'preview-main',
      component: 'preview',
      title: 'Preview',
      position: { referencePanel: 'canvas-main', direction: 'right' },
    });
    event.api.addPanel({
      id: 'assets-main',
      component: 'assets',
      title: 'Assets',
      position: { referencePanel: 'canvas-main', direction: 'below' },
      // Assets gets ~25% of the column. DockView sets this as the
      // panel's pixel height at creation; the user can drag the splitter
      // afterwards. Falls back to a sensible default if window height
      // isn't readable (server-side render guard).
      initialHeight: Math.round((typeof window !== 'undefined' ? window.innerHeight : 800) * 0.25),
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

  // Cmd/Ctrl+[ / Cmd/Ctrl+] move the last-active canvas's history
  // cursor back / forward (the inverse of double-clicking a subgraph
  // wrapper to drill in). Listening at window level — and registering
  // during CAPTURE — is what keeps the browser's history shortcuts
  // from firing first when focus is somewhere outside the canvas pane
  // (the menubar, an asset row, the app shell). preventDefault always
  // fires on the chord, even with no available target, so we never
  // accidentally unload the SPA.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key !== '[' && e.key !== ']') return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return;
      }
      e.preventDefault();
      const panelId = useLayoutStore.getState().lastActiveCanvasPanelId;
      if (!panelId) return;
      if (e.key === '[') navigateCanvasBack(panelId);
      else navigateCanvasForward(panelId);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Cmd/Ctrl+A: select-all in the active DockView panel rather than
  // letting the browser select the page's DOM text. Routes by panel
  // kind:
  //   • node-canvas → mark every RF node selected in *that* canvas.
  //   • assets      → call the active AssetsPanel's performSelectAll
  //                   (its own listener also handles this when focus
  //                   is inside the panel; performSelectAll is
  //                   idempotent, so a double-call is harmless).
  //   • preview     → preventDefault no-op (we have no select-all
  //                   semantics there yet, but blocking the browser's
  //                   page-wide highlight is still better than
  //                   nothing).
  // Skipped entirely when focus is in a text-typed input so users can
  // still select-all inside rename / search / palette fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      if (e.key !== 'a' && e.key !== 'A') return;
      const t = e.target as HTMLElement | null;
      if (t) {
        if (t.tagName === 'TEXTAREA' || t.isContentEditable) return;
        if (t.tagName === 'INPUT') {
          const tt = (t as HTMLInputElement).type;
          if (
            tt === 'text' || tt === 'search' || tt === 'url'
            || tt === 'tel' || tt === 'email' || tt === 'password'
          ) {
            return;
          }
        }
      }
      const api = getDockviewApi();
      const active = api?.activePanel;
      if (!active) return;
      const kind = active.view.contentComponent;
      if (kind === 'node-canvas') {
        const rf = getCanvasRf(active.id);
        if (!rf) return;
        e.preventDefault();
        rf.setNodes((nds) => nds.map((n) => (n.selected ? n : { ...n, selected: true })));
      } else if (kind === 'assets') {
        e.preventDefault();
        getActiveAssetPanel()?.performSelectAll();
      } else if (kind === 'preview') {
        // Suppress the browser's "select all text on page" — Preview
        // has no select-all of its own yet, but the page-wide highlight
        // is worse than nothing.
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Cmd/Ctrl+C / +V : copy / paste node selection in the active
  // canvas. Mirrors the Cmd+A handler above — bails when focus is in
  // a text field (the browser handles text copy/paste there), only
  // fires when the active DockView panel is a node-canvas. Failures
  // surface through alert(); silent no-ops would leave the user
  // wondering whether the shortcut was bound at all.
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.shiftKey || e.altKey) return;
      const isCopy = e.key === 'c' || e.key === 'C';
      const isPaste = e.key === 'v' || e.key === 'V';
      if (!isCopy && !isPaste) return;
      const t = e.target as HTMLElement | null;
      if (t) {
        if (t.tagName === 'TEXTAREA' || t.isContentEditable) return;
        if (t.tagName === 'INPUT') {
          const tt = (t as HTMLInputElement).type;
          if (
            tt === 'text' || tt === 'search' || tt === 'url'
            || tt === 'tel' || tt === 'email' || tt === 'password' || tt === 'number'
          ) {
            return;
          }
        }
      }
      const api = getDockviewApi();
      const active = api?.activePanel;
      if (!active || active.view.contentComponent !== 'node-canvas') return;
      e.preventDefault();
      try {
        if (isCopy) {
          await copySelection();
        } else {
          await pasteFromClipboard();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-alert
        alert(`Clipboard ${isCopy ? 'copy' : 'paste'} failed: ${msg}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // F : Frame Selected (or fit-all when nothing selected). Window-level
  // so it works regardless of where focus landed inside the canvas —
  // clicking the empty pane parks focus on dockview's container, which
  // is OUTSIDE the React Flow wrapper, so a wrapper-level keydown never
  // fires in that case. Routes through the same code path the View
  // menu uses (`frameSelectedInActiveCanvas`).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== 'f' && e.key !== 'F') return;
      const t = e.target as HTMLElement | null;
      if (t) {
        if (t.tagName === 'TEXTAREA' || t.isContentEditable) return;
        if (t.tagName === 'INPUT') return;
      }
      const api = getDockviewApi();
      const active = api?.activePanel;
      if (!active) return;
      // Preview handles its own F via the wrapper-level keydown
      // listener in preview.tsx (it also drives the FPS WASD keys
      // from that same listener), so we only run for the canvas case.
      if (active.view.contentComponent !== 'node-canvas') return;
      e.preventDefault();
      frameSelectedInActiveCanvas();
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
        <MenuBar menus={menus} actions={actionMap} />
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
