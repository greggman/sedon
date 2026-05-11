import { useReactFlow } from '@xyflow/react';
import { useState } from 'react';
import { useEditorStore } from './store.js';

// Toolbar dropdown for navigating between the main project graph and any
// subgraph defined by the current demo / project. Click an entry → the
// editor canvas swaps to that graph. Mutations apply to whichever graph is
// active and route back to mainGraph or the matching SubgraphDef on commit.
export function GraphSwitcher() {
  const [open, setOpen] = useState(false);
  const rf = useReactFlow();
  const subgraphs = useEditorStore((s) => s.subgraphs);
  const currentEditingId = useEditorStore((s) => s.currentEditingId);
  const setActiveEditing = useEditorStore((s) => s.setActiveEditing);
  const commitActivePositions = useEditorStore((s) => s.commitActivePositions);

  // No subgraphs in the project → nothing to switch to. Hide the dropdown
  // entirely so the toolbar isn't cluttered for the basic demo.
  if (subgraphs.length === 0) return null;

  const currentLabel =
    currentEditingId === 'main'
      ? 'Main'
      : subgraphs.find((s) => s.id === currentEditingId)?.label ?? currentEditingId;

  const select = (id: string) => {
    // Persist drag-positions of the current graph into the store before
    // switching — RF discards them on graph change otherwise.
    const positions = new Map(
      rf.getNodes().map((n) => [n.id, n.position]),
    );
    commitActivePositions(positions);
    setActiveEditing(id);
    setOpen(false);
  };

  return (
    <div className="sedon-demos-menu">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="sedon-toolbar-button"
        title="Switch which graph the editor is viewing"
      >
        Graph: {currentLabel} ▾
      </button>
      {open && (
        <div className="sedon-menu-popup sedon-demos-popup">
          <button
            type="button"
            onClick={() => select('main')}
            className="sedon-menu-item sedon-demos-item"
            style={currentEditingId === 'main' ? { fontWeight: 600 } : undefined}
          >
            Main
          </button>
          {subgraphs.map((sg) => (
            <button
              key={sg.id}
              type="button"
              onClick={() => select(sg.id)}
              className="sedon-menu-item sedon-demos-item"
              style={currentEditingId === sg.id ? { fontWeight: 600 } : undefined}
            >
              {sg.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
