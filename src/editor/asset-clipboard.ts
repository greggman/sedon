import { create } from 'zustand';
import type { AssetSelection } from './asset-ops.js';

// Cross-panel clipboard for cut/copy of asset selections. Lives outside
// the editor store because clipboard state is transient session UI —
// not part of the project content and not undoable. Both Cut and Copy
// stash the selected items here; Paste reads them, performs the right
// project mutation (a move for Cut, a deep-clone for Copy), then clears.
//
// Cut is non-destructive: items stay where they are and just get a
// dimmed visual treatment until paste lands or the clipboard is cleared.
// This avoids the "I cut these and then navigated away and they vanished"
// surprise, and means wrapper-node references stay intact until paste
// actually completes the move.
export type AssetClipboard =
  | {
      mode: 'cut';
      selection: AssetSelection;
    }
  | {
      mode: 'copy';
      selection: AssetSelection;
    }
  | null;

interface AssetClipboardStore {
  clipboard: AssetClipboard;
  setCut: (selection: AssetSelection) => void;
  setCopy: (selection: AssetSelection) => void;
  clear: () => void;
}

export const useAssetClipboardStore = create<AssetClipboardStore>((set) => ({
  clipboard: null,
  setCut: (selection) => set({ clipboard: { mode: 'cut', selection } }),
  setCopy: (selection) => set({ clipboard: { mode: 'copy', selection } }),
  clear: () => set({ clipboard: null }),
}));

// Imperative handle the AssetsPanel registers so command-palette
// commands can route to the panel without needing to thread refs
// through React. Only one panel is "active" at a time — the
// most-recently-interacted-with one wins, deregistering on unmount.
// Multiple AssetsPanels open at once: keyboard shortcuts still gate
// on DOM focus, but palette commands always target whichever was
// active last.
export interface AssetPanelHandle {
  performDelete(): void;
  performDuplicate(): void;
  performCut(): void;
  performCopy(): void;
  performPaste(): void;
  performSelectAll(): void;
}

let activeHandle: AssetPanelHandle | null = null;

export function setActiveAssetPanel(handle: AssetPanelHandle | null): void {
  activeHandle = handle;
}

export function getActiveAssetPanel(): AssetPanelHandle | null {
  return activeHandle;
}
