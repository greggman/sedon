import { useReactFlow } from '@xyflow/react';
import { useRef, useState } from 'react';
import { AddNodePicker } from './add-node-picker.js';

interface AddNodeMenuProps {
  // Ref to the container that hosts both the canvas and this menu, so we can
  // map "viewport center" to flow coordinates for the new node's position.
  canvasRef: React.RefObject<HTMLElement | null>;
}

// Toolbar "+ Add Node" button — a thin wrapper around the shared
// AddNodePicker. The button anchors the popup just below itself, and
// the new node lands at the canvas's visible center. The canvas
// right-click context menu uses the same picker but with the click
// position passing through instead.
export function AddNodeMenu({ canvasRef }: AddNodeMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const rf = useReactFlow();
  const [open, setOpen] = useState<{
    anchorX: number;
    anchorY: number;
    flowX: number;
    flowY: number;
  } | null>(null);

  const openPicker = () => {
    if (open) {
      setOpen(null);
      return;
    }
    const btn = buttonRef.current;
    const canvas = canvasRef.current;
    if (!btn || !canvas) return;
    const br = btn.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const centerScreen = { x: cr.left + cr.width / 2, y: cr.top + cr.height / 2 };
    const flow = rf.screenToFlowPosition(centerScreen);
    setOpen({
      anchorX: br.left,
      anchorY: br.bottom + 4,
      flowX: flow.x,
      flowY: flow.y,
    });
  };

  return (
    <div className="sedon-add-node-menu">
      <button
        ref={buttonRef}
        type="button"
        onClick={openPicker}
        className="sedon-toolbar-button"
      >
        + Add Node
      </button>
      {open && (
        <AddNodePicker
          anchorX={open.anchorX}
          anchorY={open.anchorY}
          flowX={open.flowX}
          flowY={open.flowY}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
