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
   *  so the user can type the category to filter. Menu trees can
   *  override this display via MenuActionRef.label when the category
   *  is already implicit in the menu's parent. */
  label: string;
  /** Optional keyboard-hint string. Display-only — the actual global
   *  keymap lives in app.tsx. */
  shortcut?: string;
  /** Default true. When false, the action still appears in both the
   *  menu and the palette but is rendered dimmed and click-through is
   *  suppressed. */
  enabled?: boolean;
  run: () => void | Promise<void>;
}
