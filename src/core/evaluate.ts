import { debug } from './debug.js';
import type { EvalCache } from './eval-cache.js';
import { nodeFingerprint } from './eval-cache.js';
import type { Graph, GraphEdge } from './graph.js';
import type { NodeContext, NodeOutputs, NodeRegistry } from './node-def.js';

export interface EvaluateOptions {
  rootNodeId: string;
  context?: NodeContext;
  /**
   * Shared eval cache. When present, every node's output is looked up by
   * fingerprint before evaluating; a hit skips `def.evaluate` entirely.
   * Subgraph wrappers forward this through nested evaluations so the
   * inner graph hits the same cache. Pass undefined to disable caching
   * (tests that exercise raw eval behavior, or one-off evaluations).
   */
  cache?: EvalCache;
  /**
   * Per-round set of fingerprints encountered. The caller (the editor's
   * preview pipeline) collects these from every consumer's eval, then
   * passes the union to `sweepCache` to evict everything else and free
   * orphan GPU resources.
   */
  touched?: Set<string>;
  /**
   * What to evaluate:
   *   - 'all' (default): every node in the graph, including disconnected
   *     ones. The editor uses this so every node renders its in-node
   *     preview (worley, perlin tile, etc.) even before the user wires
   *     them anywhere.
   *   - 'rootAncestors': only nodes that contribute to `rootNodeId`'s
   *     output. Subgraph wrappers use this when evaluating their inner
   *     graph — disconnected inner nodes don't affect the boundary
   *     output and shouldn't run.
   */
  scope?: 'all' | 'rootAncestors';
}

export interface EvaluateResult {
  outputs: NodeOutputs;
  order: string[];
  allOutputs: Map<string, NodeOutputs>;
  /**
   * Per-node fingerprint computed during this eval. Empty when no cache
   * was provided. Useful to chain into nested evals (the wrapper passes
   * its input fingerprints to the inner graph so the boundary node can
   * fingerprint itself based on what the parent piped in).
   */
  fingerprints: Map<string, string>;
}

// Topological order of every node in the graph (not just ancestors of any
// particular root). Used by the editor evaluator so disconnected nodes still
// get to produce previews.
export function topologicalOrderAll(graph: Graph): string[] {
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const list = incoming.get(e.to.node) ?? [];
    list.push(e);
    incoming.set(e.to.node, list);
  }

  const order: string[] = [];
  const visited = new Set<string>();
  const onStack = new Set<string>();

  function visit(nodeId: string) {
    if (visited.has(nodeId)) return;
    if (onStack.has(nodeId)) {
      throw new Error(`cycle detected at node ${nodeId}`);
    }
    onStack.add(nodeId);
    const incomingEdges = incoming.get(nodeId) ?? [];
    for (const e of incomingEdges) {
      visit(e.from.node);
    }
    onStack.delete(nodeId);
    visited.add(nodeId);
    order.push(nodeId);
  }

  for (const node of graph.nodes) {
    visit(node.id);
  }
  return order;
}

// Topological order restricted to ancestors of `rootNodeId`. Kept for
// callers that genuinely want minimal work (and for tests).
export function topologicalOrder(graph: Graph, rootNodeId: string): string[] {
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const list = incoming.get(e.to.node) ?? [];
    list.push(e);
    incoming.set(e.to.node, list);
  }

  const order: string[] = [];
  const visited = new Set<string>();
  const onStack = new Set<string>();

  function visit(nodeId: string) {
    if (visited.has(nodeId)) return;
    if (onStack.has(nodeId)) {
      throw new Error(`cycle detected at node ${nodeId}`);
    }
    onStack.add(nodeId);
    const incomingEdges = incoming.get(nodeId) ?? [];
    for (const e of incomingEdges) {
      visit(e.from.node);
    }
    onStack.delete(nodeId);
    visited.add(nodeId);
    order.push(nodeId);
  }

  visit(rootNodeId);
  return order;
}

export async function evaluateGraph(
  graph: Graph,
  registry: NodeRegistry,
  options: EvaluateOptions,
): Promise<EvaluateResult> {
  const scope = options.scope ?? 'all';
  const order =
    scope === 'all' ? topologicalOrderAll(graph) : topologicalOrder(graph, options.rootNodeId);
  const baseCtx: NodeContext = options.context ?? {};
  // cache and touched can come from options (top-level call) or be inherited
  // from the parent context (the wrapper forwards them when recursing). One
  // shared cache across an entire eval round is what makes cross-subgraph
  // re-use work.
  const cache = options.cache ?? baseCtx.evalCache;
  const touched = options.touched ?? baseCtx.evalTouched;
  // Ambient context for child nodes — wrappers read evalCache/evalTouched
  // off this and forward them into nested evaluateGraph calls. Built
  // conditionally because the project uses exactOptionalPropertyTypes:
  // setting a property to `undefined` is not the same as omitting it.
  const sharedCtx: NodeContext = { ...baseCtx };
  if (cache !== undefined) sharedCtx.evalCache = cache;
  if (touched !== undefined) sharedCtx.evalTouched = touched;

  const outputs = new Map<string, NodeOutputs>();
  const fingerprints = new Map<string, string>();

  // Index incoming edges by (toNode, toSocket) for O(1) lookup.
  const incomingBySocket = new Map<string, { node: string; socket: string }>();
  for (const e of graph.edges) {
    incomingBySocket.set(`${e.to.node}/${e.to.socket}`, e.from);
  }

  for (const nodeId of order) {
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    const def = registry.get(node.kind);
    if (!def) continue;

    // Resolve inputs. If any required input has no source, skip this node so a
    // node that just got added with required Texture2D inputs (e.g. Material
    // with unconnected basecolor) doesn't blow up the whole eval — it just
    // won't produce a preview until wired up.
    //
    // The effective input list is the static def.inputs PLUS any
    // per-instance extras stored on the graph node (variadic nodes like
    // core/scene-merge use this).
    const effectiveInputs = node.extraInputs
      ? [...def.inputs, ...node.extraInputs]
      : def.inputs;
    const inputs: Record<string, unknown> = {};
    const upstreamFingerprints: Record<string, string> = {};
    let canEvaluate = true;
    for (const input of effectiveInputs) {
      const upstream = incomingBySocket.get(`${nodeId}/${input.name}`);
      if (upstream) {
        const upstreamOutputs = outputs.get(upstream.node);
        if (!upstreamOutputs) {
          canEvaluate = false;
          break;
        }
        inputs[input.name] = upstreamOutputs[upstream.socket];
        const upFp = fingerprints.get(upstream.node);
        if (upFp !== undefined) upstreamFingerprints[input.name] = upFp;
      } else if (node.inputValues !== undefined && input.name in node.inputValues) {
        inputs[input.name] = node.inputValues[input.name];
      } else if (input.default !== undefined) {
        inputs[input.name] = input.default;
      } else if (input.optional) {
        inputs[input.name] = undefined;
      } else {
        canEvaluate = false;
        break;
      }
    }
    if (!canEvaluate) continue;

    // Subgraph-input boundary node: its outputs come from ctx.subgraphInputs
    // (which isn't visible to the fingerprint via inputs/upstreams), so mix
    // the parent's input fingerprints into this node's fingerprint. Without
    // this, the boundary would have a constant fingerprint and inner nodes
    // downstream of it would cache-hit across wrapper invocations with
    // different inputs — silent wrong-result bug.
    const boundaryExtra = def.id.startsWith('subgraph-input/')
      ? JSON.stringify(sharedCtx.subgraphInputFingerprints ?? {})
      : undefined;
    const filteredInputValues = filterInputValues(node.inputValues, effectiveInputs);
    const fpParams: Parameters<typeof nodeFingerprint>[0] = {
      nodeId,
      kind: def.id,
      inputValues: filteredInputValues,
      upstreamFingerprints,
      // Including the extra-input names ensures that adding/removing a
      // socket invalidates the cache even when no value changes — the
      // node's effective shape is different.
      extraInputs: node.extraInputs ?? [],
    };
    if (def.version !== undefined) fpParams.version = def.version;
    if (boundaryExtra !== undefined) fpParams.extra = boundaryExtra;
    const fp = nodeFingerprint(fpParams);
    fingerprints.set(nodeId, fp);
    if (touched) touched.add(fp);

    // Per-context tracker key. The same inner-graph nodeId can evaluate
    // multiple times per round when the same subgraph is instantiated
    // by several wrappers (each pass with different parent inputs);
    // scoping the tracker by `subgraphInputFingerprints` keeps those
    // evaluations from clobbering each other's "previous output."
    // Top-level nodes get an empty context key, which is fine.
    const trackerKey = sharedCtx.subgraphInputFingerprints
      ? `${nodeId}|${JSON.stringify(sharedCtx.subgraphInputFingerprints)}`
      : nodeId;

    if (cache && cache.entries.has(fp)) {
      outputs.set(nodeId, cache.entries.get(fp) as NodeOutputs);
      // Even on a cache hit we record this fingerprint as the node's
      // most recent — that way a subsequent miss can still reach the
      // output we just hit, and the node can opt to reuse its
      // resources.
      cache.lastFingerprintByNodeId.set(trackerKey, fp);
      continue;
    }

    // In-flight coalescing. Parallel consumers (Preview pane + asset
    // thumbnails + node-canvas) can all reach the same fingerprint
    // before any of them finishes evaluate(). Without this gate, every
    // one of them would run evaluate(), each allocating fresh GPU
    // resources, and the cache would only hold the last writer's
    // output — orphaning everyone else's textures (still referenced by
    // their local `outputs` Maps, but unreachable through
    // lastFingerprintByNodeId on the next round, so subsequent evals
    // would silently pick up the surviving entry's handle and the
    // structural keys of every consumer's downstream materials flip
    // across the change).
    if (cache && cache.pending.has(fp)) {
      try {
        const result = (await cache.pending.get(fp)) as NodeOutputs;
        outputs.set(nodeId, result);
        cache.lastFingerprintByNodeId.set(trackerKey, fp);
        continue;
      } catch {
        // First evaluator threw — fall through and try ourselves.
      }
    }

    // Inject this node's upstream fingerprints into the context for the
    // duration of its evaluate() call. The subgraph wrapper reads this and
    // forwards it as `subgraphInputFingerprints` into the inner eval.
    //
    // Also expose `previousOutput` — the output this same node emitted
    // on its most recent prior eval, if we still have it in the cache.
    // Texture-producing nodes (worley, perlin, ridged-noise, …) use
    // this to re-render into the existing GPUTexture instead of
    // allocating a fresh one every time a non-dimension parameter
    // changes.
    const callCtx: NodeContext = { ...sharedCtx, inputFingerprints: upstreamFingerprints };
    if (cache) {
      const prevFp = cache.lastFingerprintByNodeId.get(trackerKey);
      if (prevFp !== undefined) {
        const prev = cache.entries.get(prevFp);
        if (prev !== undefined) callCtx.previousOutput = prev as NodeOutputs;
      }
      // Surface previousOutput resolution per cache-miss eval so we
      // can see when nodes from different consumer contexts end up
      // sharing trackerKey slots — that's the failure mode where a
      // standalone bark-texture thumbnail picks up the wrapper-
      // context texture handle. Texture handle ids come from the
      // separate `[reusableTexture ALLOC]` / `[AssetThumbnail
      // commit]` logs; here we just need the trackerKey/fp pairing
      // to spot collisions.
      debug(() => {
        const hasPrev = callCtx.previousOutput !== undefined;
        return `[eval ${def.id}] tracker=${trackerKey} fp=${fp} prevFp=${prevFp ?? 'none'} hasPrev=${hasPrev}`;
      });
    }
    // Wrap def.evaluate in a Promise registered in cache.pending so
    // concurrent evaluators that arrive at this fp while we're awaiting
    // will join us at the gate above instead of running evaluate again.
    let pendingPromise: Promise<NodeOutputs> | undefined;
    if (cache) {
      pendingPromise = Promise.resolve(def.evaluate(callCtx, inputs)) as Promise<NodeOutputs>;
      cache.pending.set(fp, pendingPromise);
    }
    try {
      // Sync nodes return outputs directly; async nodes return a Promise.
      // Awaiting both shapes works without runtime branching.
      const result = pendingPromise !== undefined
        ? await pendingPromise
        : await def.evaluate(callCtx, inputs);
      outputs.set(nodeId, result);
      if (cache) {
        cache.entries.set(fp, result);
        cache.lastFingerprintByNodeId.set(trackerKey, fp);
      }
    } catch (e) {
      console.error(`evaluation of ${def.id} (${nodeId}) failed:`, e);
    } finally {
      // Remove the pending entry once we're past it — entries.has(fp)
      // now serves the same role for any future evaluator. Guard against
      // a later eval round having replaced our promise with its own.
      if (cache && pendingPromise !== undefined && cache.pending.get(fp) === pendingPromise) {
        cache.pending.delete(fp);
      }
    }
  }

  // If the root produced no outputs (its inputs were missing — common when
  // viewing a subgraph standalone before the user wires preview defaults),
  // return empty outputs gracefully instead of throwing. The caller decides
  // whether an empty scene is an error or just "nothing to render yet."
  const rootOutputs = outputs.get(options.rootNodeId) ?? {};
  return { outputs: rootOutputs, order, allOutputs: outputs, fingerprints };
}

/**
 * Drop any `inputValues` keys that don't correspond to a declared input on
 * the def. Orphan entries (left over from a previous kind or socket
 * rename) shouldn't perturb the fingerprint — same effective state should
 * produce same fingerprint regardless of incidental cruft.
 */
function filterInputValues(
  inputValues: Record<string, unknown> | undefined,
  inputs: ReadonlyArray<{ name: string }>,
): Record<string, unknown> {
  if (!inputValues) return {};
  const declared = new Set(inputs.map((i) => i.name));
  const result: Record<string, unknown> = {};
  for (const k of Object.keys(inputValues)) {
    if (declared.has(k)) result[k] = inputValues[k];
  }
  return result;
}
