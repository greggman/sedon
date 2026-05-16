import { useEffect, useState } from 'react';

// "Layout topology changed" signal — bumped by app.tsx whenever DockView
// fires events that can move a panel's DOM to a different document
// (popout open, popout close, group move). WebGPU canvases subscribe
// so they can unconfigure + reconfigure their GPUCanvasContext against
// the canvas's new ownerDocument.
//
// Why a counter, not a bare event? Hooks can compare it to a previous
// value via deps, so an effect re-runs on bump without us writing
// custom subscription glue at every call site.

let generation = 0;
const subscribers = new Set<() => void>();

export function bumpPopoutGeneration(): void {
  generation++;
  // Snapshot — subscribers may add/remove during dispatch.
  for (const cb of [...subscribers]) cb();
}

export function getPopoutGeneration(): number {
  return generation;
}

/**
 * React hook returning the current popout generation. The component
 * re-renders whenever it bumps. Add the returned number to a useEffect's
 * dep array (or use it as a `key` prop) to re-run setup after a popout.
 */
export function usePopoutGeneration(): number {
  const [g, setG] = useState(generation);
  useEffect(() => {
    const cb = () => setG(getPopoutGeneration());
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }, []);
  return g;
}
