import { ReactFlowProvider } from '@xyflow/react';
import { useRef } from 'react';
import { AddNodeMenu } from './add-node-menu.js';
import { CleanupButton } from './cleanup-button.js';
import { DemosMenu } from './demos-menu.js';
import { FileMenu } from './file-menu.js';
import { GraphSwitcher } from './graph-switcher.js';
import { NodeCanvas } from './node-canvas.js';
import { Preview } from './preview.js';

export function App() {
  const canvasPaneRef = useRef<HTMLDivElement>(null);

  return (
    <ReactFlowProvider>
      <div className="sedon-app">
        <div ref={canvasPaneRef} className="sedon-pane sedon-pane--canvas">
          <NodeCanvas />
          <AddNodeMenu canvasRef={canvasPaneRef} />
          <div className="sedon-top-toolbar">
            <GraphSwitcher />
            <DemosMenu />
            <CleanupButton />
            <FileMenu />
          </div>
        </div>
        <div className="sedon-pane sedon-pane--preview">
          <Preview />
        </div>
      </div>
    </ReactFlowProvider>
  );
}
