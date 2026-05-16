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

interface AssetThumbnailProps {
  subgraphId: string;
  size: number;
  /** Fallback rendered while the eval is pending or no scene is available. */
  fallback: React.ReactNode;
}

export function AssetThumbnail({ subgraphId, size, fallback }: AssetThumbnailProps) {
  const device = useEditorStore((s) => s.device);
  const registry = useRegistry();
  const evalCache = useEditorStore((s) => s.evalCache);

  // Pull only what's stable for THIS subgraph. Without useShallow this
  // selector would re-emit whenever the subgraphs array reference
  // changed, retriggering eval on every unrelated store update.
  const target = useEditorStore(
    useShallow((s) => {
      const sg = s.subgraphs.find((x) => x.id === subgraphId);
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
    if (!device || !target) {
      setScene(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await evaluateGraph(target.graph, registry, {
          rootNodeId: target.rootNodeId,
          context: { device },
          cache: evalCache,
        });
        if (cancelled) return;
        const rootNode = target.graph.nodes.find((n) => n.id === target.rootNodeId);
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
  }, [device, target, registry, evalCache]);

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
