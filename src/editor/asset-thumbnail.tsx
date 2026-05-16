import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { evaluateGraph } from '../core/evaluate.js';
import { defaultLighting, type SceneValue } from '../core/resources.js';
import { ScenePreview } from './scene-preview.js';
import { synthesizeTiles } from './preview-synth.js';
import { useRegistry } from './registry.js';
import { useEditorStore, type CameraState } from './store.js';

// Live thumbnail for a subgraph in the Asset view (icon-mode tiles).
// Re-uses the same eval pipeline the Preview pane uses, but stripped
// down: no camera UI, no tile grid, no cache sweep. The shared
// `evalCache` is used read-through so unchanged subgraphs hit cached
// results when other consumers (Preview, in-node thumbnails) have
// already evaluated them in this session.
//
// IMPORTANT: We deliberately do NOT call `sweepCache` here. The Preview
// pane is the cache owner; asset thumbnails are passive consumers. If
// thumbnails swept, they'd race the Preview's eval round and evict
// entries it relied on.

const DEFAULT_THUMB_CAMERA: CameraState = {
  yaw: 0.5,
  pitch: 0.3,
  // distance + target overridden per-scene by ScenePreview's auto-frame.
  distance: 1,
  target: [0, 0, 0],
};

export type ThumbnailTarget =
  | { kind: 'subgraph'; subgraphId: string }
  | { kind: 'main' };

interface AssetThumbnailProps {
  target: ThumbnailTarget;
  size: number;
  /** Fallback rendered while the eval is pending or no scene is available. */
  fallback: React.ReactNode;
}

export function AssetThumbnail({ target, size, fallback }: AssetThumbnailProps) {
  const device = useEditorStore((s) => s.device);
  const registry = useRegistry();
  const evalCache = useEditorStore((s) => s.evalCache);

  // Pull only what's stable for THIS asset. Without useShallow this
  // selector would re-emit whenever a sibling state slice changed,
  // retriggering eval on every unrelated store update.
  const resolved = useEditorStore(
    useShallow((s) => {
      if (target.kind === 'main') {
        // The store mutates mainGraph in place when editing main, so
        // useShallow detecting a new graph reference is what re-triggers
        // the eval. No version counter is needed.
        return { graph: s.mainGraph, rootNodeId: s.mainRootNodeId, version: 0 };
      }
      const sg = s.subgraphs.find((x) => x.id === target.subgraphId);
      if (!sg) return null;
      // Same root-resolution rule as the Preview pane: prefer a
      // user-authored core/output (so the subgraph author can frame
      // a preview the way they want) over the boundary output.
      const previewOutput = sg.graph.nodes.find((n) => n.kind === 'core/output');
      return {
        graph: sg.graph,
        rootNodeId: previewOutput?.id ?? sg.outputNodeId,
        version: sg.version ?? 0,
      };
    }),
  );

  const [scene, setScene] = useState<SceneValue | null>(null);

  useEffect(() => {
    if (!device || !resolved) {
      setScene(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await evaluateGraph(resolved.graph, registry, {
          rootNodeId: resolved.rootNodeId,
          context: { device },
          cache: evalCache,
        });
        if (cancelled) return;
        const rootNode = resolved.graph.nodes.find((n) => n.id === resolved.rootNodeId);
        const rootDef = rootNode ? registry.get(rootNode.kind) : undefined;
        const tiles = synthesizeTiles(device, rootDef, result.outputs, defaultLighting());
        // Pick the first tile that has any geometry to show — empty
        // scenes (unwired outputs) become a checkerboard, which is just
        // noise for a tiny tile.
        const next = tiles.find((t) => t.scene.entities.length > 0)?.scene;
        setScene(next ?? null);
      } catch {
        if (!cancelled) setScene(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [device, resolved, registry, evalCache]);

  if (!device || !scene) {
    return <>{fallback}</>;
  }
  return (
    <ScenePreview
      device={device}
      scene={scene}
      camera={DEFAULT_THUMB_CAMERA}
      size={size}
    />
  );
}
