import type { OutputDef } from '../core/node-def.js';
import { createCoreTypeRegistry } from '../core/types.js';

// Output-bar colour helpers, shared between:
//   • the in-canvas custom-node renderer (the 5-px stripe at the top
//     of every node header),
//   • the Nodes-panel browser tiles (a 3-px stripe across the top of
//     each tile, mirroring the canvas convention so users learn one
//     palette once),
//   • the Assets-panel subgraph tiles (same 3-px stripe, driven by the
//     subgraph wrapper's outputs).
//
// Keeping these in their own JSX-free module avoids dragging
// custom-node's entire React surface into the panels just to read a
// colour.

const types = createCoreTypeRegistry();

/** Resolve a socket-type id (`'Float'`, `'Texture2D'`, …) to its display
 * colour from the core type registry. Falls back to a neutral grey when
 * the type isn't registered (defensive — shouldn't happen for core nodes). */
export function typeColor(typeId: string): string {
  return types.get(typeId)?.color ?? '#888';
}

/**
 * CSS `background` value for an output-type bar.
 *
 *   • 0 outputs → 'transparent'
 *   • 1 output  → solid `typeColor(...)`
 *   • N outputs → hard-stop horizontal gradient, each output occupying
 *                 an equal-width segment in declared order
 *
 * The hard-stop gradient (no smooth interpolation) is what makes a
 * multi-output node read as N discrete coloured bands rather than a
 * blurry sweep.
 *
 * Accepts anything with an `outputs` array — `NodeDef`, `SubgraphDef`,
 * or any other shape that carries the same structural slice. The
 * actual function only ever reads `.outputs[i].type`.
 */
export function outputBarBackground(def: {
  outputs: ReadonlyArray<OutputDef>;
}): string {
  if (def.outputs.length === 0) return 'transparent';
  if (def.outputs.length === 1) {
    return typeColor(def.outputs[0]!.type);
  }
  const stops: string[] = [];
  const n = def.outputs.length;
  for (let i = 0; i < n; i++) {
    const color = typeColor(def.outputs[i]!.type);
    const a = (i / n) * 100;
    const b = ((i + 1) / n) * 100;
    stops.push(`${color} ${a}%`, `${color} ${b}%`);
  }
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
