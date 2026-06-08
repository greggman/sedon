// Copy / Paste / Save Selected / Save Subgraph / Merge — all five
// expressed as variations on "build a fragment" and "import a
// fragment." See `fragment.ts` for the underlying transforms; this
// file is the wiring between them and the editor stores / OS
// clipboard / file pickers.
//
// Source-of-selection convention: every action operates on the
// active canvas (the canvas whose React Flow instance lives behind
// `getActiveCanvasRf()`). That canvas may be editing the main graph
// or a subgraph; we read the live store's `graph` (which mirrors
// whichever editing context is current) and the RF instance's
// per-node `selected` flag to know what to act on.

import {
  buildFragment,
  buildSubgraphFragment,
  parseFragment,
  serializeFragment,
  importFragment,
  type Fragment,
} from './fragment.js';
import { getActiveCanvasEl, getActiveCanvasRf } from './rf-registry.js';
import { useEditorStore } from './store.js';

// ===== Copy / Paste =====================================================

/**
 * Copy nodes to the OS clipboard. When `ids` is omitted, copies the
 * active canvas's current RF selection; pass an explicit set to
 * copy just those nodes (e.g. the right-clicked node from the
 * canvas context menu, even when it isn't in the canvas selection).
 *
 * Returns `true` when something was written, `false` when the
 * resolved id set is empty. Throws on clipboard write failure —
 * clipboard.writeText can reject (insecure context, permission
 * denied) and the caller should surface that.
 */
export async function copySelection(ids?: ReadonlySet<string>): Promise<boolean> {
  const fragment = buildFragmentForIds(ids);
  if (!fragment) return false;
  await navigator.clipboard.writeText(serializeFragment(fragment));
  return true;
}

/**
 * Cut = copy then remove. Same id-set semantics as copySelection.
 */
export async function cutSelection(ids?: ReadonlySet<string>): Promise<boolean> {
  const resolved = ids ?? collectActiveCanvasSelection();
  if (!resolved || resolved.size === 0) return false;
  // Copy first so a clipboard-write failure doesn't leave the user
  // with a deleted selection and nothing to paste.
  const ok = await copySelection(resolved);
  if (!ok) return false;
  useEditorStore.getState().removeNodes(resolved);
  return true;
}

/**
 * Context-menu helper: returns the right set of node ids to operate
 * on given a right-clicked node id. If the node is already part of
 * the canvas selection (or no canvas selection exists yet),
 * preserves "operate on selection" semantics by returning the full
 * selection (or just the clicked node if no selection). If the
 * clicked node isn't in the selection, returns just the clicked
 * node — Finder-style "right-click-not-on-selection acts on that
 * one item alone."
 */
export function idsForRightClickedNode(nodeId: string): ReadonlySet<string> {
  const selection = collectActiveCanvasSelection();
  if (!selection || selection.size === 0) return new Set([nodeId]);
  if (selection.has(nodeId)) return selection;
  return new Set([nodeId]);
}

function collectActiveCanvasSelection(): Set<string> | undefined {
  const rf = getActiveCanvasRf();
  if (!rf) return undefined;
  const out = new Set<string>();
  for (const n of rf.getNodes()) {
    if (n.selected) out.add(n.id);
  }
  return out;
}

function buildFragmentForIds(ids?: ReadonlySet<string>): Fragment | undefined {
  const rf = getActiveCanvasRf();
  if (!rf) return undefined;
  let targetIds: Set<string>;
  if (ids !== undefined) {
    targetIds = new Set(ids);
  } else {
    targetIds = collectActiveCanvasSelection() ?? new Set();
  }
  if (targetIds.size === 0) return undefined;
  const state = useEditorStore.getState();
  return buildFragment(state.graph, targetIds, state.subgraphs);
}

/**
 * Read the OS clipboard, parse a fragment, and import it into the
 * active canvas's current graph at the active canvas's viewport
 * centre (so pasted nodes land where the user is looking, not stacked
 * on top of the originals in the source graph). Returns `true` when
 * nodes were pasted, `false` when the clipboard was empty or didn't
 * carry a fragment. Errors during parse / import propagate to the
 * caller so it can show a meaningful "not a Sedon fragment" alert.
 *
 * `opts.pasteAt` overrides the viewport-centre default — useful if a
 * future right-click "Paste here" wants to drop at the exact click
 * point.
 */
export async function pasteFromClipboard(opts?: {
  pasteAt?: { x: number; y: number };
  /**
   * Defaults to `reuse-deps` — the natural semantic for in-canvas
   * paste ("another reference to the thing I copied, sharing
   * dependencies"). The Edit ▸ Paste and Copy Deps command passes
   * `rename-all` to force a deep copy, and File ▸ Merge also passes
   * `rename-all` since cross-project imports can't safely assume the
   * target's same-id defs are content-compatible.
   */
  mode?: 'reuse-deps' | 'rename-primary' | 'rename-all';
}): Promise<boolean> {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    return false;
  }
  if (!text.trim()) return false;
  const fragment = parseFragment(text);
  const pasteAt = opts?.pasteAt ?? activeCanvasCentre();
  applyFragmentToActiveGraph(fragment, {
    mode: opts?.mode ?? 'reuse-deps',
    ...(pasteAt ? { pasteAt } : {}),
  });
  return true;
}

/**
 * Best-effort "where is the user looking" for the active canvas: the
 * canvas element's CSS-centre converted into graph-coord space via
 * React Flow's screen→flow projection. Returns undefined if there's
 * no active canvas (in which case the caller falls back to "leave
 * positions as-authored," which works for "Load File" and is fine
 * for an edge-case paste).
 */
function activeCanvasCentre(): { x: number; y: number } | undefined {
  const rf = getActiveCanvasRf();
  if (!rf) return undefined;
  // Find the canvas element belonging to this RF instance — RF
  // doesn't expose its host element directly, but the rf-registry
  // tracks it alongside the instance.
  const el = getActiveCanvasEl();
  if (!el) return undefined;
  const rect = el.getBoundingClientRect();
  return rf.screenToFlowPosition({
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  });
}

// ===== Save Selected / Save Subgraph ====================================

/**
 * Save the active canvas's selection to a `.sedon` file. Returns
 * `false` when nothing's selected (caller should no-op silently).
 */
export function saveSelectionToFile(): boolean {
  const fragment = buildFragmentForIds();
  if (!fragment) return false;
  downloadFragment(fragment, `sedon-selection-${timestamp()}.sedon`);
  return true;
}

/**
 * Save one subgraph definition + its transitive dependency closure
 * to a `.sedon` file. Importing this file later instantiates only
 * the subgraph defs (no wrapper) — the user can then drag the
 * subgraph in from the Assets view as usual.
 */
export function saveSubgraphToFile(subgraphId: string): boolean {
  const { subgraphs } = useEditorStore.getState();
  const fragment = buildSubgraphFragment(subgraphId, subgraphs);
  if (!fragment) return false;
  const def = subgraphs.find((s) => s.id === subgraphId);
  const name = def?.label ?? subgraphId;
  downloadFragment(fragment, `sedon-${slugify(name)}-${timestamp()}.sedon`);
  return true;
}

// ===== Merge ============================================================

/**
 * Open a file picker, parse a `.sedon` fragment, and merge it into
 * the active canvas's current graph. Same code path as Paste, just
 * sourced from disk instead of clipboard. Returns a promise that
 * resolves once the file dialog has been dismissed (with or without
 * a file).
 */
export function mergeFromFile(): Promise<void> {
  return new Promise<void>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.sedon';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(); return; }
      try {
        const text = await file.text();
        const fragment = parseFragment(text);
        // File merge: the source file might carry a `B` with the same
        // id but DIFFERENT content from the target's `B`. `rename-all`
        // keeps them separate; reusing would silently bind the
        // imported wrapper to a possibly-different existing def.
        applyFragmentToActiveGraph(fragment, { mode: 'rename-all' });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-alert
        alert(`Couldn't merge ${file.name}: ${msg}`);
      }
      resolve();
    };
    input.click();
  });
}

// ===== internals ========================================================


/**
 * Run a fragment through the importer (id remap + collision-renamed
 * subgraph defs) and hand the result to the store's
 * `mergeImportedFragment` action, which lands it as a single
 * undoable step in whatever graph the user is currently editing.
 */
function applyFragmentToActiveGraph(
  fragment: Fragment,
  opts?: import('./fragment.js').ImportFragmentOptions,
): void {
  const state = useEditorStore.getState();
  const existingIds = new Set(state.subgraphs.map((s) => s.id));
  // Destination graph's node ids — the importer uses these to resolve
  // incoming half-cut edges so an in-place duplicate stays wired to
  // its original upstream sources. For cross-project file merge the
  // overlap is empty and these edges silently drop, which is correct.
  const existingNodeIds = new Set(state.graph.nodes.map((n) => n.id));
  const imported = importFragment(fragment, existingIds, { ...opts, existingNodeIds });
  state.mergeImportedFragment(imported);
}

function downloadFragment(fragment: Fragment, filename: string): void {
  const json = serializeFragment(fragment);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function timestamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'subgraph';
}
