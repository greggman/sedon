import { ReactFlowProvider } from '@xyflow/react';
import { useRef } from 'react';
import { AddNodeMenu } from './add-node-menu.js';
import { FileMenu } from './file-menu.js';
import { NodeCanvas } from './node-canvas.js';
import { Preview } from './preview.js';

export function App() {
  const canvasPaneRef = useRef<HTMLDivElement>(null);

  return (
    <ReactFlowProvider>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          height: '100%',
          gap: 1,
          background: '#2a2a2f',
        }}
      >
        <div
          ref={canvasPaneRef}
          style={{ background: '#1a1a1f', overflow: 'hidden', position: 'relative' }}
        >
          <NodeCanvas />
          <AddNodeMenu canvasRef={canvasPaneRef} />
          <FileMenu />
        </div>
        <div style={{ background: '#0d0d10', overflow: 'hidden' }}>
          <Preview />
        </div>
      </div>
    </ReactFlowProvider>
  );
}
