import { type Graph, type GraphEdge, type GraphNode } from '../core/graph.js';
import type { InputDef, NodeRegistry, OutputDef } from '../core/node-def.js';
import { isSubgraphInternalKind, type SubgraphDef } from '../core/subgraph.js';

// "Encapsulate selection" — given a graph and a set of selected node
// ids, build:
//
//   • A fresh SubgraphDef carrying the selected nodes + their
//     internal edges + boundary input/output nodes wired to take
//     over each external connection.
//   • A replacement parent graph that drops the selected nodes and
//     inserts a wrapper node referencing the new SubgraphDef, with
//     every cross-boundary edge rewired through the wrapper's
//     mirrored I/O sockets.
//
// Boundary classification of the parent graph's edges:
//
//   • internal       both endpoints in selection → moved into the
//                    subgraph as-is.
//   • input boundary outer source → selected target → becomes a
//                    new subgraph input. One per (target inner
//                    socket); the parent's outer source connects
//                    to the wrapper's matching input.
//   • output boundary selected source → outer target → becomes a
//                    new subgraph output. Deduped by (source inner
//                    node + socket): one inner output can drive
//                    several outer targets without producing extra
//                    socket copies.
//   • external       neither endpoint in selection → carried over
//                    to the new parent graph unchanged.
//
// Boundary nodes (`subgraph-input/<id>` / `subgraph-output/<id>`)
// in the selection are filtered out: they only make sense inside
// the subgraph that owns them, so encapsulating them would create
// a malformed inner graph. Their kind id embeds the OWNING
// subgraph's id, so they can't be retargeted by a remap either.

export interface ExtractResult {
  /** The freshly-built subgraph definition. */
  newSubgraph: SubgraphDef;
  /** The parent graph with selection replaced by the wrapper. */
  newParentGraph: Graph;
  /** New wrapper node id (lives in `newParentGraph`). Callers use
   *  this to frame the canvas and request rename on it. */
  wrapperId: string;
}

export interface ExtractOptions {
  /** Fresh id for the new subgraph (slugified caller-side so
   *  uniqueness can be enforced against the project's existing
   *  subgraph ids). */
  newSubgraphId: string;
  /** User-facing label for the new subgraph. Inline-renamed
   *  immediately after creation, so the default ("untitled
   *  subgraph") only matters for the first half-second. */
  newSubgraphLabel: string;
}

export function extractSelectionAsSubgraph(
  parentGraph: Graph,
  selectedIds: ReadonlySet<string>,
  registry: NodeRegistry,
  options: ExtractOptions,
): ExtractResult | null {
  const { newSubgraphId: sgId, newSubgraphLabel } = options;

  // ── 1. Filter selection: skip boundary nodes and missing ids ──
  const innerIds = new Set<string>();
  const innerNodes: GraphNode[] = [];
  for (const id of selectedIds) {
    const node = parentGraph.nodes.find((n) => n.id === id);
    if (!node) continue;
    if (isSubgraphInternalKind(node.kind)) continue;
    innerIds.add(id);
    innerNodes.push(node);
  }
  if (innerIds.size === 0) return null;

  // ── 2. Classify every edge ───────────────────────────────────
  const internalEdges: GraphEdge[] = [];
  const inputBoundaryEdges: GraphEdge[] = [];
  const outputBoundaryEdges: GraphEdge[] = [];
  const externalEdges: GraphEdge[] = [];
  for (const e of parentGraph.edges) {
    const fromIn = innerIds.has(e.from.node);
    const toIn = innerIds.has(e.to.node);
    if (fromIn && toIn) internalEdges.push(e);
    else if (!fromIn && toIn) inputBoundaryEdges.push(e);
    else if (fromIn && !toIn) outputBoundaryEdges.push(e);
    else externalEdges.push(e);
  }

  // ── 3. Build subgraph I/O socket definitions ─────────────────
  // Inputs: one per input boundary edge — each target inner socket
  // can only have a single incoming edge (the graph store's
  // connect() replaces any prior to the same target), so dedup is
  // unnecessary. The new socket inherits the inner input's type.
  const inputSocketName = new Map<string, string>(); // edgeId → new InputDef.name
  const sgInputs: InputDef[] = [];
  for (const e of inputBoundaryEdges) {
    const innerType = lookupInputType(e.to.node, e.to.socket, parentGraph, registry);
    const name = crypto.randomUUID();
    const label = uniqueSocketLabel(e.to.socket, sgInputs);
    sgInputs.push({ name, type: innerType ?? 'Float', label });
    inputSocketName.set(e.id, name);
  }
  // Outputs: deduped by (innerNodeId|innerSocket) so a fan-out
  // inside the selection produces one subgraph output, not many.
  const outputKey = (e: GraphEdge) => `${e.from.node}|${e.from.socket}`;
  const outputSocketName = new Map<string, string>(); // outputKey → new OutputDef.name
  const sgOutputs: OutputDef[] = [];
  for (const e of outputBoundaryEdges) {
    const key = outputKey(e);
    if (outputSocketName.has(key)) continue;
    const innerType = lookupOutputType(e.from.node, e.from.socket, parentGraph, registry);
    const name = crypto.randomUUID();
    const label = uniqueSocketLabel(e.from.socket, sgOutputs);
    sgOutputs.push({ name, type: innerType ?? 'Float', label });
    outputSocketName.set(key, name);
  }

  // ── 4. Inner graph: selected nodes + internal edges + new
  //       boundary nodes wired to take over the cross-boundary
  //       edges ───────────────────────────────────────────────
  const inputBoundaryId = crypto.randomUUID();
  const outputBoundaryId = crypto.randomUUID();
  const bbox = bboxOf(innerNodes);
  const innerGraph: Graph = {
    version: parentGraph.version,
    nodes: [
      // Boundary nodes flank the selection's bounding box so the
      // user sees a left-to-right "input → selection → output"
      // shape on first drill-in.
      {
        id: inputBoundaryId,
        kind: `subgraph-input/${sgId}`,
        position: { x: bbox.minX - 240, y: bbox.midY },
      },
      {
        id: outputBoundaryId,
        kind: `subgraph-output/${sgId}`,
        position: { x: bbox.maxX + 240, y: bbox.midY },
      },
      // Clone the selected nodes by value so the parent and inner
      // graphs don't share `inputValues` / `extraInputs` / etc.
      // Same deep-clone shape we use elsewhere (per-node spread,
      // structuredClone of mutable contents).
      ...innerNodes.map(cloneInnerNode),
    ],
    edges: [
      ...internalEdges.map(cloneEdge),
      // Input boundary → inner target for each input boundary edge.
      ...inputBoundaryEdges.map((e) => ({
        id: crypto.randomUUID(),
        from: { node: inputBoundaryId, socket: inputSocketName.get(e.id)! },
        to: { node: e.to.node, socket: e.to.socket },
      })),
      // Inner source → output boundary for each deduped output.
      ...[...outputSocketName.entries()].map(([key, socketName]) => {
        const [innerNodeId, innerSocket] = splitOutputKey(key);
        return {
          id: crypto.randomUUID(),
          from: { node: innerNodeId, socket: innerSocket },
          to: { node: outputBoundaryId, socket: socketName },
        };
      }),
    ],
  };

  const newSubgraph: SubgraphDef = {
    id: sgId,
    label: newSubgraphLabel,
    category: 'Subgraphs',
    inputs: sgInputs,
    outputs: sgOutputs,
    graph: innerGraph,
    inputNodeId: inputBoundaryId,
    outputNodeId: outputBoundaryId,
  };

  // ── 5. Parent graph: keep external edges + non-selected nodes;
  //       add wrapper; rewire each cross-boundary edge through it ─
  const wrapperId = crypto.randomUUID();
  const centroid = bbox.centroid;
  const wrapperNode: GraphNode = {
    id: wrapperId,
    kind: `subgraph/${sgId}`,
    position: centroid,
  };
  const newParentGraph: Graph = {
    version: parentGraph.version,
    nodes: [
      ...parentGraph.nodes.filter((n) => !innerIds.has(n.id)),
      wrapperNode,
    ],
    edges: [
      ...externalEdges.map(cloneEdge),
      // Outer source → wrapper.<new input> for each input boundary edge.
      ...inputBoundaryEdges.map((e) => ({
        id: crypto.randomUUID(),
        from: { node: e.from.node, socket: e.from.socket },
        to: { node: wrapperId, socket: inputSocketName.get(e.id)! },
      })),
      // wrapper.<new output> → outer target for each output boundary edge.
      // Use the deduped name so multiple outer fan-out targets all
      // share the same wrapper output socket.
      ...outputBoundaryEdges.map((e) => ({
        id: crypto.randomUUID(),
        from: { node: wrapperId, socket: outputSocketName.get(outputKey(e))! },
        to: { node: e.to.node, socket: e.to.socket },
      })),
    ],
  };

  return { newSubgraph, newParentGraph, wrapperId };
}

// ─── Helpers ───────────────────────────────────────────────────

function lookupInputType(
  nodeId: string,
  socketName: string,
  graph: Graph,
  registry: NodeRegistry,
): string | undefined {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return undefined;
  // Check the registry's static input list first.
  const def = registry.get(node.kind);
  if (def) {
    const fromStatic = def.inputs.find((i) => i.name === socketName);
    if (fromStatic) return fromStatic.type;
  }
  // Variadic / dynamically-added per-instance inputs (scene-merge
  // extras, for-each-point bridge-driven extras).
  const extra = node.extraInputs?.find((i) => i.name === socketName);
  return extra?.type;
}

function lookupOutputType(
  nodeId: string,
  socketName: string,
  graph: Graph,
  registry: NodeRegistry,
): string | undefined {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return undefined;
  // extraOutputs REPLACE def.outputs when non-empty (for-each-point
  // post-body convention) — check the override first.
  if (node.extraOutputs && node.extraOutputs.length > 0) {
    const e = node.extraOutputs.find((o) => o.name === socketName);
    if (e) return e.type;
  }
  const def = registry.get(node.kind);
  return def?.outputs.find((o) => o.name === socketName)?.type;
}

function uniqueSocketLabel(
  preferred: string,
  existing: ReadonlyArray<{ label?: string }>,
): string {
  const used = new Set(existing.map((s) => s.label).filter(Boolean) as string[]);
  if (!used.has(preferred)) return preferred;
  for (let i = 2; i < 10000; i++) {
    const candidate = `${preferred}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${preferred}_${crypto.randomUUID().slice(0, 6)}`;
}

function splitOutputKey(key: string): [string, string] {
  const idx = key.indexOf('|');
  return [key.slice(0, idx), key.slice(idx + 1)];
}

function cloneEdge(e: GraphEdge): GraphEdge {
  return {
    id: e.id,
    from: { node: e.from.node, socket: e.from.socket },
    to: { node: e.to.node, socket: e.to.socket },
  };
}

function cloneInnerNode(n: GraphNode): GraphNode {
  const out: GraphNode = { id: n.id, kind: n.kind };
  if (n.name !== undefined) out.name = n.name;
  if (n.position) out.position = { x: n.position.x, y: n.position.y };
  if (n.inputValues) out.inputValues = structuredClone(n.inputValues);
  if (n.extraInputs) out.extraInputs = n.extraInputs.map((i) => ({ ...i }));
  if (n.extraOutputs) out.extraOutputs = n.extraOutputs.map((o) => ({ ...o }));
  return out;
}

function bboxOf(nodes: GraphNode[]): {
  minX: number; maxX: number; midY: number; centroid: { x: number; y: number };
} {
  if (nodes.length === 0) {
    return { minX: 0, maxX: 0, midY: 0, centroid: { x: 0, y: 0 } };
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const x = n.position?.x ?? 0;
    const y = n.position?.y ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  return { minX, maxX, midY, centroid: { x: midX, y: midY } };
}
