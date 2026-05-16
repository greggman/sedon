import type { Folder } from '../core/folder.js';
import { fromJSON, type Graph } from '../core/graph.js';
import type { SubgraphDef } from '../core/subgraph.js';
import type { CameraState, ViewportState } from './store.js';

// On-disk save format.
//
// v1: top-level graph + rootNodeId, no subgraphs.
// v2: + subgraphs[].
// v3: split into { project, layout? }.
//     - `project` carries authored content: graph, rootNodeId, subgraphs,
//       and project-scoped per-graph UX (cameras, viewports) that's
//       PINNED to graph identity and travels with the project.
//     - `layout` is workspace state (which tab/pane is viewing what,
//       window arrangement once DockView lands). Optional. Loaders can
//       ignore it cleanly — e.g. a "merge two projects" path keeps the
//       destination's layout and discards the source's.
//
// Older versions are accepted and PROMOTED into the v3 shape with an
// undefined `layout` block.
export const SAVE_FORMAT_VERSION = 3;

export interface ProjectData {
  graph: Graph;
  rootNodeId: string;
  /** Subgraph definitions used by the project. */
  subgraphs: SubgraphDef[];
  /**
   * User-authored folders for the Asset view. Pure organisational
   * metadata — pre-v3 saves don't include them; the loader treats
   * `undefined` as "no folders".
   */
  folders?: Folder[];
  /**
   * Per-graph orbit-camera framing, keyed by editing id ('main' or
   * subgraph id). "How I last framed this graph" — pinned to a graph's
   * identity so it travels with the project across sessions. Optional;
   * missing entries fall back to defaults at view time.
   */
  cameras?: Record<string, CameraState>;
  /**
   * Per-graph React-Flow viewport (pan + zoom), keyed by editing id.
   * Same lifecycle as `cameras`. Optional.
   */
  viewports?: Record<string, ViewportState>;
}

export interface LayoutData {
  /**
   * Which editing id the main canvas was viewing when the file was
   * saved. 'main' or a subgraph id. Optional even within layout — a
   * layout block could in the future carry only window arrangement.
   */
  currentEditingId?: string;
  // Phase 2 will add: dockview model, per-view graphId, etc.
}

export interface SaveFile {
  formatVersion: typeof SAVE_FORMAT_VERSION;
  project: ProjectData;
  /**
   * Workspace state. Present when the user authored a specific layout
   * they want to preserve; absent for "raw project" saves and merge-
   * destination consumers that want to ignore the source's layout.
   */
  layout?: LayoutData;
}

export function serializeSaveFile(file: SaveFile): string {
  return JSON.stringify(file, null, 2);
}

/**
 * Parse a save-file JSON blob and return it in v3 shape.
 *
 * Backward compat:
 *   - v1 (no subgraphs field): promoted into v3 with empty subgraphs and
 *     no layout.
 *   - v2 (top-level graph/rootNodeId/subgraphs): promoted into v3 with
 *     those fields under `project` and no layout.
 *   - v3: passed through.
 *
 * Throws on malformed input.
 */
export function parseSaveFile(text: string): SaveFile {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  const v = parsed.formatVersion as number | undefined;
  if (v !== 1 && v !== 2 && v !== SAVE_FORMAT_VERSION) {
    throw new Error(
      `unsupported save file format ${v} (expected ${SAVE_FORMAT_VERSION}, 2, or 1)`,
    );
  }

  // v1 + v2 carry project fields at the top level. v3 nests them under
  // `project` and may also include an optional `layout` block.
  const projectRaw =
    v === SAVE_FORMAT_VERSION
      ? (parsed.project as Record<string, unknown> | undefined)
      : parsed;
  if (!projectRaw || typeof projectRaw !== 'object') {
    throw new Error('missing project block');
  }
  if (typeof projectRaw.rootNodeId !== 'string') {
    throw new Error('missing rootNodeId');
  }
  const graph = fromJSON(JSON.stringify(projectRaw.graph));
  const rawSubgraphs = projectRaw.subgraphs;
  const subgraphs = Array.isArray(rawSubgraphs)
    ? rawSubgraphs.map((sg) => parseSubgraphDef(sg))
    : [];

  const project: ProjectData = {
    graph,
    rootNodeId: projectRaw.rootNodeId,
    subgraphs,
  };
  // Cameras + viewports landed in v3; older saves don't have them.
  if (projectRaw.cameras && typeof projectRaw.cameras === 'object') {
    project.cameras = projectRaw.cameras as Record<string, CameraState>;
  }
  if (projectRaw.viewports && typeof projectRaw.viewports === 'object') {
    project.viewports = projectRaw.viewports as Record<string, ViewportState>;
  }
  // Folders also v3-only.
  if (Array.isArray(projectRaw.folders)) {
    project.folders = projectRaw.folders as Folder[];
  }

  const file: SaveFile = {
    formatVersion: SAVE_FORMAT_VERSION,
    project,
  };

  // Layout block — v3 only. Defensive: only attach if it's an object
  // with at least one known field.
  if (v === SAVE_FORMAT_VERSION) {
    const layoutRaw = parsed.layout;
    if (layoutRaw && typeof layoutRaw === 'object') {
      const lr = layoutRaw as Record<string, unknown>;
      const layout: LayoutData = {};
      if (typeof lr.currentEditingId === 'string') {
        layout.currentEditingId = lr.currentEditingId;
      }
      if (Object.keys(layout).length > 0) {
        file.layout = layout;
      }
    }
  }

  return file;
}

export function parseSubgraphDef(raw: unknown): SubgraphDef {
  if (!raw || typeof raw !== 'object') {
    throw new Error('invalid subgraph: not an object');
  }
  const o = raw as Partial<SubgraphDef> & { graph?: unknown };
  if (
    typeof o.id !== 'string' ||
    typeof o.label !== 'string' ||
    typeof o.category !== 'string' ||
    typeof o.inputNodeId !== 'string' ||
    typeof o.outputNodeId !== 'string' ||
    !Array.isArray(o.inputs) ||
    !Array.isArray(o.outputs)
  ) {
    throw new Error('invalid subgraph: missing required fields');
  }
  const innerGraph = fromJSON(JSON.stringify(o.graph));
  const result: SubgraphDef = {
    id: o.id,
    label: o.label,
    category: o.category,
    inputs: o.inputs,
    outputs: o.outputs,
    graph: innerGraph,
    inputNodeId: o.inputNodeId,
    outputNodeId: o.outputNodeId,
  };
  // `parentFolderId` is v3+ Asset-view metadata. Older saves don't have
  // it; the loader leaves it undefined (= "at project root").
  if (o.parentFolderId !== undefined) {
    result.parentFolderId = o.parentFolderId;
  }
  return result;
}
