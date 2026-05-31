import { useRef, useState } from 'react';
import { useDismiss } from './use-dismiss.js';
import { useEditorStore } from './store.js';

// Toolbar dropdown for navigating between the main project graph and any
// subgraph defined by the current demo / project. Click an entry → the
// editor canvas swaps to that graph. Mutations apply to whichever graph is
// active and route back to mainGraph or the matching SubgraphDef on commit.
export function GraphSwitcher() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(open, rootRef, () => setOpen(false));
  const subgraphs = useEditorStore((s) => s.subgraphs);
  const currentEditingId = useEditorStore((s) => s.currentEditingId);
  const setActiveEditing = useEditorStore((s) => s.setActiveEditing);

  // No subgraphs in the project → nothing to switch to. Hide the dropdown
  // entirely so the toolbar isn't cluttered for the basic demo.
  if (subgraphs.length === 0) return null;

  const currentLabel =
    currentEditingId === 'main'
      ? 'Main'
      : subgraphs.find((s) => s.id === currentEditingId)?.label ?? currentEditingId;

  const select = (id: string) => {
    // Drag positions are continuously synced via NodeCanvas's
    // onNodeDragStop, so the store is already current and we just need
    // to flip the active editing id.
    setActiveEditing(id);
    setOpen(false);
  };

  return (
    <div className="sedon-demos-menu" ref={rootRef}>
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
          {subgraphs
            // Hide for-each-point bridges from the switcher dropdown
            // (private node-owned graphs; reached via "Edit"
            // on the for-each-point itself, not via a global picker).
            // The currentLabel lookup above DOES still find them by
            // id so the toolbar shows the right context when the user
            // is editing one.
            .filter((sg) => sg.owner?.kind !== 'iteration-bridge')
            .map((sg) => (
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
