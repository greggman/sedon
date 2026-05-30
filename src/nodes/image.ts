import { useEffect, useState } from 'react';
import type { NodeDef } from '../core/node-def.js';
import type { Texture2DValue } from '../core/resources.js';
import { requireDevice, reusableTexture } from '../core/resources.js';

// core/image — reference an external PNG / JPG / WEBP by URL, decode
// it via fetch + createImageBitmap, upload to a GPU texture. Output
// is a Texture2D consumable anywhere a generated texture would be.
//
// Async loading flow (cache + bus + dynamic fingerprint):
//   1. Evaluate looks up the URL in a module-level bitmap cache.
//   2. If the bitmap is loaded → allocate a texture at the bitmap's
//      natural dims, copyExternalImageToTexture, return.
//   3. If the bitmap is still loading (or just being kicked off) →
//      allocate a placeholder texture at the saved width/height
//      hidden inputs, fill with magenta, return. Downstream nodes
//      see a stable size while the fetch is in flight.
//   4. When the fetch lands, the cache entry's `version` bumps and
//      the load-bus fires. The editor's preview hook re-runs eval;
//      this node's `dynamicFingerprintExtra` returns the new version,
//      the eval-cache misses, evaluate runs again with the bitmap in
//      hand, and the real texture takes over.
//
// CORS gotcha: only servers that send `Access-Control-Allow-Origin`
// are usable. GitHub raw, imgur direct CDN, githack work; many random
// hosts don't. Failed fetches stamp a magenta placeholder so the
// downstream chain stays valid.

const TEXTURE_FORMAT: GPUTextureFormat = 'rgba8unorm';

interface ImageRecord {
  bitmap: ImageBitmap | null;
  status: 'loading' | 'loaded' | 'error';
  error?: string;
  version: number;
}

const cache = new Map<string, ImageRecord>();
const epochSubscribers = new Set<() => void>();
let loadedListener:
  | ((event: { url: string; width: number; height: number }) => void)
  | null = null;

/** Per-URL load version. Mixed into the image node's fingerprint so
 *  the eval cache misses on the round that follows a fetch landing. */
export function getImageVersion(url: string): number {
  return cache.get(url)?.version ?? 0;
}

/** Returns the cached ImageBitmap (or null if not yet loaded). When
 *  no entry exists, kicks off the fetch + decode asynchronously. */
export function ensureImageLoading(url: string): ImageBitmap | null {
  if (!url) return null;
  const existing = cache.get(url);
  if (existing) return existing.status === 'loaded' ? existing.bitmap : null;

  const record: ImageRecord = { bitmap: null, status: 'loading', version: 0 };
  cache.set(url, record);
  fetchAndDecode(url).then(
    (bitmap) => {
      const r = cache.get(url);
      if (!r) return;
      r.bitmap = bitmap;
      r.status = 'loaded';
      r.version++;
      bumpEpoch();
      if (loadedListener) loadedListener({ url, width: bitmap.width, height: bitmap.height });
    },
    (err) => {
      const r = cache.get(url);
      if (!r) return;
      r.status = 'error';
      r.error = err instanceof Error ? err.message : String(err);
      r.version++;
      bumpEpoch();
    },
  );
  return null;
}

async function fetchAndDecode(url: string): Promise<ImageBitmap> {
  const resp = await fetch(url, { mode: 'cors' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  return await createImageBitmap(blob);
}

function bumpEpoch(): void {
  // Snapshot — subscribers may unregister during dispatch.
  for (const cb of [...epochSubscribers]) cb();
}

/** Subscribe to "an image just finished loading (or errored)" pulses.
 *  Returned function unsubscribes. */
export function subscribeImageEpoch(cb: () => void): () => void {
  epochSubscribers.add(cb);
  return () => {
    epochSubscribers.delete(cb);
  };
}

let imageLoadGeneration = 0;
function bumpImageGeneration(): void {
  imageLoadGeneration++;
}
// Bump the generation counter inside the bus dispatch so the React
// hook below can read it as a deps signal.
epochSubscribers.add(bumpImageGeneration);

/** React hook returning a counter that increments whenever an image
 *  load (or error) completes. Add to a `useEffect` dep array to re-run
 *  effects (like the preview's evaluate loop) after a fetch lands. */
export function useImageLoadGeneration(): number {
  const [gen, setGen] = useState(imageLoadGeneration);
  useEffect(() => {
    return subscribeImageEpoch(() => setGen(imageLoadGeneration));
  }, []);
  return gen;
}

/** Register a single listener that fires whenever an image lands.
 *  The editor uses this to write the natural width / height back
 *  into the node's hidden inputValues so a future reload's placeholder
 *  matches the real image dims. Only one listener (last wins). */
export function setImageLoadedListener(
  cb: ((event: { url: string; width: number; height: number }) => void) | null,
): void {
  loadedListener = cb;
}

// Placeholder pattern: a 1×1 magenta filled into a wider texture by
// the queue.writeTexture clear. Cheap and unmistakable downstream.
const MAGENTA_PIXEL = new Uint8Array([255, 0, 255, 255]);

function stampPlaceholder(device: GPUDevice, texture: GPUTexture, width: number, height: number): void {
  // Fill every texel by writing one row of magenta via repeated writes.
  // For small placeholder sizes this is fine; an all-magenta texture
  // doesn't need a fancy render pass.
  const row = new Uint8Array(width * 4);
  for (let i = 0; i < width; i++) row.set(MAGENTA_PIXEL, i * 4);
  for (let y = 0; y < height; y++) {
    device.queue.writeTexture(
      { texture, origin: [0, y] },
      row,
      { bytesPerRow: width * 4 },
      [width, 1],
    );
  }
}

export const imageNode: NodeDef = {
  id: 'core/image',
  category: 'Texture/Generators',
  inputs: [
    {
      name: 'url',
      type: 'String',
      default: '',
      hideSocket: true,
      description:
        'absolute URL of a PNG / JPG / WEBP. Must be served with CORS headers (GitHub raw, imgur direct CDN, githack). Empty URL renders a magenta placeholder',
    },
    {
      // Hidden width / height — auto-populated by the editor when an
      // image lands so a future graph reload's placeholder matches the
      // real image dims. Not user-editable; the inspector skips them.
      name: 'width',
      type: 'Int',
      default: 256,
      min: 1,
      hidden: true,
    },
    {
      name: 'height',
      type: 'Int',
      default: 256,
      min: 1,
      hidden: true,
    },
  ],
  outputs: [
    {
      name: 'texture',
      type: 'Texture2D',
      description:
        'the decoded image as a GPU texture. Allocated at the image\'s natural dimensions once loaded; a magenta placeholder at the saved `[width, height]` covers the loading / error states',
    },
  ],
  doc: {
    summary: 'Load a PNG / JPG / WEBP image from a URL as a Texture2D.',
  },
  // Mix the per-URL load version into the cache key so the eval cache
  // misses on the round after the fetch lands. Without this, the
  // first eval (placeholder) gets cached and subsequent rounds keep
  // returning that even after the bitmap is available.
  dynamicFingerprintExtra(inputs) {
    const url = (inputs.url as string) ?? '';
    return `imgv:${getImageVersion(url)}`;
  },
  evaluate(ctx, inputs): { texture: Texture2DValue } {
    const device = requireDevice(ctx);
    const url = (inputs.url as string) ?? '';
    const savedWidth = inputs.width as number;
    const savedHeight = inputs.height as number;

    const bitmap = ensureImageLoading(url);
    const prev = ctx.previousOutput as { texture?: Texture2DValue } | undefined;

    if (bitmap) {
      const out = reusableTexture(device, prev?.texture, {
        width: bitmap.width,
        height: bitmap.height,
        format: TEXTURE_FORMAT,
        usage:
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.RENDER_ATTACHMENT,
        label: `image:${url}`,
      });
      device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture: out.texture },
        [bitmap.width, bitmap.height],
      );
      return { texture: out };
    }

    // Placeholder path: loading, errored, or no URL.
    const out = reusableTexture(device, prev?.texture, {
      width: savedWidth,
      height: savedHeight,
      format: TEXTURE_FORMAT,
      usage:
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT,
      label: `image-placeholder:${url}`,
    });
    stampPlaceholder(device, out.texture, savedWidth, savedHeight);
    return { texture: out };
  },
};
