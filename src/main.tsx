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
  // Layout store exposed so headless repros that simulate the
  // demos-menu / file-load flow can run `resetForNewProject` between
  // setGraph calls. Production UI invokes this through the menu itself.
  void import('./editor/layout-store.js').then((m) => {
    (window as unknown as { __sedonLayoutStore__: typeof m.useLayoutStore }).__sedonLayoutStore__ = m.useLayoutStore;
  });
  // The navigation helpers that the Asset view's double-click and
  // "Open in Preview" buttons call. Exposed so headless repros can
  // exercise the exact same code path as a user click — including
  // panel pinning, which the per-panel preview/canvas selectors
  // listen to.
  void import('./editor/open-graph.js').then((m) => {
    (window as unknown as { __sedonOpenGraphInCanvas__: typeof m.openGraphInCanvas }).__sedonOpenGraphInCanvas__ = m.openGraphInCanvas;
    (window as unknown as { __sedonOpenGraphInPreview__: typeof m.openGraphInPreview }).__sedonOpenGraphInPreview__ = m.openGraphInPreview;
  });
  // Card-array blit counter — lets headless grass repros assert a colour
  // edit re-copies the array (a WebGPU canvas can't be pixel-diffed).
  void import('./render/grass.js').then((m) => {
    (window as unknown as { __sedonGrassBlits__: typeof m.getGrassBlitCount }).__sedonGrassBlits__ = m.getGrassBlitCount;
  });
}

createRoot(root).render(<App />);
