import { createRoot } from 'react-dom/client';
import { App } from './editor/app.js';
import './editor/editor.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root element not found');
}
createRoot(root).render(<App />);
