import { NodeCanvas } from './node-canvas.js';
import { Preview } from './preview.js';

export function App() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        height: '100%',
        gap: 1,
        background: '#2a2a2f',
      }}
    >
      <div style={{ background: '#1a1a1f', overflow: 'hidden' }}>
        <NodeCanvas />
      </div>
      <div style={{ background: '#0d0d10', overflow: 'hidden' }}>
        <Preview />
      </div>
    </div>
  );
}
