import { createRoot } from 'react-dom/client';
import { App } from './editor/app.js';
import { DEMOS } from './editor/demos/index.js';
import { useEditorStore } from './editor/store.js';
import 'dockview/dist/styles/dockview.css';
import './editor/editor.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root element not found');
}

// Test/debug hook: when running with `?debug=1`, expose the store + demos
// on window so Puppeteer (or the devtools console) can drive the editor
// without UI clicks. Used to reproduce GPU-pool-churn bugs deterministically.
if (new URLSearchParams(window.location.search).get('debug') === '1') {
  (window as unknown as { __sedonStore__: typeof useEditorStore }).__sedonStore__ = useEditorStore;
  (window as unknown as { __sedonDemos__: typeof DEMOS }).__sedonDemos__ = DEMOS;
}

createRoot(root).render(<App />);
