// Ambient declarations for asset imports handled by esbuild's `file`
// loader (see scripts/build.mjs). Each import resolves to a string —
// the emitted URL of the copied asset (e.g. "/dist/octocat-icon-XXXX.svg").
// TypeScript otherwise has no idea what a `.svg`/`.png`/… module is.
declare module '*.svg' {
  const url: string;
  export default url;
}
declare module '*.png' {
  const url: string;
  export default url;
}
declare module '*.jpg' {
  const url: string;
  export default url;
}
declare module '*.mp4' {
  const url: string;
  export default url;
}
declare module '*.mp3' {
  const url: string;
  export default url;
}
