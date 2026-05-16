import { useEffect, useMemo, useRef, useState } from 'react';
import { useCommands, type PaletteCommand } from './commands.js';

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
  const commands = useCommands();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo<PaletteCommand[]>(() => {
    const q = query.toLowerCase().trim();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

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

  const run = (cmd: PaletteCommand) => {
    onClose();
    void cmd.run();
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
      const cmd = filtered[activeIndex];
      if (cmd) run(cmd);
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
            filtered.map((cmd, i) => (
              <button
                type="button"
                key={cmd.id}
                className={`sedon-palette-item${i === activeIndex ? ' sedon-palette-item--active' : ''}`}
                onMouseEnter={() => setActiveIndex(i)}
                // mousedown rather than click — by click time the input
                // has blurred and we'd race the input's blur handlers.
                onMouseDown={(e) => {
                  e.preventDefault();
                  run(cmd);
                }}
              >
                <span className="sedon-palette-label">{cmd.label}</span>
                {cmd.shortcut && (
                  <span className="sedon-palette-shortcut">{cmd.shortcut}</span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
