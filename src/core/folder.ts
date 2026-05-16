// User-authored folders for organizing subgraphs in the project's Asset
// view. Pure data + tree-walk utilities — no React, no zustand. Folders
// are project content (saved with the project), not workspace state.

import type { SubgraphDef } from './subgraph.js';

export interface Folder {
  id: string;
  /**
   * Parent folder id, or `null` when the folder lives at the project
   * root. Folder ids are stable user-visible-ish strings; the UI
   * generates them with `crypto.randomUUID()` so they never collide
   * with subgraph ids (UUIDs vs whatever the demo authored).
   */
  parentFolderId: string | null;
  label: string;
}

/**
 * Build a quick lookup of "what lives inside folder X" so the Asset
 * view can render a folder's contents in O(1) per folder. The result
 * maps `folderId` → { childFolders, subgraphs } and includes a
 * synthetic "root" key for top-level items (parentFolderId === null).
 */
export interface FolderContents {
  childFolders: Folder[];
  subgraphs: SubgraphDef[];
}

export const ROOT_FOLDER_ID = '__root__';

export function buildFolderIndex(
  folders: ReadonlyArray<Folder>,
  subgraphs: ReadonlyArray<SubgraphDef>,
): Map<string, FolderContents> {
  const index = new Map<string, FolderContents>();
  const ensure = (key: string) => {
    let entry = index.get(key);
    if (!entry) {
      entry = { childFolders: [], subgraphs: [] };
      index.set(key, entry);
    }
    return entry;
  };
  ensure(ROOT_FOLDER_ID);
  for (const f of folders) {
    const parent = f.parentFolderId ?? ROOT_FOLDER_ID;
    ensure(parent).childFolders.push(f);
    ensure(f.id); // folder itself exists in the index even if empty
  }
  for (const sg of subgraphs) {
    const parent = sg.parentFolderId ?? ROOT_FOLDER_ID;
    ensure(parent).subgraphs.push(sg);
  }
  return index;
}

/**
 * Cycle check: would adding a wrapper of `candidateSubgraphId` inside
 * `targetGraphId`'s graph create a containment loop?
 *
 * - `targetGraphId === 'main'`: never cycles (main can't be wrapped in
 *   a subgraph).
 * - `targetGraphId === candidateSubgraphId`: self-cycle.
 * - Otherwise: cycle iff the candidate transitively already contains a
 *   wrapper of the target. Walking forward from the candidate uses a
 *   `visited` set so mutually-referential graphs (which would already
 *   be a bug) don't infinite-loop the check.
 */
export function wouldCreateCycle(
  targetGraphId: string,
  candidateSubgraphId: string,
  subgraphs: ReadonlyArray<SubgraphDef>,
): boolean {
  if (targetGraphId === 'main') return false;
  if (targetGraphId === candidateSubgraphId) return true;
  const byId = new Map(subgraphs.map((s) => [s.id, s]));

  const visited = new Set<string>();
  function contains(id: string): boolean {
    if (visited.has(id)) return false;
    visited.add(id);
    const sg = byId.get(id);
    if (!sg) return false;
    for (const node of sg.graph.nodes) {
      if (!node.kind.startsWith('subgraph/')) continue;
      const childId = node.kind.slice('subgraph/'.length);
      if (childId === targetGraphId) return true;
      if (contains(childId)) return true;
    }
    return false;
  }
  return contains(candidateSubgraphId);
}

/**
 * Folder-tree cycle check used by inter-folder drag-reparent: would
 * setting `folder`'s parent to `newParentId` create a cycle in the
 * folder hierarchy? (`newParentId === null` always safe — root.)
 */
export function wouldCreateFolderCycle(
  folder: Folder,
  newParentId: string | null,
  folders: ReadonlyArray<Folder>,
): boolean {
  if (newParentId === null) return false;
  if (newParentId === folder.id) return true;
  const byId = new Map(folders.map((f) => [f.id, f]));
  let cursor: string | null = newParentId;
  const visited = new Set<string>();
  while (cursor !== null) {
    if (cursor === folder.id) return true;
    if (visited.has(cursor)) return true; // pre-existing cycle; treat as unsafe
    visited.add(cursor);
    const next = byId.get(cursor);
    if (!next) break;
    cursor = next.parentFolderId;
  }
  return false;
}
