import { parseSaveFile, serializeSaveFile, type ProjectData, type SaveFile, SAVE_FORMAT_VERSION } from './save-load.js';

// URL-based project sharing. Encodes a project as
//   ?json=<deflate-raw-compressed-base64url>
// so the entire scene fits in a copy-paste link. Round-trip is:
//
//   serialize SaveFile → JSON.stringify (no whitespace padding)
//                     → CompressionStream('deflate-raw')
//                     → base64url (URL-safe alphabet, no padding =)
//                     → URL search param
//
// Decode reverses each step. We strip the workspace LAYOUT (panel
// arrangement, viewports, cameras-per-panel) before encoding — those
// are per-session UX, not "what scene is this," and keeping them out
// halves typical URL length. The receiver's existing layout is
// preserved.

const URL_JSON_PARAM = 'json';
const URL_SCENE_PARAM = 'scene';
const URL_ANIM_PARAM = 'anim';

/** Read `?scene=<id>` synchronously; null if missing. */
export function getUrlSceneId(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(URL_SCENE_PARAM);
}

/** Read `?json=<base64url>` synchronously; null if missing. */
export function getUrlJsonParam(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get(URL_JSON_PARAM);
}

/**
 * Read `?anim=true` (or `?anim=1`) synchronously. Returns false for
 * any other value, including missing. Used by main.tsx to kick off
 * the render-bus animation loop on boot — so a shared URL can land
 * the recipient already playing instead of forcing them to click
 * the toolbar's play button.
 */
export function getUrlAnim(): boolean {
  if (typeof window === 'undefined') return false;
  const v = new URLSearchParams(window.location.search).get(URL_ANIM_PARAM);
  return v === 'true' || v === '1';
}

// URL-safe base64 (RFC 4648 §5) — replace + with -, / with _, drop
// `=` padding. The decoder restores padding before calling atob().
function toBase64Url(bytes: Uint8Array): string {
  // btoa wants a binary string. Stitching via fromCharCode in chunks
  // avoids "Maximum call stack" on large payloads — apply() spreads
  // every byte as a separate argument otherwise.
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (std.length % 4)) % 4;
  const bin = atob(std + '='.repeat(pad));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Build a SaveFile from just the project portion. Layout is omitted —
 * shareable links shouldn't impose the sender's pane arrangement on
 * the receiver. The receiver loads ONLY the project content; their
 * existing dockview / canvas pins stay intact.
 */
export function buildShareableSaveFile(project: ProjectData): SaveFile {
  return { formatVersion: SAVE_FORMAT_VERSION, project };
}

/**
 * Encode a SaveFile to a complete shareable URL. The result starts
 * with the current page's origin + path, with the search string
 * replaced by `?json=<encoded>` (any existing params are dropped so
 * a `?scene=basic` on the active page doesn't leak into the link).
 */
export async function encodeProjectToUrl(file: SaveFile): Promise<string> {
  const json = serializeSaveFile(file);
  const jsonBytes = new TextEncoder().encode(json);
  const stream = new Blob([jsonBytes as BufferSource]).stream().pipeThrough(
    new CompressionStream('deflate-raw'),
  );
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const b64 = toBase64Url(compressed);
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set(URL_JSON_PARAM, b64);
  return url.toString();
}

/** Decode a base64url-compressed JSON param into a parsed SaveFile. */
export async function decodeProjectFromUrl(jsonParam: string): Promise<SaveFile> {
  const compressed = fromBase64Url(jsonParam);
  const stream = new Blob([compressed as BufferSource]).stream().pipeThrough(
    new DecompressionStream('deflate-raw'),
  );
  const json = await new Response(stream).text();
  return parseSaveFile(json);
}
