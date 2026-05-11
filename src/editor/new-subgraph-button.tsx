import { useEditorStore } from './store.js';

// Slug-ify a freeform label into a subgraph id: lowercase, non-alnum→dash,
// trim leading/trailing dashes. If the result collides with an existing
// subgraph (or the literal 'main'), append -2, -3, ... until unique.
function slugify(label: string, existing: ReadonlySet<string>): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'subgraph';
  if (!existing.has(base) && base !== 'main') return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate) && candidate !== 'main') return candidate;
  }
}

// Create a fresh empty subgraph and switch the editor into it. Uses
// window.prompt for the label — quick and good enough for now; can be
// replaced with an inline form when we add more authoring chrome.
export function NewSubgraphButton() {
  const createSubgraph = useEditorStore((s) => s.createSubgraph);

  const onClick = () => {
    const label = window.prompt('New subgraph name:', 'Custom');
    if (label === null) return;
    const trimmed = label.trim();
    if (trimmed.length === 0) return;
    const existing = new Set(useEditorStore.getState().subgraphs.map((s) => s.id));
    const id = slugify(trimmed, existing);
    createSubgraph(id, trimmed);
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="sedon-toolbar-button"
      title="Create a new empty subgraph and edit it"
    >
      New Subgraph
    </button>
  );
}
