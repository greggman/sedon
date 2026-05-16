import { useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview';
import { AddNodeMenu } from './add-node-menu.js';
import { NodeCanvas } from './node-canvas.js';
import { Preview } from './preview.js';

// DockView panel components. Each panel kind ('node-canvas', 'preview',
// later 'inspector' / 'assets') is registered once via the components
// map passed to <DockviewReact />. The app's single ReactFlowProvider
// lives above this in App.tsx; per-panel RF providers (one per canvas)
// land in Phase 2b when canvases pin to different graphs.

export function NodeCanvasPanel(_props: IDockviewPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef} className="sedon-panel sedon-panel--canvas">
      <NodeCanvas />
      <AddNodeMenu canvasRef={containerRef} />
    </div>
  );
}

export function PreviewPanel(_props: IDockviewPanelProps) {
  return (
    <div className="sedon-panel sedon-panel--preview">
      <Preview />
    </div>
  );
}

// Registry passed to <DockviewReact components={...}>. Each key is the
// `component` string referenced when calling `api.addPanel({...})`.
export const PANEL_COMPONENTS = {
  'node-canvas': NodeCanvasPanel,
  preview: PreviewPanel,
};
