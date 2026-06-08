import { create } from 'zustand';

// Bus that lets the node-level context menu (which lives inside a
// CustomNode component) ask its enclosing canvas to open the
// AddNodePicker. The picker itself is mounted at the NodeCanvas
// level, so we can't just render it from inside CustomNode — too
// deep in the tree. The bus carries the request up.
//
// Same pattern as rename-bus: subscribers consume the request when
// they successfully act on it; requests persist across renders until
// consumed. Keyed by canvasPanelId so a request fired from inside one
// canvas doesn't accidentally pop the picker on a sibling canvas.

interface PickerRequest {
  canvasPanelId: string;
  screenX: number;
  screenY: number;
  flowX: number;
  flowY: number;
}

interface PickerBus {
  pending: PickerRequest | null;
  request: (req: PickerRequest) => void;
  consume: (canvasPanelId: string) => PickerRequest | null;
}

export const usePickerBus = create<PickerBus>((set, get) => ({
  pending: null,
  request: (req) => set({ pending: req }),
  consume: (canvasPanelId) => {
    const p = get().pending;
    if (!p || p.canvasPanelId !== canvasPanelId) return null;
    set({ pending: null });
    return p;
  },
}));

// Imperative helper for non-hook callers.
export function requestPicker(req: PickerRequest): void {
  usePickerBus.getState().request(req);
}
