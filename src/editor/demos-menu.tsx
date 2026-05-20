import { useRef, useState } from 'react';
import { confirmDiscardIfDirty } from './confirm-dirty.js';
import { DEMOS } from './demos/index.js';
import { useDismiss } from './use-dismiss.js';
import { useEditorStore } from './store.js';

export function DemosMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDismiss(open, rootRef, () => setOpen(false));
  const setGraph = useEditorStore((s) => s.setGraph);

  const loadDemo = (id: string) => {
    const demo = DEMOS.find((d) => d.id === id);
    if (!demo) return;
    if (!confirmDiscardIfDirty()) {
      setOpen(false);
      return;
    }
    const { graph, rootNodeId, subgraphs, cameras } = demo.build();
    // setGraph bumps syncCounter, so every NodeCanvas re-syncs its RF
    // state from the new store graph + rebuilt registry. Each canvas's
    // own viewport effect handles fitView when no per-panel viewport
    // exists yet — we don't fitView from here because there's no
    // longer a single canvas to target. setGraph also resets the
    // layout-store's per-graph session state internally, so we don't
    // have to remember to do it here.
    setGraph(graph, rootNodeId, subgraphs, cameras);
    setOpen(false);
  };

  return (
    <div className="sedon-demos-menu" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="sedon-toolbar-button"
        title="Load a demo scene"
      >
        Demos ▾
      </button>
      {open && (
        <div className="sedon-menu-popup sedon-demos-popup">
          {DEMOS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => loadDemo(d.id)}
              className="sedon-menu-item sedon-demos-item"
            >
              {d.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
