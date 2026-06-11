// Registry of "iter/*" node kinds — the editor-side single source
// of truth for which node kinds own a bridge subgraph and what
// per-iteration context they expose.
//
// The bridge machinery (private SubgraphDef + boundary nodes) is
// implemented inside each iter node's NodeDef (see
// src/nodes/for-each-point.ts, for-each-polygon.ts). The editor
// needs three things from these nodes that ARE kind-specific:
//
//   1. Which static input is the iteration source (for-each-point's
//      `points: PointCloud`, for-each-polygon's `polygons:
//      PolygonList`). The extra-socket sync filter must NOT strip
//      this — it's part of the static NodeDef, not a mirrored extra.
//   2. The per-iteration context names + types this kind exposes on
//      its bridge's iteration-input boundary (for-each-point's
//      `position` + `index`, for-each-polygon's `polygon` + `index`).
//      `attachIterationBody` auto-wires body subgraph inputs of the
//      same name from the iteration-input boundary.
//   3. A human-readable label prefix used on the bridge's
//      SubgraphDef.label ("for-each-point body (oak-tree)") and on
//      the canvas-side menu ("Edit iter…" → "Edit for-each-point
//      body").
//
// Add a new iter kind by adding one entry here and dropping a
// NodeDef next to for-each-point.ts. The editor picks it up
// automatically — no further hardcodes.

import type { GraphNode } from './graph.js';

export interface IterKindInfo {
  /** Node kind this entry describes, e.g. `iter/for-each-point`. */
  kind: string;
  /** The static input socket on the iter node that feeds the
   *  iteration source (e.g. `points`, `polygons`). The extra-socket
   *  sync filter never strips edges to this socket. */
  iterationSourceInput: string;
  /** Names + types this kind exposes on its bridge's
   *  iteration-input boundary. `attachIterationBody` auto-wires
   *  body subgraph inputs whose name matches one of these. */
  providedContext: ReadonlyArray<{ name: string; type: string }>;
  /** Prefix used on the bridge's SubgraphDef.label and on the
   *  canvas context-menu "Edit iter…" item. */
  bridgeLabelPrefix: string;
}

const ITER_KINDS: Record<string, IterKindInfo> = {
  'iter/for-each-point': {
    kind: 'iter/for-each-point',
    iterationSourceInput: 'points',
    providedContext: [
      { name: 'position', type: 'Vec3' },
      { name: 'index', type: 'Int' },
    ],
    bridgeLabelPrefix: 'for-each-point',
  },
  'iter/for-each-polygon': {
    kind: 'iter/for-each-polygon',
    iterationSourceInput: 'polygons',
    providedContext: [
      { name: 'polygon', type: 'Polygon' },
      { name: 'index', type: 'Int' },
    ],
    bridgeLabelPrefix: 'for-each-polygon',
  },
};

/** Return the IterKindInfo for `nodeKind`, or undefined if it isn't
 *  an iter kind. Cheap — direct property lookup. */
export function getIterKindInfo(nodeKind: string): IterKindInfo | undefined {
  return ITER_KINDS[nodeKind];
}

/** True iff `nodeKind` is an iter kind with a bridge subgraph. */
export function isIterNodeKind(nodeKind: string): boolean {
  return nodeKind in ITER_KINDS;
}

/** Read the bridge id from an iter node's inputValues. Returns
 *  undefined for non-iter nodes OR iter nodes that haven't had a
 *  body dropped yet (no `__bridgeId` set). */
export function getIterBridgeIdFor(node: GraphNode): string | undefined {
  if (!isIterNodeKind(node.kind)) return undefined;
  const bridgeId = node.inputValues?.__bridgeId;
  if (typeof bridgeId !== 'string' || bridgeId === '') return undefined;
  return bridgeId;
}
