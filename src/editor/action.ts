// One "thing the user can do." The application has exactly one
// registry of these (built by useActions in ./actions.ts); the menu
// bar and the command palette both consume it. Adding a new entry
// there is the ONLY supported way to introduce a user-callable
// operation — both surfaces pick it up automatically, so a new
// command can't be visible in one place and missing from the other.
//
// Anyone tempted to write an inline `run` handler on a menu leaf
// should add an action here instead and reference it by id from the
// menu tree. The MenuEntry type in ./menubar.ts is structured so the
// inline form no longer typechecks.

export interface Action {
  /** Stable dotted id (e.g. "edit.undo", "add.new-subgraph"). Used as
   *  the React key in the palette and as the foreign key from menu
   *  trees back into this registry. Never localized — purely
   *  programmatic. */
  id: string;
  /** User-facing text shown in the command palette. Conventionally
   *  carries a category prefix ("Edit: Undo", "File: Save Project")
   *  so the user can type the category to filter. */
  label: string;
  /** Optional shorter form shown when the action is referenced from
   *  a menu tree. Useful when the palette label carries a category
   *  prefix that's redundant in a menu (the menu IS the category) or
   *  when the menu's wording differs from the palette's verbose form
   *  ("Load…" in the File menu vs "Load Project…" in the palette).
   *
   *  When omitted, the menu uses `label` with its leading
   *  "Category: " prefix stripped, so most actions don't need this.
   *  Defining it here keeps menu rendering DRY — the menu tree
   *  itself just references actions by id, never restating their
   *  display strings. */
  menuLabel?: string;
  /** Optional keyboard-hint string. Display-only — the actual global
   *  keymap lives in app.tsx. */
  shortcut?: string;
  /** Default true. When false, the action still appears in both the
   *  menu and the palette but is rendered dimmed and click-through is
   *  suppressed. */
  enabled?: boolean;
  /** Default false. When true, the action is omitted from the
   *  command palette but still appears in menus / wherever else the
   *  registry is consumed. Use for high-volume, low-utility entries
   *  that would otherwise crowd palette search results — the demo
   *  loaders are the canonical case: the user already reaches them
   *  via File → Demos, and "furniture" / "city" / "trees" matching
   *  the palette steals priority from real commands. */
  paletteHidden?: boolean;
  run: () => void | Promise<void>;
}

// What a menu shows for this action. Derived once at render time so
// the rule lives in one place: explicit menuLabel wins; otherwise
// strip the leading "Category: " from label; otherwise show label.
export function actionMenuLabel(action: Action): string {
  if (action.menuLabel !== undefined) return action.menuLabel;
  const idx = action.label.indexOf(': ');
  if (idx < 0) return action.label;
  return action.label.slice(idx + 2);
}
