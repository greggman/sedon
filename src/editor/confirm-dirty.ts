import { useEditorStore } from './store.js';

// Browser-native confirm dialog gated on the store's `dirty` flag. Returns
// true if the caller may proceed with a destructive action (load file,
// switch demo). Returns false if the graph is dirty and the user clicked
// Cancel. Always-true when the graph is clean.
export function confirmDiscardIfDirty(): boolean {
  if (!useEditorStore.getState().dirty) return true;
  // eslint-disable-next-line no-alert
  return window.confirm(
    'You have unsaved changes that will be lost.\n\nContinue anyway?',
  );
}
