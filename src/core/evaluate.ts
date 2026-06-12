import { debug } from './debug.js';
import type { EvalCache } from './eval-cache.js';
import { canonicalJson, nodeFingerprint } from './eval-cache.js';
import type { Graph, GraphEdge } from './graph.js';
import type { InputDef, NodeContext, NodeOutputs, NodeRegistry } from './node-def.js';
import { getColorTexture } from './resources.js';

// Clamp a numeric input into the bounds declared by its InputDef.
// Returns the value unchanged when it isn't a finite number (vectors,
// textures, undefined for optional inputs all fall through), or when
// the input declares no bounds. Used as the single point of constraint
// enforcement so node code can trust its declared range.
function clampNumericInput(value: unknown, def: InputDef): unknown {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  if (def.type !== 'Int' && def.type !== 'Float') return value;
  let v = value;
  if (def.min !== undefined && v < def.min) v = def.min;
  if (def.max !== undefined && v > def.max) v = def.max;
  return v;
}

// True for the `[r,g,b,a]` shape stored as a Color value (or as a
// color-fallback InputDef.default). Used by the Color → Texture2D
// promotion in the input-resolution loop. 3-component arrays are
// also accepted (alpha defaults to 1 in getColorTexture).
function isRgbaArray(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  if (v.length < 3 || v.length > 4) return false;
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'number' || !Number.isFinite(v[i])) return false;
  }
  return true;
}

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
  /**
   * When true, suppress the per-node `console.error("evaluation of … failed", e)`
   * log emitted on a caught node-level exception. Callers that expect
   * some sample graphs to fail evaluation (e.g. the Nodes browser
   * preview thumbnails, where an incomplete `doc.sampleGraph` should
   * just fall back to a glyph) set this to keep the console clean.
   *
   * The exception is still caught and the evaluator still continues
   * with the remaining nodes — quiet only affects logging. Defaults to
   * false so the regular editor / project evaluation surfaces every
   * authoring failure loudly.
   */
  quiet?: boolean;
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
  // Always thread the registry — nodes whose evaluate() looks up other
  // node-kinds at runtime (for-each-point invokes its body subgraph
  // wrapper) read it here. Inherited from baseCtx when an outer
  // evaluator already set it; otherwise stamped from the explicit
  // `registry` arg.
  if (sharedCtx.registry === undefined) sharedCtx.registry = registry;

  const outputs = new Map<string, NodeOutputs>();
  const fingerprints = new Map<string, string>();
  const roundStart = cache ? performance.now() : 0;
  if (cache) cache.stats.rounds++;

  // Index incoming edges by (toNode, toSocket) for O(1) lookup. For
  // single-fan-in sockets there's at most one entry per key, but a
  // `multi: true` socket may have many edges into it — the map's
  // value is a list to handle both uniformly. Insertion order in the
  // list mirrors `graph.edges` order, which becomes the array order
  // the evaluator hands to a multi input.
  const incomingBySocket = new Map<string, Array<{ node: string; socket: string }>>();
  for (const e of graph.edges) {
    const key = `${e.to.node}/${e.to.socket}`;
    const list = incomingBySocket.get(key);
    if (list) list.push(e.from);
    else incomingBySocket.set(key, [e.from]);
  }

  // Lazy-eval pre-pass: figure out which nodes we MUST evaluate this
  // round and which are reachable only through `lazy: true` inputs
  // (deferred — evaluated on demand when the consumer calls a thunk).
  //
  // A node is "eager" if there's a path from it forward to a node we
  // care about, via at least one non-lazy edge. Equivalently: walk
  // backward from the wanted sinks through non-lazy edges only.
  //
  // Sinks depend on scope:
  //   • 'rootAncestors' — only `options.rootNodeId` is wanted; the
  //     boundary outputs lookup needs that node's evaluate to run.
  //   • 'all'           — every node is potentially wanted (the
  //     editor renders previews for every node). In practice this
  //     marks every node as eager; lazy semantics only meaningfully
  //     activate inside `rootAncestors` callees (bridges, wrappers).
  //
  // For each non-lazy incoming edge to an eager node, the upstream
  // becomes eager too. Lazy edges DON'T propagate eagerness — the
  // upstream of a lazy edge only runs if and when a thunk fires.
  //
  // We still compute fingerprints for lazy-deferred nodes (the main
  // loop falls through after the fp computation) so consumers' fps
  // correctly reflect upstream identity and downstream cache lookups
  // invalidate when any branch changes.
  const eagerNodes = new Set<string>();
  {
    const incomingByNode = new Map<string, GraphEdge[]>();
    for (const e of graph.edges) {
      const list = incomingByNode.get(e.to.node) ?? [];
      list.push(e);
      incomingByNode.set(e.to.node, list);
    }
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const queue: string[] = scope === 'all'
      ? graph.nodes.map((n) => n.id)
      : [options.rootNodeId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (eagerNodes.has(id)) continue;
      eagerNodes.add(id);
      const node = nodeById.get(id);
      if (!node) continue;
      const def = registry.get(node.kind);
      if (!def) continue;
      const inputDefs = node.extraInputs
        ? [...def.inputs, ...node.extraInputs]
        : def.inputs;
      const inputByName = new Map(inputDefs.map((i) => [i.name, i]));
      const edges = incomingByNode.get(id) ?? [];
      for (const e of edges) {
        const inputDef = inputByName.get(e.to.socket);
        // Skip lazy edges — the upstream isn't eagerly needed.
        if (inputDef?.lazy) continue;
        queue.push(e.from.node);
      }
    }
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
    // scene/merge use this).
    const effectiveInputs = node.extraInputs
      ? [...def.inputs, ...node.extraInputs]
      : def.inputs;
    const inputs: Record<string, unknown> = {};
    const upstreamFingerprints: Record<string, string> = {};
    let canEvaluate = true;
    for (const input of effectiveInputs) {
      const upstreams = incomingBySocket.get(`${nodeId}/${input.name}`) ?? [];
      // Multi-fan-in path: collect every successfully-evaluated upstream
      // into an Array<T> and treat the input as always resolved (even
      // zero edges → empty array). Broken upstreams are simply skipped —
      // same "don't black out the rest of the graph" rationale as the
      // optional-input fallback below, just applied per-element.
      // Fingerprint is the comma-joined list of upstream fps so the
      // node re-evaluates when ANY contributor's output changes.
      let resolved = false;
      // Lazy inputs: don't read from `outputs` (the upstream is
      // probably lazy-deferred and never evaluated). Build a thunk
      // per branch instead — the consumer's evaluate() decides
      // whether to call it. See InputDef.lazy.
      if (input.lazy) {
        const fpItems: string[] = [];
        const makeThunk = (upNodeId: string, upSocket: string) => () => {
          const innerOpts: EvaluateOptions = {
            rootNodeId: upNodeId,
            scope: 'rootAncestors',
            context: sharedCtx,
          };
          if (cache !== undefined) innerOpts.cache = cache;
          if (touched !== undefined) innerOpts.touched = touched;
          return evaluateGraph(graph, registry, innerOpts).then((r) => r.outputs[upSocket]);
        };
        if (input.multi) {
          const thunks: Array<() => Promise<unknown>> = [];
          for (const u of upstreams) {
            thunks.push(makeThunk(u.node, u.socket));
            const upFp = fingerprints.get(u.node);
            if (upFp !== undefined) fpItems.push(upFp);
          }
          inputs[input.name] = thunks;
          upstreamFingerprints[input.name] = `lazy-multi:[${fpItems.join(',')}]`;
          resolved = true;
        } else if (upstreams[0]) {
          const u = upstreams[0];
          inputs[input.name] = makeThunk(u.node, u.socket);
          const upFp = fingerprints.get(u.node);
          if (upFp !== undefined) upstreamFingerprints[input.name] = `lazy:${upFp}`;
          resolved = true;
        }
        // Lazy single with no upstream falls through to the
        // default/optional/missing chain. Lazy multi with no
        // upstreams produced an empty array above — same shape as
        // eager multi with no wires.
      } else if (input.multi) {
        const items: unknown[] = [];
        const fpItems: string[] = [];
        for (const u of upstreams) {
          const upstreamOutputs = outputs.get(u.node);
          if (upstreamOutputs) {
            items.push(upstreamOutputs[u.socket]);
            const upFp = fingerprints.get(u.node);
            if (upFp !== undefined) fpItems.push(upFp);
          }
        }
        inputs[input.name] = items;
        upstreamFingerprints[input.name] = `multi:[${fpItems.join(',')}]`;
        resolved = true;
      } else if (upstreams[0]) {
        // Single-fan-in: the same logic as before. If the upstream node
        // failed to evaluate (it itself had missing required inputs,
        // threw, etc.) FALL THROUGH to the fallback chain (inputValue
        // → default → optional → fail) as if the wire weren't there.
        // This is what keeps a broken sub-branch from blacking out the
        // rest of the graph: e.g. deleting the Fire Hydrant wrapper in
        // the city demo leaves the hydrant scatter unable to evaluate;
        // the city's scene-merge has its `scene_N` for hydrants wired
        // to that scatter and marked `optional: true`. Previously the
        // merge failed too because we treated "broken upstream" as a
        // hard error before consulting `optional` — now the merge
        // drops the broken slot and the rest of the city still renders.
        const upstream = upstreams[0];
        const upstreamOutputs = outputs.get(upstream.node);
        if (upstreamOutputs) {
          inputs[input.name] = upstreamOutputs[upstream.socket];
          const upFp = fingerprints.get(upstream.node);
          if (upFp !== undefined) upstreamFingerprints[input.name] = upFp;
          resolved = true;
        }
      }
      if (!resolved) {
        if (node.inputValues !== undefined && input.name in node.inputValues) {
          const val = node.inputValues[input.name];
          inputs[input.name] = val;
          // Hash inputValue-only inputs into upstreamFingerprints so
          // downstream consumers' fingerprints react to per-instance
          // overrides. Critically: this is what makes a subgraph
          // wrapper's child (the boundary-input node) re-evaluate when
          // the wrapper's inputValue changes — without this hop, the
          // wrapper's own fp moves (it includes inputValues) but the
          // boundary's fp inside the inner eval doesn't, and the
          // boundary cache-hits on a stale outputs map.
          upstreamFingerprints[input.name] = `iv:${canonicalJson(val)}`;
        } else if (input.default !== undefined) {
          inputs[input.name] = input.default;
        } else if (input.optional) {
          inputs[input.name] = undefined;
        } else {
          canEvaluate = false;
          break;
        }
      }
      // Single point of constraint enforcement: declared `min`/`max`
      // clamp the value regardless of its source (wire, inputValue,
      // or default). Node code can rely on the declared range and
      // skip defensive clamping. No-op for non-numeric values.
      inputs[input.name] = clampNumericInput(inputs[input.name], input);
      // Color → Texture2D promotion. A Texture2D input can receive a
      // colour from three places: a wired Color edge (allowed by the
      // type-compat table), an `[r,g,b,a]` `inputValue` (set via the
      // inline picker on an unwired socket), or an `[r,g,b,a]` static
      // default in the InputDef. Whichever path produced an array
      // value, materialise it to a 1×1 Texture2DValue here so the
      // node sees a normal Texture2D and doesn't need its own
      // promotion branch.
      //
      // Slot key: `<nodeId>|<inputName>`. The texture is owned by
      // that slot for its lifetime — dragging a colour picker
      // updates the single pixel via writeTexture instead of
      // allocating a new GPUTexture per tick. See
      // resources.ts:getColorTexture for the slot-vs-content cache
      // trade-off.
      if (input.type === 'Texture2D' && isRgbaArray(inputs[input.name])) {
        if (sharedCtx.device) {
          const slotKey = `${nodeId}|${input.name}`;
          inputs[input.name] = getColorTexture(
            sharedCtx.device,
            slotKey,
            inputs[input.name] as number[],
          );
        }
      }
    }
    if (!canEvaluate) continue;

    // Subgraph-input boundary node: its outputs come from ctx.subgraphInputs
    // (which isn't visible to the fingerprint via inputs/upstreams), so mix
    // the parent's input fingerprints into this node's fingerprint. Without
    // this, the boundary would have a constant fingerprint and inner nodes
    // downstream of it would cache-hit across wrapper invocations with
    // different inputs — silent wrong-result bug.
    const extraParts: string[] = [];
    if (def.id.startsWith('subgraph-input/')) {
      extraParts.push(JSON.stringify(sharedCtx.subgraphInputFingerprints ?? {}));
    }
    // Iteration bridges: the `iteration-input` boundary's outputs come
    // from `ctx.iterationContext` (set per-iteration by the owning
    // for-each-* node), so its fp has to incorporate per-iteration
    // fingerprints to keep cache entries from colliding across
    // iterations. Without this every iteration's downstream nodes
    // would share one cache slot and return the same output.
    if (def.id.startsWith('iteration-input/')) {
      extraParts.push(JSON.stringify(sharedCtx.iterationContextFingerprints ?? {}));
    }
    // def.fingerprintExtra is used by subgraph boundaries to fingerprint
    // their interface shape without piggy-backing on the subgraph's
    // coarse version counter (which would cascade-invalidate every
    // inner node on any inner edit — drag-a-colour-picker == 5fps).
    if (def.fingerprintExtra !== undefined) extraParts.push(def.fingerprintExtra);
    // Per-instance dynamic extra — see NodeDef.dynamicFingerprintExtra.
    // Used by `tex/image` to mix in a per-URL "loaded version" so the
    // cache misses on the eval that follows an async fetch landing.
    if (def.dynamicFingerprintExtra) extraParts.push(def.dynamicFingerprintExtra(inputs, sharedCtx));
    // Provenance-stamping nodes (scene-entity et al.) write the calling
    // subgraph path into their output, so two contexts produce
    // different VALUES even though their inputs match. Mix the path
    // into the fingerprint so each context gets its own cache slot —
    // see NodeDef.provenanceDependent for why this matters.
    if (def.provenanceDependent && sharedCtx.subgraphPath) {
      extraParts.push(`prov:${JSON.stringify(sharedCtx.subgraphPath)}`);
    }
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
    if (extraParts.length > 0) fpParams.extra = extraParts.join('|');
    const fp = nodeFingerprint(fpParams);
    fingerprints.set(nodeId, fp);
    if (touched) touched.add(fp);

    // Lazy-deferred node: its fp is recorded so consumers' fps move
    // correctly, but we don't evaluate it here. Whichever consumer's
    // thunk fires for this branch will trigger a recursive
    // evaluateGraph call against this nodeId; that call evaluates
    // through the shared cache and hits the cache on repeat calls.
    if (!eagerNodes.has(nodeId)) continue;

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
      cache.stats.nodeEvals++;
      cache.stats.cacheHits++;
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
        cache.stats.nodeEvals++;
        cache.stats.pendingHits++;
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
    // `nodeId` lets producer nodes stamp provenance onto the entities
    // they emit (see resources.ts → SceneEntityProvenance). `subgraphPath`
    // is forwarded from sharedCtx — the subgraph wrapper pushes a new
    // entry there before recursing into the inner graph.
    const callCtx: NodeContext = {
      ...sharedCtx,
      inputFingerprints: upstreamFingerprints,
      nodeId,
    };
    if (cache) {
      const prevFp = cache.lastFingerprintByNodeId.get(trackerKey);
      if (prevFp !== undefined) {
        const prev = cache.entries.get(prevFp);
        if (prev !== undefined) {
          callCtx.previousOutput = prev as NodeOutputs;
          // Passing prev to evaluate() licenses the node to mutate its
          // GPU resources (reusableBuffer/reusableTexture overwrite the
          // existing handle's contents). The cached entry at prevFp
          // would still point at those handles, so a future hit at
          // prevFp would silently return a "previous-config" value
          // whose buffer now holds the NEW config's contents — the
          // "toggle align off then on, leaves stay unaligned" bug.
          // sweep can't save us because it's rAF-deferred; the next
          // hit may arrive in the same frame. Evict here so the
          // contract is "one live cache entry per shared GPU
          // resource." Skip when prevFp === fp because the same-fp
          // case went through the cache-hit branch above; this branch
          // only runs on a miss where prevFp belongs to a *different*
          // config.
          if (prevFp !== fp) cache.entries.delete(prevFp);
        }
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
      cache.stats.nodeEvals++;
      cache.stats.cacheMisses++;
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
      if (!options.quiet) {
        console.error(`evaluation of ${def.id} (${nodeId}) failed:`, e);
      }
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
  if (cache) cache.stats.evalDurationMs += performance.now() - roundStart;
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
