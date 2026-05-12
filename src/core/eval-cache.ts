// Content-addressed evaluation cache.
//
// Every node's output is keyed by a fingerprint that summarizes everything
// that went into producing it: the node kind, its version (relevant for
// subgraph wrappers — the underlying inner graph can change), its
// inputValues (literal user-set values), and the fingerprints of every
// upstream socket. Same fingerprint → same output, by construction, as
// long as `evaluate()` is deterministic for the same inputs.
//
// The cache is global across an entire eval round (which may span
// multiple consumers / multiple nested subgraph evaluations) and persists
// across rounds — that's the whole point. After a round, the caller
// passes the set of fingerprints that were touched to `sweepCache`,
// which evicts every other entry and destroys any GPU resources owned by
// the evicted entries that aren't still referenced by surviving entries.

import { walkGpuResources } from './resources.js';

export interface EvalCache {
  /** fingerprint → outputs produced by the node that hashed to it. */
  entries: Map<string, unknown>;
}

export function createEvalCache(): EvalCache {
  return { entries: new Map() };
}

/**
 * Compute a fingerprint for a node, given the surrounding context. Pure: same
 * inputs always produce the same fingerprint, regardless of the JS object
 * identities of the input arguments. The output is a short string suitable
 * for use as a Map key.
 *
 * - `kind`: the node's kind id (e.g. "core/perlin").
 * - `version`: optional version stamp — populated for subgraph wrappers
 *   so an edit inside the subgraph invalidates the wrapper's cached
 *   output. Undefined for normal nodes (whose behavior is fixed by their
 *   kind).
 * - `inputValues`: literal user-set values for unconnected inputs (numbers,
 *   strings, vectors). Connected inputs are NOT here — their contribution
 *   comes via `upstreamFingerprints`.
 * - `upstreamFingerprints`: fingerprint per connected input socket. Same
 *   fingerprint = identical upstream output, so we don't need to hash the
 *   value itself (which may be a multi-MB texture).
 * - `extra`: an optional extra string mixed in. Used by the boundary input
 *   node — its outputs come from `ctx.subgraphInputs`, which isn't on the
 *   graph, so we mix in the parent wrapper's input fingerprints to make
 *   the boundary's fingerprint vary with what's piped in.
 */
export function nodeFingerprint(params: {
  kind: string;
  version?: string | number;
  inputValues: Record<string, unknown> | undefined;
  upstreamFingerprints: Record<string, string>;
  extra?: string;
}): string {
  const parts = [
    params.kind,
    params.version != null ? String(params.version) : '',
    canonicalJson(params.inputValues ?? {}),
    canonicalJson(params.upstreamFingerprints),
    params.extra ?? '',
  ];
  return hash(parts.join('|'));
}

/**
 * Stable JSON-ish serialization. Object keys are sorted so that
 * `{a:1,b:2}` and `{b:2,a:1}` produce the same string — JSON.stringify
 * uses insertion order, which is fragile here (a setInputValue followed
 * by another setInputValue produces a different key order than loading
 * a saved file would). Arrays preserve order. Typed arrays serialize
 * via their string representation (Float32Array([1,2,3]) → "1,2,3");
 * we don't currently fingerprint typed-array inputs but it's defensive.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Float32Array || value instanceof Uint32Array || value instanceof Int32Array) {
    return `[${value.join(',')}]`;
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
  }
  return JSON.stringify(String(value));
}

/**
 * djb2-style 32-bit hash, returned as a base-36 string. Not cryptographic,
 * but extremely cheap and collision-resistant enough for content addressing
 * in an interactive editor. (Collisions, if they happened, would cause
 * cache hits where the actual content differs — surfacing as a wrong
 * preview. djb2 hits ~2^32 distinct strings cleanly, which is plenty for
 * the scale of fingerprints any editing session produces.)
 */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * Evict every cache entry whose fingerprint isn't in `touched`, and
 * destroy GPU resources owned exclusively by the evicted entries.
 *
 * Resource lifetime: a single GPUTexture/GPUBuffer can be referenced by
 * multiple cache entries — e.g. a perlin entry owns a texture, and a
 * downstream material entry references that same texture. Naively
 * destroying every resource in every evicted entry would free GPU
 * memory still pointed at by a live entry. We avoid that by
 * computing the union of resources in the SURVIVING entries first, and
 * only destroying a resource if it isn't in that live set.
 */
export function sweepCache(cache: EvalCache, touched: Set<string>): void {
  const live = new Set<GpuResource>();
  for (const [fp, outputs] of cache.entries) {
    if (touched.has(fp)) {
      walkGpuResources(outputs, (r) => live.add(r));
    }
  }
  for (const [fp, outputs] of cache.entries) {
    if (touched.has(fp)) continue;
    walkGpuResources(outputs, (r) => {
      if (!live.has(r)) {
        try {
          r.destroy();
        } catch {
          // Destroying an already-destroyed resource throws in some engines;
          // swallow because shared-reference graphs make double-destroy
          // possible if a single resource is reached through multiple
          // entries that all get evicted in the same pass.
        }
      }
    });
    cache.entries.delete(fp);
  }
}

/** Anything we own a .destroy() handle on — currently GPUTexture and GPUBuffer. */
export interface GpuResource {
  destroy(): void;
}
