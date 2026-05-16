import { loadProject, saveProject } from './file-ops.js';

// Toolbar Save / Load buttons. Thin wrappers around file-ops so the
// command palette and these buttons share one code path.
export function FileMenu() {
  return (
    <>
      <button
        type="button"
        onClick={saveProject}
        className="sedon-toolbar-button"
        title="Download graph as JSON"
      >
        Save
      </button>
      <button
        type="button"
        onClick={loadProject}
        className="sedon-toolbar-button"
        title="Load graph from JSON"
      >
        Load
      </button>
    </>
  );
}
