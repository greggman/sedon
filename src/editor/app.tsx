import { ReactFlowProvider } from '@xyflow/react';
import {
  DockviewReact,
  themeAbyss,
  type BuiltInContextMenuItem,
  type DockviewReadyEvent,
  type GetTabContextMenuItemsParams,
  type ReactContextMenuItemConfig,
} from 'dockview';
import { useCallback } from 'react';
import { CleanupButton } from './cleanup-button.js';
import { DemosMenu } from './demos-menu.js';
import { FileMenu } from './file-menu.js';
import { GraphSwitcher } from './graph-switcher.js';
import { NewSubgraphButton } from './new-subgraph-button.js';
import { PANEL_COMPONENTS } from './panels.js';

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

  return (
    <ReactFlowProvider>
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
      </div>
    </ReactFlowProvider>
  );
}
