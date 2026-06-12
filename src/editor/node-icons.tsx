import type { ReactNode } from 'react';

// Static icons for nodes whose Sample-graph output isn't visually
// previewable (math, anim/time-base, vec conversions, paths) but which
// have a recognisable symbol or glyph that reads well at thumbnail
// size. Looked up by node id from NodeTile's fallback path — if a node
// has a renderable Sample-graph output (Texture2D / Geometry / Scene),
// the live preview takes precedence and this map is ignored.
//
// The registry is intentionally a flat record so adding an icon for a
// new node is one line. Two helpers handle the most common shapes:
//
//   • TextIcon — for nodes with a clean single-glyph identity
//     (`+`, `×`, `Δ`, `⏱`, etc.). Renders at 44px so it sits inside
//     the 64-px placeholder box with breathing room.
//   • SvgIcon — for nodes that need a hand-drawn graphic (sine wave,
//     sawtooth, vec3 split / merge arrows, bezier handles, …).
//     viewBox is 0–24 by default; stroke uses currentColor so the
//     icon picks up the tile's text colour.
//
// SVG strokes use currentColor so the asset/node tile's foreground
// colour applies; no per-icon palette to maintain. Stroke style is
// uniform across the set (1.5 width, round caps, round joins) so
// icons sit together visually on the grid.

// Pixel size the icon renders at, inside the 64-px placeholder box.
// 44 leaves ~10 px of padding on each side — visible breathing room
// but the icon still reads at a glance.
const ICON_SIZE = 44;

function SvgIcon({
  children,
  viewBox = '0 0 24 24',
}: {
  children: ReactNode;
  viewBox?: string;
}) {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function TextIcon({
  text,
  size = ICON_SIZE,
}: {
  text: string;
  size?: number;
}) {
  return (
    <span
      style={{
        fontSize: size,
        lineHeight: 1,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
      aria-hidden="true"
    >
      {text}
    </span>
  );
}

// Each entry is a thunk so the JSX isn't allocated until the icon is
// actually rendered (cheap, but the tile grid is big and we only need
// the icons for VISIBLE tiles).
const ICONS: Record<string, () => ReactNode> = {
  // ----- math -----
  'math/add': () => <TextIcon text="+" />,
  'math/multiply': () => <TextIcon text="×" />,
  'math/mix': () => (
    // Two endpoints with a slider mid-way — the lerp factor visualisation.
    <SvgIcon>
      <circle cx="4" cy="12" r="2.5" />
      <circle cx="20" cy="12" r="2.5" />
      <line x1="6.5" y1="12" x2="17.5" y2="12" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </SvgIcon>
  ),
  'math/map-range': () => (
    // Two parallel "rulers" with cross-arrows showing the remap from
    // one range to another.
    <SvgIcon>
      <line x1="3" y1="7" x2="21" y2="7" />
      <line x1="3" y1="17" x2="21" y2="17" />
      <line x1="3" y1="5" x2="3" y2="9" />
      <line x1="21" y1="5" x2="21" y2="9" />
      <line x1="3" y1="15" x2="3" y2="19" />
      <line x1="21" y1="15" x2="21" y2="19" />
      <line x1="7" y1="7" x2="11" y2="17" />
      <line x1="17" y1="7" x2="13" y2="17" />
    </SvgIcon>
  ),
  'math/floats-from-vec3': () => (
    // One input line splits into three arrows — the dual of vec3-from-floats.
    <SvgIcon>
      <line x1="2" y1="12" x2="10" y2="12" />
      <line x1="10" y1="12" x2="18" y2="5" />
      <line x1="10" y1="12" x2="20" y2="12" />
      <line x1="10" y1="12" x2="18" y2="19" />
      <polyline points="15.5,4 18,5 17,7.5" />
      <polyline points="17,10 20,12 17,14" />
      <polyline points="17,16.5 18,19 15.5,20" />
    </SvgIcon>
  ),
  'math/vec3-from-floats': () => (
    // Three input lines converge into a single output arrow.
    <SvgIcon>
      <line x1="4" y1="5" x2="14" y2="12" />
      <line x1="4" y1="12" x2="14" y2="12" />
      <line x1="4" y1="19" x2="14" y2="12" />
      <line x1="14" y1="12" x2="22" y2="12" />
      <polyline points="19,10 22,12 19,14" />
    </SvgIcon>
  ),

  // ----- animation -----
  'anim/time': () => <TextIcon text="⏱" size={40} />,
  'anim/delta': () => <TextIcon text="Δ" />,
  'anim/sine': () => (
    // Sine wave: one up-hump, one down-hump using smooth bezier T.
    <SvgIcon>
      <path d="M 2 12 Q 6 4 10 12 T 18 12" />
    </SvgIcon>
  ),
  'anim/lfo': () => (
    // Sawtooth: linear rise then instant drop, four teeth across the box.
    <SvgIcon>
      <path d="M 2 18 L 6 6 L 6 18 L 10 6 L 10 18 L 14 6 L 14 18 L 18 6 L 18 18 L 22 6" />
    </SvgIcon>
  ),

  // ----- paths -----
  'path/spline': () => (
    // Cubic bezier with two anchor points (filled) and two control
    // points (smaller, dashed lines to anchors). The classic
    // pen-tool visual.
    <SvgIcon>
      <line x1="4" y1="18" x2="10" y2="6" strokeDasharray="2,2" />
      <line x1="20" y1="6" x2="14" y2="18" strokeDasharray="2,2" />
      <path d="M 4 18 C 10 6, 14 18, 20 6" strokeWidth="2" />
      <circle cx="4" cy="18" r="1.8" fill="currentColor" />
      <circle cx="20" cy="6" r="1.8" fill="currentColor" />
      <circle cx="10" cy="6" r="1.3" />
      <circle cx="14" cy="18" r="1.3" />
    </SvgIcon>
  ),
  'path/curve-2d': () => (
    // S-curve — the 2D editor's signature shape.
    <SvgIcon>
      <path d="M 2 7 C 9 7, 9 17, 16 17 S 22 7, 22 7" strokeWidth="2" />
    </SvgIcon>
  ),

  // ----- geometry composition -----
  'geom/merge': () => (
    // Two diagonal inputs and one merged output arrow.
    <SvgIcon>
      <line x1="3" y1="5" x2="12" y2="12" />
      <line x1="3" y1="19" x2="12" y2="12" />
      <line x1="12" y1="12" x2="22" y2="12" />
      <polyline points="19,10 22,12 19,14" />
    </SvgIcon>
  ),
  'geom/mirror': () => (
    // Dashed axis with mirrored triangles on each side.
    <SvgIcon>
      <line x1="12" y1="3" x2="12" y2="21" strokeDasharray="2,2" />
      <polygon points="3,8 9,12 3,16" fill="currentColor" />
      <polygon points="21,8 15,12 21,16" fill="currentColor" />
    </SvgIcon>
  ),
  'geom/transform': () => (
    // Cross of four arrows — the standard "move/transform" gizmo.
    <SvgIcon>
      <line x1="12" y1="4" x2="12" y2="20" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <polyline points="9,7 12,4 15,7" />
      <polyline points="9,17 12,20 15,17" />
      <polyline points="7,9 4,12 7,15" />
      <polyline points="17,9 20,12 17,15" />
    </SvgIcon>
  ),
  'geom/compute-normals': () => (
    // Surface (horizontal line) with three normal arrows pointing up.
    <SvgIcon>
      <line x1="2" y1="20" x2="22" y2="20" />
      <line x1="6" y1="20" x2="6" y2="10" />
      <polyline points="4,12 6,10 8,12" />
      <line x1="12" y1="20" x2="12" y2="8" />
      <polyline points="10,10 12,8 14,10" />
      <line x1="18" y1="20" x2="18" y2="10" />
      <polyline points="16,12 18,10 20,12" />
    </SvgIcon>
  ),

  // ----- iteration / output -----
  'iter/for-each-point': () => (
    // Three dots traversed by a curved loop arrow.
    <SvgIcon>
      <circle cx="6" cy="6" r="1.5" fill="currentColor" />
      <circle cx="12" cy="6" r="1.5" fill="currentColor" />
      <circle cx="18" cy="6" r="1.5" fill="currentColor" />
      <path d="M 18 10 A 9 9 0 1 1 6 10" />
      <polyline points="4,8 6,10 8,8" />
    </SvgIcon>
  ),
  'iter/for-each-polygon': () => (
    // Triangle (polygon) traversed by a curved loop arrow.
    <SvgIcon>
      <polygon points="12,4 19,9 16,17 8,17 5,9" />
      <path d="M 19 13 A 9 9 0 1 1 7 13" stroke="currentColor" />
      <polyline points="5,11 7,13 9,11" />
    </SvgIcon>
  ),
  'core/output': () => (
    // Play-triangle pointing right — the universal "this is the output" mark.
    <SvgIcon>
      <polygon points="6,4 6,20 20,12" fill="currentColor" />
    </SvgIcon>
  ),

  // ----- selection -----
  'geom/select-by-angle': () => (
    // Two intersecting edges with an angle arc — the "select faces
    // whose dihedral angle …" idea.
    <SvgIcon>
      <line x1="3" y1="20" x2="21" y2="20" />
      <line x1="3" y1="20" x2="14" y2="6" />
      <path d="M 11 20 A 8 8 0 0 0 8 14" />
    </SvgIcon>
  ),
  'geom/select-by-normal': () => (
    // Surface with a normal arrow plus a small selection dot.
    <SvgIcon>
      <line x1="3" y1="18" x2="21" y2="18" />
      <line x1="12" y1="18" x2="12" y2="6" />
      <polyline points="9,9 12,6 15,9" />
      <circle cx="18" cy="6" r="1.8" fill="currentColor" />
    </SvgIcon>
  ),
  'geom/select-combine': () => (
    // Venn-style overlapping circles — union / intersection / xor
    // are all combinations of two selection sets.
    <SvgIcon>
      <circle cx="9" cy="12" r="6" />
      <circle cx="15" cy="12" r="6" />
    </SvgIcon>
  ),
  'geom/select-invert': () => (
    // Filled disc with a hollow ring around it — "the OTHER part".
    <SvgIcon>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4.5" fill="currentColor" />
    </SvgIcon>
  ),

  // ----- material -----
  'material/pbr': () => (
    // Sphere with a soft shading hint — the standard PBR ball preview.
    <SvgIcon>
      <circle cx="12" cy="12" r="9" />
      <path d="M 6 10 A 7 7 0 0 1 14 6" strokeWidth="2.5" />
    </SvgIcon>
  ),
  'material/terrain': () => (
    // Three horizontal stacked layers — the multi-layer terrain
    // material concept (rock / soil / vegetation).
    <SvgIcon>
      <path d="M 2 18 Q 8 16 12 18 T 22 18" />
      <path d="M 2 13 Q 8 11 12 13 T 22 13" />
      <path d="M 2 8 Q 8 6 12 8 T 22 8" />
    </SvgIcon>
  ),

  // ----- polygons -----
  'poly/list': () => (
    // Three overlapping triangles — a list of polygons.
    <SvgIcon>
      <polygon points="4,18 12,4 18,14" />
      <polygon points="9,20 17,8 21,18" />
    </SvgIcon>
  ),
  'poly/from-points': () => (
    // Four dots wired up into a polygon outline.
    <SvgIcon>
      <polygon points="5,18 12,4 20,10 16,20" />
      <circle cx="5" cy="18" r="1.5" fill="currentColor" />
      <circle cx="12" cy="4" r="1.5" fill="currentColor" />
      <circle cx="20" cy="10" r="1.5" fill="currentColor" />
      <circle cx="16" cy="20" r="1.5" fill="currentColor" />
    </SvgIcon>
  ),
  'poly/offset': () => (
    // Inner polygon with an outset (offset) outline.
    <SvgIcon>
      <polygon points="8,16 12,8 17,15" />
      <polygon points="4,19 12,3 21,17" strokeDasharray="2,2" />
    </SvgIcon>
  ),
  'poly/grid-subdivide': () => (
    // Triangle with internal cross-hatched grid lines.
    <SvgIcon>
      <polygon points="4,20 12,4 20,20" />
      <line x1="8" y1="20" x2="11" y2="12" />
      <line x1="12" y1="20" x2="13" y2="12" />
      <line x1="16" y1="20" x2="15" y2="12" />
      <line x1="9" y1="16" x2="15" y2="16" />
    </SvgIcon>
  ),

  // ----- cloud (FloatCloud / Vec3Cloud) -----
  'cloud/accumulate': () => <TextIcon text="∑" />,
  'cloud/vec3-from-floats': () => (
    // Three dotted streams converging — same shape as math version
    // but stroke-dashed to read as "cloud / per-element" data.
    <SvgIcon>
      <line x1="4" y1="5" x2="14" y2="12" strokeDasharray="2,2" />
      <line x1="4" y1="12" x2="14" y2="12" strokeDasharray="2,2" />
      <line x1="4" y1="19" x2="14" y2="12" strokeDasharray="2,2" />
      <line x1="14" y1="12" x2="22" y2="12" strokeDasharray="2,2" />
      <polyline points="19,10 22,12 19,14" />
    </SvgIcon>
  ),
};

/**
 * Look up a custom icon for a node id. Returns null when the node
 * isn't in the registry — the caller falls back to its default glyph.
 */
export function getNodeIcon(id: string): ReactNode | null {
  const factory = ICONS[id];
  return factory ? factory() : null;
}

// Pastel tints by id prefix. These complement the canvas-style output
// stripe at the top of each tile: the stripe says "what comes out"
// (Float / Texture2D / Geometry / …), while the tint says "what family
// is this in" (math vs anim vs path vs geom vs …). Without the tint,
// two nodes from different families that share an output type read as
// the same colour — e.g. all `anim/*` and `math/*` nodes produce Float
// and would look identical on the stripe alone.
//
// Tints are deliberately low-saturation pastels so they don't fight the
// dark UI background, and `currentColor` plumbing in `SvgIcon` and
// `TextIcon` means the entry here is the single point of truth.
// Saturated pastels — strong enough to distinguish adjacent families at
// a glance (the previous near-grey set let anim/math/path bleed into
// each other). Lightness stays high (~70%) so they still read against
// the dark UI; saturation bumped from ~30% to ~55%.
//
// Hue pairs that previously collided:
//   • math/leaf/points/scene (all greenish) → split into green / lime /
//     mint / teal at distinct hues
//   • anim/tex (both pinkish)               → rose vs coral
//   • iter/cloud (both purple)              → blue-violet vs magenta
//   • geom/material/terrain/branch (earthy) → orange / yellow / sand / wood
const CATEGORY_TINTS: Record<string, string> = {
  math: '#8edda3',     // sage / green
  anim: '#f0a3c0',     // rose / pink
  path: '#8dcfe0',     // sky / cyan
  geom: '#f0a878',     // orange-peach
  iter: '#a890e8',     // blue-violet
  points: '#8ee0d4',   // mint
  cloud: '#d4a0ec',    // magenta-lean lilac
  branch: '#c89868',   // wood / warm brown
  poly: '#a8bfd8',     // slate-blue
  polyline: '#a8bfd8', // slate-blue (same family as poly)
  material: '#ecd078', // yellow
  scene: '#80c8c2',    // teal
  terrain: '#d8a868',  // sandy
  water: '#85b4e0',    // blue
  leaf: '#a8e078',     // lime green
  core: '#bcbcbc',     // neutral grey
  tex: '#e88c8c',      // coral (mostly unused — texture tiles show live previews)
};

const FALLBACK_TINT = '#cccccc';

/**
 * Category tint for a node id (the colour SVG strokes / text icons
 * should pick up). Looks up the prefix-before-first-/ in
 * `CATEGORY_TINTS`. Unrecognised prefixes fall back to a neutral grey
 * — better than throwing for an opt-in cosmetic feature.
 */
export function categoryColorFor(id: string): string {
  const slash = id.indexOf('/');
  const prefix = slash < 0 ? id : id.slice(0, slash);
  return CATEGORY_TINTS[prefix] ?? FALLBACK_TINT;
}
