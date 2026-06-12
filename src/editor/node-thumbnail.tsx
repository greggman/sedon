import { useEffect, useMemo, useRef, useState } from 'react';
import { debug } from '../core/debug.js';
import { evaluateGraph } from '../core/evaluate.js';
import type { NodeDef, NodeOutputs, NodeRegistry } from '../core/node-def.js';
import type {
  GeometryValue,
  SceneValue,
  Texture2DValue,
} from '../core/resources.js';
import { createCoreNodeRegistry } from '../nodes/index.js';
import { MeshPreview } from './mesh-preview.js';
import { buildRegistry } from './registry.js';
import { ScenePreview } from './scene-preview.js';
import type { CameraState } from './store.js';
import { useEditorStore } from './store.js';
import { TexturePreview } from './texture-preview.js';

// Live thumbnail of a core node's sample graph, for the Nodes browser.
// Mirrors the docs-page preview policy so the Nodes-tab tiles look
// identical to what users see when they drill into a node's docs:
//
//   • Texture2D → flat 2D blit (TexturePreview)
//   • Geometry  → wireframe (MeshPreview, same as docs page)
//   • Scene     → auto-framed 3D scene (ScenePreview)
//   • Other types (Material, Float, Vec*, Path, …) → glyph fallback
//
// We deliberately picked the docs-style PER-OUTPUT scanner (find the
// first output that's previewable) rather than "first output only" so
// nodes with a numeric-then-geometry pair still surface a preview.
//
// Eligibility: `def.doc?.sampleGraph` must exist (we need a graph to
// run) and at least one declared output must be a previewable type.
// The expensive eval runs only when both pass.
//
// Caching strategy: each thumbnail does its own ephemeral eval — no
// shared cache with the project's working set. Sample graphs are tiny
// (~1ms eval), and isolating them keeps preview state cleanly
// separated from the user's editor cache.

const DEFAULT_THUMB_CAMERA: CameraState = {
  yaw: 0.5,
  pitch: 0.3,
  distance: 1, // overridden by ScenePreview's auto-frame.
  target: [0, 0, 0],
};

let coreRegistryCache: NodeRegistry | null = null;
function getSharedCoreRegistry(): NodeRegistry {
  if (!coreRegistryCache) coreRegistryCache = createCoreNodeRegistry();
  return coreRegistryCache;
}

// Type guards mirroring docs-sample-preview's set so the docs and the
// Nodes panel agree on what counts as previewable.
function isTexture2D(v: unknown): v is Texture2DValue {
  return typeof v === 'object' && v !== null && 'texture' in v && 'format' in v;
}
function isGeometry(v: unknown): v is GeometryValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    'positionBuffer' in v &&
    'indexCount' in v
  );
}
function isScene(v: unknown): v is SceneValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { entities?: unknown }).entities)
  );
}

type PreviewTarget =
  | { kind: 'texture'; value: Texture2DValue }
  | { kind: 'geometry'; value: GeometryValue }
  | { kind: 'scene'; value: SceneValue };

// Pick the first previewable output. Texture beats Geometry beats Scene
// — same priority the docs page uses. Returns null when no output has a
// renderable shape (the caller falls back to the glyph).
function previewTargetFor(outputs: NodeOutputs): PreviewTarget | null {
  for (const v of Object.values(outputs)) {
    if (isTexture2D(v)) return { kind: 'texture', value: v };
    if (isGeometry(v)) return { kind: 'geometry', value: v };
    if (isScene(v)) return { kind: 'scene', value: v };
  }
  return null;
}

// Eligibility check before eval: does the SAMPLE GRAPH's root node
// declare a previewable output? Not the host node's outputs — a
// branch/recursive node outputs BranchGraph, but its sample graph
// chains through branch/tube whose Geometry is what we actually want
// to render. The author already encoded the "what to preview" decision
// by picking `rootNodeId`; we just have to follow it.
const PREVIEWABLE_TYPES = new Set(['Texture2D', 'Geometry', 'Scene']);
function hasPreviewableOutput(def: NodeDef): boolean {
  if (!def.doc?.sampleGraph) return false;
  try {
    const sample = def.doc.sampleGraph();
    const rootNode = sample.graph.nodes.find((n) => n.id === sample.rootNodeId);
    if (!rootNode) return false;
    // Pull from the same registry the eval will use so we agree about
    // sample-graph subgraphs.
    const registry =
      sample.subgraphs && sample.subgraphs.length > 0
        ? buildRegistry(sample.subgraphs)
        : getSharedCoreRegistry();
    const rootDef = registry.get(rootNode.kind);
    if (!rootDef) return false;
    return rootDef.outputs.some((o) => PREVIEWABLE_TYPES.has(o.type));
  } catch {
    return false;
  }
}

interface NodeThumbnailProps {
  def: NodeDef;
  size: number;
  /** Rendered while the eval is in-flight, or when the node isn't previewable. */
  fallback: React.ReactNode;
}

export function NodeThumbnail({ def, size, fallback }: NodeThumbnailProps) {
  const device = useEditorStore((s) => s.device);
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  // Whether this tile has ever been in the viewport. Eval is gated on
  // this so a freshly-mounted Nodes panel (e.g. when the tab is hidden
  // in a dockview group, or scrolled off-screen in a long folder)
  // doesn't fire 100+ GPU evals on page load — which used to drown out
  // unrelated UI work on slower CI runners and time tests out. Once a
  // tile becomes visible it stays "armed" so scrolling back doesn't
  // re-trigger the eval.
  const [hasBeenVisible, setHasBeenVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const eligible = useMemo(() => hasPreviewableOutput(def), [def]);

  useEffect(() => {
    if (hasBeenVisible) return;
    const el = containerRef.current;
    if (!el) return;
    // IntersectionObserver with a small rootMargin pre-mounts the eval
    // a hair before the tile actually scrolls into view, so the swap
    // from glyph → preview happens before the user fixates on the
    // tile.
    if (typeof IntersectionObserver === 'undefined') {
      // No-op fallback for environments without IO — eval immediately.
      setHasBeenVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setHasBeenVisible(true);
            observer.disconnect();
            return;
          }
        }
      },
      { rootMargin: '100px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasBeenVisible]);

  useEffect(() => {
    if (!device || !eligible || !hasBeenVisible) {
      setTarget(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const sample = def.doc!.sampleGraph!();
        const registry =
          sample.subgraphs && sample.subgraphs.length > 0
            ? buildRegistry(sample.subgraphs)
            : getSharedCoreRegistry();
        const result = await evaluateGraph(sample.graph, registry, {
          rootNodeId: sample.rootNodeId,
          context: { device },
          // Some sample graphs ship deliberately under-wired (the docs
          // show the source; eval isn't the point). Their failures
          // should fall back to the glyph silently, not pollute the
          // global console.
          quiet: true,
        });
        if (cancelled) return;
        const next = previewTargetFor(result.outputs);
        if (next) setTarget(next);
      } catch (err) {
        debug(() => `NodeThumbnail "${def.id}": sample-graph eval failed: ${String(err)}`);
        if (!cancelled) setTarget(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [device, def, eligible, hasBeenVisible]);

  // Always wrap in a sized ref'd container so the IntersectionObserver
  // has a stable target even before the eval finishes. The fallback
  // (glyph + tint) shows through until the live preview is ready.
  if (!device || !target) {
    return (
      <div ref={containerRef} style={{ width: size, height: size, lineHeight: 0 }}>
        {fallback}
      </div>
    );
  }

  // lineHeight: 0 keeps the surrounding tile's text line-height from
  // leaving a sliver of whitespace under the canvas.
  if (target.kind === 'texture') {
    return (
      <div style={{ width: size, height: size, lineHeight: 0 }}>
        <TexturePreview device={device} value={target.value} size={size} />
      </div>
    );
  }
  if (target.kind === 'geometry') {
    // MeshPreview needs CPU-side mesh data to expand into triangles for
    // the barycentric wireframe trick. GPU-only geometries (e.g.
    // heightfield-to-mesh with cpu_access:false) can't be previewed —
    // fall back to the glyph rather than render a blank canvas.
    if (!target.value.mesh) return <>{fallback}</>;
    return (
      <div style={{ width: size, height: size, lineHeight: 0 }}>
        <MeshPreview device={device} geometry={target.value} />
      </div>
    );
  }
  // Scene
  return (
    <div style={{ width: size, height: size, lineHeight: 0 }}>
      <ScenePreview device={device} scene={target.value} camera={DEFAULT_THUMB_CAMERA} />
    </div>
  );
}
