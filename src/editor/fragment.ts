// Fragment serializer — the on-wire payload that backs Copy, Paste,
// Save Selected, Save Subgraph, and Merge.
//
// A fragment is a self-contained slice of a project. It carries:
//   • A set of GRAPH NODES (the user's selection, or one subgraph's
//     boundary set).
//   • The EDGES between them where BOTH endpoints are inside the
//     selection (half-cut edges are dropped — they'd dangle on import).
//   • The TRANSITIVE CLOSURE of subgraph DEFINITIONS referenced by
//     any wrapper node in the selection. Without this a pasted
//     `subgraph/branch-canopy` wrapper would land in a project that
//     has no canopy def and the wrapper would fail to evaluate.
//
// Fragments are version-stamped JSON with a magic key (`sedonFragment`)
// so a stray clipboard read (someone copied a Stack Overflow snippet)
// gets rejected cleanly instead of trying to interpret arbitrary JSON
// as a graph fragment.
//
// IDs in a fragment are the ORIGINAL ids from the source project. The
// importer (built next) is what remaps them — that lets paste-twice
// produce two independent sets without coordinating with the
// serializer, and lets a fragment be saved to disk + opened later
// against a project where conflicting ids may already exist.

import type { Graph, GraphEdge, GraphNode } from '../core/graph.js';
import type { SubgraphDef } from '../core/subgraph.js';
import { isSubgraphInstanceKind, subgraphIdFromKind } from '../core/subgraph.js';

export const FRAGMENT_FORMAT_VERSION = 1;

/**
 * The on-wire shape. Same JSON either way it's transported — OS
 * clipboard, file on disk, drag-drop payload, network transfer.
 *
 * `bbox` records the source nodes' bounding box so the importer can
 * lay them down centred on the paste cursor (instead of stacking on
 * top of the originals, which is what "paste at original positions"
 * silently does 90% of the time).
 */
export interface Fragment {
  sedonFragment: typeof FRAGMENT_FORMAT_VERSION;
  bbox: { x: number; y: number; w: number; h: number };
  nodes: GraphNode[];
  edges: GraphEdge[];
  subgraphs: SubgraphDef[];
  /**
   * Subset of `subgraphs` that were the user's explicit selection
   * (vs. pulled in transitively as dependencies). Drives the
   * `rename-primary` import mode: those defs are always renamed on
   * collision (the user asked for "a new copy of THIS"), while
   * deps reuse the target's existing defs by id.
   *
   * Empty/absent for graph-node-selection fragments (where nothing is
   * explicitly "primary" — the user copied wrapper instances, and
   * every accompanying def is a transitive reference). Populated by
   * `buildSubgraphFragment` with the saved def's id.
   */
  primarySubgraphIds?: string[];
}

/**
 * Build a fragment from a selection of nodes in some source graph,
 * plus the project's full subgraph registry (so we can resolve and
 * walk wrapper dependencies).
 *
 * `selectedIds` is the user's selection in `sourceGraph`. Edges are
 * filtered to those with both endpoints in the selection. Subgraph
 * defs referenced (transitively) by any selected wrapper are pulled
 * out of `allSubgraphs` and included verbatim.
 *
 * Returns undefined when the selection is empty (callers should treat
 * "nothing to copy" as a no-op rather than producing a zero-node
 * fragment).
 */
export function buildFragment(
  sourceGraph: Graph,
  selectedIds: ReadonlySet<string>,
  allSubgraphs: ReadonlyArray<SubgraphDef>,
): Fragment | undefined {
  if (selectedIds.size === 0) return undefined;

  // Nodes: keep selection order from the source graph so the
  // resulting fragment is reproducible (same selection → same JSON
  // bytes regardless of Set iteration order).
  const nodes: GraphNode[] = [];
  for (const n of sourceGraph.nodes) {
    if (selectedIds.has(n.id)) nodes.push(deepCloneNode(n));
  }
  if (nodes.length === 0) return undefined;

  // Edges to carry:
  //   • Internal: both endpoints in the selection.
  //   • Incoming half-cut: source OUTSIDE the selection, target inside.
  //     We keep these so an in-place duplicate stays wired to the same
  //     upstream nodes. The importer resolves the un-remapped `from.node`
  //     against the destination graph; if no match, the edge is dropped.
  // Outgoing half-cut edges (source inside, target outside) are NOT
  // carried — reconnecting them would silently fan-out the original
  // node's output to a second consumer, which is rarely what the user
  // wants.
  const edges: GraphEdge[] = [];
  for (const e of sourceGraph.edges) {
    if (selectedIds.has(e.to.node)) {
      edges.push({ id: e.id, from: { ...e.from }, to: { ...e.to } });
    }
  }

  // Transitive closure of subgraph defs. Seed with the wrappers in the
  // selection, then for each def's inner graph, scan its wrappers and
  // add those defs too. BFS with a visited set to handle the (legal)
  // case of subgraphs referencing each other through nesting.
  const subgraphs = collectSubgraphClosure(nodes, allSubgraphs);

  return {
    sedonFragment: FRAGMENT_FORMAT_VERSION,
    bbox: computeBbox(nodes),
    nodes,
    edges,
    subgraphs,
  };
}

/**
 * Build a fragment that captures one subgraph DEFINITION (and its
 * transitive deps) — the payload behind File ▸ Save Subgraph. The
 * resulting fragment has NO root nodes / edges; importing it adds the
 * subgraph defs to the project's registry without instantiating
 * anything in the current graph. Callers that want to also drop a
 * wrapper at the cursor should layer that on top.
 */
export function buildSubgraphFragment(
  defId: string,
  allSubgraphs: ReadonlyArray<SubgraphDef>,
): Fragment | undefined {
  const root = allSubgraphs.find((s) => s.id === defId);
  if (!root) return undefined;
  const subgraphs = collectSubgraphClosureFromDef(root, allSubgraphs);
  return {
    sedonFragment: FRAGMENT_FORMAT_VERSION,
    bbox: { x: 0, y: 0, w: 0, h: 0 },
    nodes: [],
    edges: [],
    subgraphs,
    // The saved def is "primary" — its dependency closure rides along
    // but the importer's rename-primary mode is what produces "A.1
    // referencing the target's existing B" rather than "A.1 + B.1".
    primarySubgraphIds: [defId],
  };
}

/**
 * Build a fragment that INSTANTIATES one or more subgraphs as wrapper
 * nodes — the payload behind copying assets from the Assets panel and
 * pasting them onto a canvas. Same end state as the user dragging
 * each asset onto the canvas, just bundled into a single Fragment
 * round-trip (which means OS-clipboard + .sedon-save also work).
 *
 * Each id in `defIds` becomes a `subgraph/<id>` wrapper node with a
 * fresh uuid; positions are laid out in a horizontal row at the
 * origin so the import path can re-anchor them to the paste cursor
 * via the standard bbox-centred logic. The transitive closure of
 * subgraph defs is included so the paste succeeds in a project that
 * doesn't already have the referenced defs.
 *
 * Returns undefined when `defIds` is empty or none of them resolve
 * against `allSubgraphs` (caller treats as a no-op).
 */
export function buildAssetInstancesFragment(
  defIds: ReadonlyArray<string>,
  allSubgraphs: ReadonlyArray<SubgraphDef>,
): Fragment | undefined {
  const knownIds = new Set(allSubgraphs.map((s) => s.id));
  const nodes: GraphNode[] = [];
  const SPACING = 240;
  let x = 0;
  for (const defId of defIds) {
    if (!knownIds.has(defId)) continue;
    nodes.push({
      id: `paste-${defId}-${nodes.length}`,
      kind: `subgraph/${defId}`,
      position: { x, y: 0 },
    });
    x += SPACING;
  }
  if (nodes.length === 0) return undefined;
  const subgraphs = collectSubgraphClosure(nodes, allSubgraphs);
  return {
    sedonFragment: FRAGMENT_FORMAT_VERSION,
    bbox: computeBbox(nodes),
    nodes,
    edges: [],
    subgraphs,
  };
}

/** Serialize to the canonical JSON form. Used by clipboard write + file save. */
export function serializeFragment(fragment: Fragment): string {
  return JSON.stringify(fragment);
}

/**
 * Parse a JSON blob and validate it really is a fragment. Returns the
 * parsed Fragment on success; throws with a human-readable error on
 * anything malformed — wrong version, missing magic key, broken
 * shape, etc.
 *
 * Defensive on purpose: paste payloads come from the OS clipboard
 * (could be anything the user copied last) and from disk (could be
 * any `.sedon` file the user grabbed from a forum). Reject with a
 * useful message rather than crashing the import path.
 */
export function parseFragment(text: string): Fragment {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`fragment is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('fragment must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.sedonFragment !== FRAGMENT_FORMAT_VERSION) {
    throw new Error(
      `not a Sedon fragment (expected sedonFragment=${FRAGMENT_FORMAT_VERSION}, got ${JSON.stringify(obj.sedonFragment)})`,
    );
  }
  if (!Array.isArray(obj.nodes)) throw new Error('fragment.nodes must be an array');
  if (!Array.isArray(obj.edges)) throw new Error('fragment.edges must be an array');
  if (!Array.isArray(obj.subgraphs)) throw new Error('fragment.subgraphs must be an array');
  const bbox = obj.bbox as Record<string, unknown> | undefined;
  if (
    !bbox ||
    typeof bbox.x !== 'number' || typeof bbox.y !== 'number' ||
    typeof bbox.w !== 'number' || typeof bbox.h !== 'number'
  ) {
    throw new Error('fragment.bbox must be {x,y,w,h} of numbers');
  }
  // We don't deep-validate node / edge / subgraph shapes here — the
  // importer normalizes whatever it reads (defaults missing fields,
  // skips broken entries with a warning). Saves us from duplicating
  // the existing parseSubgraphDef etc. validators.
  return obj as unknown as Fragment;
}

// ===== importing =========================================================

/**
 * Result of materialising a fragment against a target project.
 *
 * The caller is responsible for atomically merging this into the
 * editor store (push `nodes` + `edges` onto the destination graph,
 * push `subgraphs` onto the project's subgraph list). The importer
 * doesn't touch any store directly — it's a pure data transform, so
 * it composes with undo/redo, dispatchProject, headless tests, etc.
 */
export interface ImportedFragment {
  nodes: GraphNode[];
  edges: GraphEdge[];
  subgraphs: SubgraphDef[];
}

/**
 * How collisions on incoming subgraph def ids are resolved.
 *
 *   • `reuse-deps`: an incoming def whose id is already in the target
 *      is SKIPPED. Wrapper nodes that referenced it keep their original
 *      `kind` and bind to the target's existing def. Right behaviour
 *      for canvas-clipboard paste — "make another reference to the
 *      thing I just copied, sharing dependencies."
 *
 *   • `rename-primary`: only defs in the fragment's `primarySubgraphIds`
 *      are renamed on collision; dependency defs are reused (same rule
 *      as `reuse-deps`). Right behaviour for Assets-panel paste of a
 *      single subgraph — "duplicate this asset; share its dependencies."
 *
 *   • `rename-all`: every collision renames to `.1`, `.2`, …, including
 *      transitive deps. Right behaviour for File ▸ Merge (the source
 *      file might carry a *different* B than the target's B; safest to
 *      keep them separate) and for any explicit "Paste and Copy Deps"
 *      command.
 */
export type ImportMode = 'reuse-deps' | 'rename-primary' | 'rename-all';

export interface ImportFragmentOptions {
  /**
   * Where to place the centre of the imported nodes' bbox in the
   * destination graph's coordinate space. When omitted, nodes land
   * at their original source-graph positions — fine for "Load File"
   * which has no cursor concept, terrible for "Paste" which would
   * stack pastes on top of each other.
   */
  pasteAt?: { x: number; y: number };
  /**
   * Collision-resolution strategy for incoming subgraph def ids. See
   * {@link ImportMode}. Defaults to `rename-all` — safest for the
   * cross-project / file-merge case where the caller hasn't thought
   * about the trade-off yet.
   */
  mode?: ImportMode;
  /**
   * Node ids that already exist in the destination graph. Used to
   * resolve INCOMING half-cut edges: when a fragment edge's `from.node`
   * isn't a fragment node (it referred to something outside the source
   * selection) AND that id exists in this set, the edge is wired up to
   * the destination's existing node. Otherwise it's dropped silently.
   *
   * Omit (or pass an empty set) for cross-project imports where the
   * destination has no overlap with the source — every half-cut edge
   * drops, which is the right behaviour for file merge / paste-into-
   * different-graph.
   */
  existingNodeIds?: ReadonlySet<string>;
}

/**
 * Materialise a fragment against a target project. Returns fresh
 * objects with new ids; the original fragment is untouched (so the
 * same fragment can be imported repeatedly to produce independent
 * copies).
 *
 * Id strategy:
 *   - Every graph NODE id is regenerated. Paste-twice produces two
 *     independent sets with no coordination between calls.
 *   - SUBGRAPH DEF ids are kept when they don't collide with an
 *     existing project def; renamed with `.1`, `.2`, … suffix on
 *     collision. Wrapper `kind` fields are rewritten to point at
 *     whatever id their def landed at — both the wrappers in the
 *     imported top-level nodes AND any wrappers inside imported
 *     subgraph defs' inner graphs.
 *
 * Rejected design: deep-compare existing vs incoming defs and reuse
 * matching ones. The compare surface is fragile (do positions count?
 * versions? folder metadata?) and the user-visible failure mode of
 * "your custom canopy got silently replaced by the stock one" is much
 * worse than "your import landed as branch-canopy.1 — rename if you
 * want." A future "Replace existing / Use existing" prompt UI can
 * layer on top without touching this transform.
 */
export function importFragment(
  fragment: Fragment,
  existingSubgraphIds: ReadonlySet<string>,
  options?: ImportFragmentOptions,
): ImportedFragment {
  const mode: ImportMode = options?.mode ?? 'rename-all';
  const primary = new Set(fragment.primarySubgraphIds ?? []);

  // Step 0: node id remap. Built up front because bridges are tied to
  // specific for-each-point nodes — when the node id changes, the
  // bridge's id (`bridge-<nodeId>` convention) and the for-each
  // node's `__bridgeId` inputValue both need to follow.
  const nodeIdRemap = new Map<string, string>();
  for (const n of fragment.nodes) {
    nodeIdRemap.set(n.id, freshId());
  }

  // Step 1: per-def decision — keep the original id (and skip adding
  // the def if it already exists in the target), or rename to dodge a
  // collision. Build the full id remap up front so cross-references
  // among incoming defs resolve consistently in step 2.
  //
  // Bridges (defs marked `owner.kind === 'iteration-bridge'`) follow
  // a tighter rename rule than user-authored subgraphs: the bridge id
  // must always derive from the owner for-each-point's CURRENT node
  // id, so the convention `bridge-<nodeId>` holds even when the
  // owning node was renamed during step 0. Mode flags don't apply —
  // a bridge with no surviving owner in the import is dropped.
  //
  // "Skip" is the signal that a wrapper kind referencing this def
  // should bind to the TARGET's existing def with that id (no rewrite
  // needed, the kind already says `subgraph/<id>`). We track the set
  // of skipped ids so step 2's def-rewrite loop knows to leave them
  // out of the import payload.
  const usedIds = new Set(existingSubgraphIds);
  const defRename = new Map<string, string>(); // old id → final id
  const skippedIds = new Set<string>();        // defs reused-from-target, not imported
  const ownerNodeRemap = new Map<string, string>(); // old bridge id → new owner nodeId
  for (const sg of fragment.subgraphs) {
    if (sg.owner?.kind === 'iteration-bridge') {
      const newOwnerNodeId = nodeIdRemap.get(sg.owner.nodeId);
      if (newOwnerNodeId === undefined) {
        // Owner for-each-point isn't part of this fragment — orphan
        // bridge. Drop it (skipping registers it as "don't emit");
        // the import wouldn't be useful without the owning node.
        skippedIds.add(sg.id);
        continue;
      }
      const newBridgeId = `bridge-${newOwnerNodeId}`;
      defRename.set(sg.id, newBridgeId);
      ownerNodeRemap.set(sg.id, newOwnerNodeId);
      usedIds.add(newBridgeId);
      continue;
    }
    const collides = existingSubgraphIds.has(sg.id);
    const shouldRename =
      mode === 'rename-all' ||
      (mode === 'rename-primary' && primary.has(sg.id));
    if (!collides) {
      // No id conflict — bring the def in under its original id.
      defRename.set(sg.id, sg.id);
      usedIds.add(sg.id);
    } else if (shouldRename) {
      const newId = uniquifyId(sg.id, usedIds);
      defRename.set(sg.id, newId);
      usedIds.add(newId);
    } else {
      // Reuse the target's existing def. Wrapper kinds keep the
      // original id; we just won't add a (duplicate) def to the
      // project's subgraph list.
      defRename.set(sg.id, sg.id);
      skippedIds.add(sg.id);
    }
  }

  // Step 2: rewrite + emit subgraph defs. Skipped defs are dropped
  // from the output. Their inner graphs may reference OTHER defs that
  // got renamed in the same batch (a tree-canopy whose inner uses a
  // bark-texture that just became bark-texture.1), so still walk the
  // rename map for the surviving defs.
  const subgraphs: SubgraphDef[] = [];
  for (const sg of fragment.subgraphs) {
    if (skippedIds.has(sg.id)) continue;
    const nextId = defRename.get(sg.id) ?? sg.id;
    const emitted: SubgraphDef = {
      ...sg,
      id: nextId,
      graph: {
        ...sg.graph,
        // Bridge boundary-node kinds embed the bridge's id
        // (`subgraph-input/<bridgeId>`, etc.). When the bridge gets
        // a new id, those embedded ids must update too — otherwise
        // the boundary nodes reference a registry kind that no
        // longer matches the bridge.
        nodes: sg.graph.nodes.map((n) => {
          const rewrittenKind = rewriteBoundaryKindForBridge(n.kind, sg.id, nextId);
          const remapped = remapWrapperKind(
            rewrittenKind === n.kind ? n : { ...n, kind: rewrittenKind },
            defRename,
          );
          return remapped;
        }),
        edges: sg.graph.edges.map((e) => ({ ...e, from: { ...e.from }, to: { ...e.to } })),
      },
    };
    // Patch the bridge's owner.nodeId to the imported for-each-point's
    // new node id, and update inputNodeId / outputNodeId references
    // (these point to specific nodes inside sg.graph and survived the
    // node clone above unchanged).
    const newOwnerNodeId = ownerNodeRemap.get(sg.id);
    if (newOwnerNodeId !== undefined && emitted.owner) {
      emitted.owner = { kind: 'iteration-bridge', nodeId: newOwnerNodeId };
    }
    subgraphs.push(emitted);
  }
  const dx = options?.pasteAt
    ? options.pasteAt.x - (fragment.bbox.x + fragment.bbox.w / 2)
    : 0;
  const dy = options?.pasteAt
    ? options.pasteAt.y - (fragment.bbox.y + fragment.bbox.h / 2)
    : 0;
  const nodes: GraphNode[] = fragment.nodes.map((n) => {
    const remapped = remapWrapperKind(n, defRename);
    const out: GraphNode = { ...remapped, id: nodeIdRemap.get(n.id)! };
    if (remapped.position) {
      out.position = { x: remapped.position.x + dx, y: remapped.position.y + dy };
    }
    // for-each-point's `__bridgeId` references its owned bridge,
    // whose id we just renamed to `bridge-<newNodeId>` above. Patch
    // the inputValue to match — otherwise the imported for-each
    // would point at the OLD bridge id and fail to look up its body.
    if (out.kind === 'core/for-each-point' && out.inputValues?.__bridgeId !== undefined) {
      const newBridgeId = `bridge-${out.id}`;
      out.inputValues = { ...out.inputValues, __bridgeId: newBridgeId };
    }
    return out;
  });

  // Step 4: edges. Target endpoint must be one of the imported nodes
  // (by construction — buildFragment only carries edges whose `to` is
  // in the selection). Source endpoint is either:
  //   • another imported node (internal edge) → remap to its new id.
  //   • a node OUTSIDE the source selection (incoming half-cut edge) →
  //     wire to that same id in the destination IF it exists there
  //     (same-graph paste); drop otherwise (cross-graph paste).
  const existingNodeIds = options?.existingNodeIds;
  const edges: GraphEdge[] = [];
  for (const e of fragment.edges) {
    const to = nodeIdRemap.get(e.to.node);
    if (!to) continue;
    let fromId: string | undefined;
    const remappedFrom = nodeIdRemap.get(e.from.node);
    if (remappedFrom) {
      fromId = remappedFrom;
    } else if (existingNodeIds?.has(e.from.node)) {
      fromId = e.from.node;
    }
    if (!fromId) continue;
    edges.push({
      id: freshId(),
      from: { node: fromId, socket: e.from.socket },
      to: { node: to, socket: e.to.socket },
    });
  }

  return { nodes, edges, subgraphs };
}

/**
 * Return an id that doesn't collide with `used`. If `desired` is
 * free, returns it unchanged. Otherwise appends `.1`, `.2`, … until
 * a free slot is found. Stable: same `(desired, used)` always
 * produces the same result, so re-importing the same fragment into
 * the same project gives the same renames.
 */
function uniquifyId(desired: string, used: ReadonlySet<string>): string {
  if (!used.has(desired)) return desired;
  for (let i = 1; ; i++) {
    const candidate = `${desired}.${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

function freshId(): string {
  return crypto.randomUUID();
}

// Rewrite a node's `kind` if it's a subgraph wrapper whose target
// def got renamed. Non-wrapper nodes pass through unchanged. Returns
// a shallow-cloned node so callers can keep mutating without affecting
// the input.
// Rewrite a boundary node's kind when its parent bridge gets renamed
// during import. Boundary kinds embed the bridge id directly —
// `subgraph-input/<bridgeId>`, `iteration-input/<bridgeId>`, etc. —
// so the embedded id has to track the bridge's new id, otherwise the
// boundary node references a registry kind that no longer matches.
// Non-boundary nodes (and boundaries belonging to unrelated
// subgraphs) pass through unchanged.
function rewriteBoundaryKindForBridge(kind: string, oldBridgeId: string, newBridgeId: string): string {
  if (oldBridgeId === newBridgeId) return kind;
  const prefixes = ['subgraph-input/', 'subgraph-output/', 'iteration-input/', 'iteration-output/'];
  for (const p of prefixes) {
    if (kind === `${p}${oldBridgeId}`) return `${p}${newBridgeId}`;
  }
  return kind;
}

function remapWrapperKind(node: GraphNode, defRename: Map<string, string>): GraphNode {
  if (!isSubgraphInstanceKind(node.kind)) return { ...node };
  const oldDefId = subgraphIdFromKind(node.kind);
  if (!oldDefId) return { ...node };
  const newDefId = defRename.get(oldDefId);
  if (!newDefId || newDefId === oldDefId) return { ...node };
  return { ...node, kind: `subgraph/${newDefId}` };
}

// ===== helpers ==========================================================

function deepCloneNode(n: GraphNode): GraphNode {
  // Shallow-spread the node + copy the maybe-present object fields so
  // mutating an imported fragment can't write through to the source
  // graph. Omit fields entirely when they're missing on the source —
  // matches what JSON.stringify/parse round-trips to, so the
  // round-trip equality test holds.
  const out: GraphNode = { id: n.id, kind: n.kind };
  if (n.name !== undefined) out.name = n.name;
  if (n.position) out.position = { ...n.position };
  if (n.inputValues) out.inputValues = { ...n.inputValues };
  if (n.extraInputs) out.extraInputs = n.extraInputs.map((i) => ({ ...i }));
  return out;
}

function computeBbox(nodes: GraphNode[]): Fragment['bbox'] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const p = n.position;
    if (!p) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// BFS the subgraph dependency tree starting from any wrappers in
// `seedNodes`. Returns the unique defs in stable seed order so a
// re-serialize of the same selection produces identical bytes.
//
// Two reference kinds the walker follows:
//   • Wrapper-instance kinds (`subgraph/<id>`) — standard subgraph
//     references via a node's `kind`.
//   • For-each-point bridges — referenced by `__bridgeId` on a
//     `core/for-each-point` node's inputValues. Bridges are private
//     to their owning node so they must travel with it; without
//     this, copy-pasting a for-each-point would lose its iteration
//     wiring on the import side.
function collectSubgraphClosure(
  seedNodes: ReadonlyArray<GraphNode>,
  allSubgraphs: ReadonlyArray<SubgraphDef>,
): SubgraphDef[] {
  const byId = new Map(allSubgraphs.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const ordered: SubgraphDef[] = [];
  const queue: string[] = [];
  const enqueueRefsFromNode = (n: GraphNode): void => {
    if (isSubgraphInstanceKind(n.kind)) {
      const id = subgraphIdFromKind(n.kind);
      if (id && !visited.has(id)) {
        visited.add(id);
        queue.push(id);
      }
    }
    if (n.kind === 'core/for-each-point') {
      const bridgeId = n.inputValues?.__bridgeId;
      if (typeof bridgeId === 'string' && bridgeId !== '' && !visited.has(bridgeId)) {
        visited.add(bridgeId);
        queue.push(bridgeId);
      }
    }
  };
  for (const n of seedNodes) enqueueRefsFromNode(n);
  while (queue.length > 0) {
    const id = queue.shift()!;
    const def = byId.get(id);
    if (!def) {
      // A wrapper referenced a def that doesn't exist in the project
      // (broken state). Skip — the importer will fail validation when
      // it sees the wrapper kind and no matching def, with a clearer
      // error than we could produce here.
      continue;
    }
    ordered.push(def);
    // Bridges have body wrappers inside; walking those pulls the body
    // subgraph def along as a transitive dependency.
    for (const inner of def.graph.nodes) enqueueRefsFromNode(inner);
  }
  return ordered;
}

// Same as collectSubgraphClosure but seeded from a single def rather
// than a node selection. Used by buildSubgraphFragment (Save Subgraph).
function collectSubgraphClosureFromDef(
  root: SubgraphDef,
  allSubgraphs: ReadonlyArray<SubgraphDef>,
): SubgraphDef[] {
  // Reuse the node-seeded walker by feeding it a synthetic seed list
  // consisting of one wrapper kind pointing at the root def. Avoids
  // duplicating the BFS loop.
  const seedNode: GraphNode = { id: '__seed__', kind: `subgraph/${root.id}` };
  return collectSubgraphClosure([seedNode], allSubgraphs);
}
