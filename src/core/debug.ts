// Single chokepoint for the project's "diagnostic-only" logging.
//
// Pattern: `debug(() => `...`)`. The thunk is what makes
// this worth its keep — when the debug flag is off, the callback
// never runs, so any expensive string building (JSON.stringify, GPU
// id lookups, eval-result walks) costs nothing in production.
//
// Enable in the running app with `globalThis.__DEBUG_SCENE_PREVIEW__ = true`
// in devtools, or by appending `?debug=1` to the URL when paired with
// the main.tsx hook that exposes the editor store for Puppeteer
// drivers. The flag name kept its original "scene preview" framing for
// the sake of git history; in practice every debug-gated log in the
// project funnels through this helper.

export function debug(...args: (string | number | object | boolean | null | undefined | (() => void))[]): void {
  if (typeof (globalThis as { __DEBUG_SCENE_PREVIEW__?: boolean }).__DEBUG_SCENE_PREVIEW__ !== 'undefined') {
    const values = args.map(v => (typeof v === 'function' ? v() : v));
    console.log(...values);
  }
}
