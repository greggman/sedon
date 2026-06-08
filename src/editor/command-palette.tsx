import { useEffect, useMemo, useRef, useState } from 'react';
import type { Action } from './action.js';
import { useActions } from './actions.js';

// VSCode-style command palette. Cmd/Ctrl+Shift+P opens it; typing
// substring-filters the list; Up/Down/Enter selects; Escape closes;
// clicking outside the panel closes.
//
// Match is a case-insensitive substring over the label, kept dumb on
// purpose — fancy fuzzy ranking is easy to bolt on later but rarely
// changes the chosen command for a ~12-entry catalog.

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  // Same registry the menu bar consumes — adding an action in
  // ./actions.ts makes it palette-searchable without a touch here.
  const actions = useActions();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Tokenized substring match: split the query on whitespace and
  // require every token to appear somewhere in the label, in any
  // order. So "add sphere" matches "Add: core/sphere" (both tokens
  // present), the way a VSCode-ish palette does it. A plain substring
  // search would force the user to know our exact label format
  // ("Add:" vs "Add").
  const filtered = useMemo<Action[]>(() => {
    const q = query.toLowerCase().trim();
    if (!q) return actions;
    const tokens = q.split(/\s+/).filter(Boolean);
    return actions.filter((a) => {
      const label = a.label.toLowerCase();
      return tokens.every((t) => label.includes(t));
    });
  }, [actions, query]);

  // Reset state + focus the input every time the palette opens. Without
  // resetting, reopening retains the previous query — not what users
  // expect from a Cmd-Shift-P workflow.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // When the filter set changes, snap the cursor back to the top so
  // Enter always runs the most relevant result (not whatever index the
  // previous filter had selected).
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  const run = (action: Action) => {
    if (action.enabled === false) return;
    onClose();
    void action.run();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const action = filtered[activeIndex];
      if (action) run(action);
    }
  };

  return (
    <div className="sedon-palette-backdrop" onMouseDown={onClose}>
      <div
        className="sedon-palette"
        // Eat backdrop clicks that originated inside the panel so a
        // mousedown on the input/list doesn't dismiss the palette.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="sedon-palette-input"
          type="text"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="sedon-palette-results">
          {filtered.length === 0 ? (
            <div className="sedon-palette-empty">No matching commands</div>
          ) : (
            filtered.map((action, i) => {
              const disabled = action.enabled === false;
              return (
                <button
                  type="button"
                  key={action.id}
                  disabled={disabled}
                  className={`sedon-palette-item${i === activeIndex ? ' sedon-palette-item--active' : ''}${disabled ? ' sedon-palette-item--disabled' : ''}`}
                  onMouseEnter={() => setActiveIndex(i)}
                  // mousedown rather than click — by click time the input
                  // has blurred and we'd race the input's blur handlers.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    run(action);
                  }}
                >
                  <span className="sedon-palette-label">{action.label}</span>
                  {action.shortcut && (
                    <span className="sedon-palette-shortcut">{action.shortcut}</span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
