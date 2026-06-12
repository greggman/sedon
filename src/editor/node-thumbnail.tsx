import { useEffect, useMemo, useState } from 'react';
import { evaluateGraph } from '../core/evaluate.js';
import type { NodeDef, NodeRegistry } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { createCoreNodeRegistry } from '../nodes/index.js';
import { useEditorStore } from './store.js';
import { TexturePreview } from './texture-preview.js';

// Live thumbnail of a core node's sample graph, for the Nodes browser.
// Mirrors AssetThumbnail's "eval the graph and render its output" shape,
// but specialised to the Texture2D case (which is the only output type
// that produces a meaningful at-a-glance preview from a default-input
// sample graph).
//
// Eligibility: the node must declare a `doc.sampleGraph` (otherwise
// we have nothing to render) AND its first output must be `Texture2D`.
// All texture/generators and texture/filters qualify; math, geom, point,
// scene, and iteration nodes fall back to the supplied glyph.
//
// Caching strategy: every thumbnail uses ITS OWN ephemeral eval — no
// shared cache with the project's working set. The sample graphs are
// tiny single-tex pipelines, so eval cost is negligible (~1ms), and a
// fresh-cache approach keeps preview state cleanly isolated from the
// user's editor cache (no risk of touching its sweep set, no
// fingerprint collisions with user-authored nodes).
//
// We DO share a single core-only NodeRegistry across all thumbnails
// since every sample graph only references core node kinds, and
// rebuilding 50× per Nodes-tab-open would just be waste.

let coreRegistryCache: NodeRegistry | null = null;
function getSharedCoreRegistry(): NodeRegistry {
  if (!coreRegistryCache) coreRegistryCache = createCoreNodeRegistry();
  return coreRegistryCache;
}

function firstOutputIsTexture(def: NodeDef): boolean {
  return def.outputs[0]?.type === 'Texture2D';
}

interface NodeThumbnailProps {
  def: NodeDef;
  size: number;
  /** Rendered while the eval is in-flight, or when the node isn't previewable. */
  fallback: React.ReactNode;
}

export function NodeThumbnail({ def, size, fallback }: NodeThumbnailProps) {
  const device = useEditorStore((s) => s.device);
  const [texValue, setTexValue] = useState<Texture2DValue | null>(null);

  // Eligibility is a property of the def itself, not of any state, so
  // memoize for the lifetime of the def — avoids retrying ineligible
  // nodes' "is sample graph there?" check on every render.
  const eligible = useMemo(
    () => Boolean(def.doc?.sampleGraph) && firstOutputIsTexture(def),
    [def],
  );

  useEffect(() => {
    if (!device || !eligible) {
      setTexValue(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const sample = def.doc!.sampleGraph!();
        const registry = getSharedCoreRegistry();
        const result = await evaluateGraph(sample.graph, registry, {
          rootNodeId: sample.rootNodeId,
          context: { device },
        });
        if (cancelled) return;
        const firstOutName = def.outputs[0]?.name;
        if (!firstOutName) return;
        const out = result.outputs[firstOutName] as Texture2DValue | undefined;
        if (out && out.texture) {
          setTexValue(out);
        }
      } catch (err) {
        // Sample graphs are author-tested; a failure here means a
        // regression the author should see during dev. In production
        // we silently fall back to the glyph.
        // eslint-disable-next-line no-console
        console.warn(`NodeThumbnail "${def.id}": sample-graph eval failed`, err);
        if (!cancelled) setTexValue(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [device, def, eligible]);

  if (!device || !texValue) return <>{fallback}</>;
  return (
    <div style={{ width: size, height: size, lineHeight: 0 }}>
      <TexturePreview device={device} value={texValue} size={size} />
    </div>
  );
}
