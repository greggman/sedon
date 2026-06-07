// Runtime fetch + parse of a demo's `.sedon` file. The build step
// (scripts/build.mjs) ran each demo's `build()` at build time, ran
// the result through `serializeSaveFile`, and dropped the bytes at
// `dist/demos/<id>.sedon`. This module is the load half: fetch the
// URL, parse via the existing save-load path, and hand back a
// `SaveFile` shape the same way `File → Load` does.
//
// Why we go through `parseSaveFile` rather than `JSON.parse` and a
// cast: parseSaveFile is where back-compat lives (v1 / v2 → v3
// promotion) and where the only-trusted-shape narrowing happens.
// Demos are saved with the same format as user files, so they get
// the same loader for free.

import { parseSaveFile, type SaveFile } from '../save-load.js';

// Demo files live under dist/demos/. The dev server and the
// production build both serve `dist/` from the site root via the
// build's `publicPath`, so the URL is `dist/demos/<id>.sedon`
// regardless of mode. Keeping this in one place lets a future
// move (e.g., to a CDN) be a one-line change.
function demoUrl(id: string): string {
  return `dist/demos/${encodeURIComponent(id)}.sedon`;
}

/**
 * Fetch `dist/demos/<id>.sedon` and parse it into a SaveFile. Throws
 * with a descriptive message on either fetch failure (network /
 * 404) or parse failure — both have actionable causes (build hasn't
 * run, or a demo's saved file got corrupted) and the loader caller
 * displays the error to the user.
 */
export async function loadDemoSaveFile(id: string): Promise<SaveFile> {
  const url = demoUrl(id);
  let response: Response;
  try {
    response = await fetch(url);
  } catch (e) {
    throw new Error(
      `Failed to fetch demo "${id}" from ${url}: ${e instanceof Error ? e.message : String(e)}. `
      + 'If you\'re running the dev server, make sure `node scripts/build.mjs` (or --serve) '
      + 'has run at least once to produce dist/demos/<id>.sedon files.',
    );
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch demo "${id}" from ${url}: HTTP ${response.status}. `
      + 'Either the demo id is unknown or the build step hasn\'t produced its .sedon file.',
    );
  }
  const text = await response.text();
  return parseSaveFile(text);
}
