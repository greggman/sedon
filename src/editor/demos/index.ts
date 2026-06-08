// Runtime metadata for the Demos menu. The actual graph data lives
// in `dist/demos/<id>.sedon` (produced by `scripts/build.mjs` at
// build time from `./_build-time.ts`) and is fetched on demand via
// `./demo-loader.ts`. Keeping this file metadata-only is what holds
// the demo bundles OUT of the runtime JS payload — the editor ships
// just labels and ids, ~1KB instead of ~3MB of baked graph data.
//
// Order here drives the order of demos in the menu / palette.

export interface DemoMeta {
  id: string;
  label: string;
}

export const DEMOS: DemoMeta[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'forest', label: 'Forest' },
  { id: 'furniture', label: 'Furniture' },
  { id: 'city', label: 'City' },
  { id: 'city-furniture-preview', label: 'City Furniture (preview)' },
  { id: 'city-buildings-preview', label: 'City Buildings (preview)' },
  { id: 'leaf', label: 'Leaf' },
  { id: 'tree-bush', label: 'Tree & Bush' },
  { id: 'grass-test', label: 'Grass Test' },
  { id: 'multi-layer-terrain', label: 'Terrain Layers (test)' },
  { id: 'cube-on-water', label: 'Cube on Water (reflection test)' },
  { id: 'for-each-point', label: 'For-Each-Point (cabinet test)' },
  { id: 'bevel-test', label: 'Bevel (direction test)' },
];
