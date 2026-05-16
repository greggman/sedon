import { createRoot } from 'react-dom/client';
import { App } from './editor/app.js';
import 'dockview/dist/styles/dockview.css';
import './editor/editor.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root element not found');
}
createRoot(root).render(<App />);
