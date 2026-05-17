import type { Folder } from '../core/folder.js';
import type { Graph, GraphNode } from '../core/graph.js';
import type { SubgraphDef } from '../core/subgraph.js';

// A mixed selection of subgraphs + folders, used as the input shape for
// every multi-asset operation (delete, duplicate, move, paste). Order is
// not significant; both lists are de-duplicated by the store before use.
export interface AssetSelection {
  subgraphIds: string[];
  folderIds: string[];
}

// Drop subgraphs whose parent chain leads to a selected folder, and
// folders nested inside another selected folder. The user-visible
// behavior of "delete this folder + everything inside" is the same
// whether they explicitly selected the children or not — pruning makes
// the implementation consistent regardless.
export function pruneNestedSelection(
  selection: AssetSelection,
  folders: ReadonlyArray<Folder>,
  subgraphs: ReadonlyArray<SubgraphDef>,
): AssetSelection {
  const selectedFolders = new Set(selection.folderIds);
  if (selectedFolders.size === 0) {
    return {
      subgraphIds: [...new Set(selection.subgraphIds)],
      folderIds: [],
    };
  }
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const isInsideSelected = (parentFolderId: string | null | undefined): boolean => {
    let cursor = parentFolderId ?? null;
    while (cursor !== null) {
      if (selectedFolders.has(cursor)) return true;
      const f = folderById.get(cursor);
      cursor = f?.parentFolderId ?? null;
    }
    return false;
  };
  const subgraphById = new Map(subgraphs.map((s) => [s.id, s]));
  return {
    subgraphIds: [...new Set(selection.subgraphIds)].filter((id) => {
      const sg = subgraphById.get(id);
      return sg !== undefined && !isInsideSelected(sg.parentFolderId);
    }),
    folderIds: [...new Set(selection.folderIds)].filter((id) => {
      const f = folderById.get(id);
      return f !== undefined && !isInsideSelected(f.parentFolderId);
    }),
  };
}

// Count wrapper-node references that would break if every subgraph in
// `ids` were removed. Scans the main graph and every other subgraph's
// inner graph for nodes whose `kind` is `subgraph/<id>` for an `id` in
// the set. Returns `refs` (wrapper nodes pointing in) and `graphs`
// (distinct graphs containing such wrappers). Used by the delete-confirm
// dialog so the user knows the blast radius before proceeding.
export function countBrokenRefs(
  ids: ReadonlySet<string>,
  mainGraph: Graph,
  subgraphs: ReadonlyArray<SubgraphDef>,
): { refs: number; graphs: number } {
  if (ids.size === 0) return { refs: 0, graphs: 0 };
  let refs = 0;
  let graphsTouched = 0;
  const scan = (graph: Graph): boolean => {
    let touched = false;
    for (const node of graph.nodes) {
      if (!node.kind.startsWith('subgraph/')) continue;
      const refId = node.kind.slice('subgraph/'.length);
      if (ids.has(refId)) {
        refs++;
        touched = true;
      }
    }
    return touched;
  };
  if (scan(mainGraph)) graphsTouched++;
  for (const sg of subgraphs) {
    // Skip subgraphs being deleted themselves — their inner graphs are
    // also going away, so wrappers inside them aren't "broken" anywhere
    // the user can see.
    if (ids.has(sg.id)) continue;
    if (scan(sg.graph)) graphsTouched++;
  }
  return { refs, graphs: graphsTouched };
}

// Generate "Foo copy" / "Foo copy 2" / … against the labels already in
// use within the destination parent folder. Capped to avoid runaway
// loops on pathological label sets; falls back to a UUID suffix.
export function nextCopyLabel(existing: ReadonlySet<string>, base: string): string {
  const first = `${base} copy`;
  if (!existing.has(first)) return first;
  for (let i = 2; i < 10000; i++) {
    const candidate = `${base} copy ${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base} copy ${crypto.randomUUID().slice(0, 6)}`;
}

// Deep-clone a subgraph definition with a fresh id. The two boundary
// nodes inside the inner graph get fresh ids + rewritten kinds (since
// the kind embeds the subgraph id), and every edge that referenced the
// old boundary ids is rewritten to the new ones. Wrapper nodes inside
// the cloned inner graph that reference OTHER subgraphs are left
// unchanged — the clone shares those references with the original so
// "duplicate this subgraph" doesn't accidentally rewire its dependencies.
export function cloneSubgraphDef(
  sg: SubgraphDef,
  newId: string,
  newParentFolderId: string | null,
  newLabel: string,
): SubgraphDef {
  const newInputBoundaryId = crypto.randomUUID();
  const newOutputBoundaryId = crypto.randomUUID();
  const oldInputBoundaryId = sg.inputNodeId;
  const oldOutputBoundaryId = sg.outputNodeId;
  const newInputKind = `subgraph-input/${newId}`;
  const newOutputKind = `subgraph-output/${newId}`;

  const nodes: GraphNode[] = sg.graph.nodes.map((n) => {
    if (n.id === oldInputBoundaryId) {
      return { ...n, id: newInputBoundaryId, kind: newInputKind };
    }
    if (n.id === oldOutputBoundaryId) {
      return { ...n, id: newOutputBoundaryId, kind: newOutputKind };
    }
    return n;
  });

  const remap = (id: string) =>
    id === oldInputBoundaryId
      ? newInputBoundaryId
      : id === oldOutputBoundaryId
        ? newOutputBoundaryId
        : id;
  const edges = sg.graph.edges.map((e) => ({
    ...e,
    from: { ...e.from, node: remap(e.from.node) },
    to: { ...e.to, node: remap(e.to.node) },
  }));

  return {
    ...sg,
    id: newId,
    label: newLabel,
    inputNodeId: newInputBoundaryId,
    outputNodeId: newOutputBoundaryId,
    parentFolderId: newParentFolderId,
    graph: { ...sg.graph, nodes, edges },
    version: 0,
  };
}

// Result of cloning a folder subtree: the new top-level folder id,
// every cloned folder/subgraph (parented inside the cloned subtree),
// and a map of old-subgraph-id → new-subgraph-id so callers that want
// to track the newly-created items can do so.
export interface ClonedSubtree {
  folders: Folder[];
  subgraphs: SubgraphDef[];
  rootNewId: string;
  subgraphIdMap: Map<string, string>;
}

// Deep-clone an entire folder subtree: the folder itself, every
// descendant folder, every subgraph nested anywhere inside. New ids
// throughout; descendants keep their original labels (only the top
// folder gets the "Foo copy" rename).
export function cloneFolderSubtree(
  rootFolderId: string,
  newParentFolderId: string | null,
  newRootLabel: string,
  folders: ReadonlyArray<Folder>,
  subgraphs: ReadonlyArray<SubgraphDef>,
): ClonedSubtree {
  const root = folders.find((f) => f.id === rootFolderId);
  if (!root) {
    return { folders: [], subgraphs: [], rootNewId: '', subgraphIdMap: new Map() };
  }
  const folderIdMap = new Map<string, string>();
  const subgraphIdMap = new Map<string, string>();
  folderIdMap.set(rootFolderId, crypto.randomUUID());
  const queue: string[] = [rootFolderId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const f of folders) {
      if (f.parentFolderId !== current) continue;
      folderIdMap.set(f.id, crypto.randomUUID());
      queue.push(f.id);
    }
    for (const sg of subgraphs) {
      if ((sg.parentFolderId ?? null) !== current) continue;
      subgraphIdMap.set(sg.id, crypto.randomUUID());
    }
  }

  const clonedFolders: Folder[] = [];
  clonedFolders.push({
    id: folderIdMap.get(rootFolderId)!,
    parentFolderId: newParentFolderId,
    label: newRootLabel,
  });
  for (const f of folders) {
    if (!folderIdMap.has(f.id) || f.id === rootFolderId) continue;
    const newParent =
      f.parentFolderId !== null && folderIdMap.has(f.parentFolderId)
        ? folderIdMap.get(f.parentFolderId)!
        : newParentFolderId;
    clonedFolders.push({
      id: folderIdMap.get(f.id)!,
      parentFolderId: newParent,
      label: f.label,
    });
  }

  const clonedSubgraphs: SubgraphDef[] = [];
  for (const sg of subgraphs) {
    const newId = subgraphIdMap.get(sg.id);
    if (!newId) continue;
    const oldParent = sg.parentFolderId ?? null;
    const newParent =
      oldParent !== null && folderIdMap.has(oldParent)
        ? folderIdMap.get(oldParent)!
        : newParentFolderId;
    clonedSubgraphs.push(cloneSubgraphDef(sg, newId, newParent, sg.label));
  }

  return {
    folders: clonedFolders,
    subgraphs: clonedSubgraphs,
    rootNewId: folderIdMap.get(rootFolderId)!,
    subgraphIdMap,
  };
}
