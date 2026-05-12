# Leaf plan

## Scope and honest quality expectations

Produce leaf and foliage **textures** procedurally — RGBA cards (with
alpha for the outline) and matching normal maps — usable by future
forest/jungle scenes.

A note on quality up front: AAA leaf textures in shipped games are
typically photo-scanned or rendered from 3D models in Blender/3DS
Max with proper subsurface and lighting, then baked. A purely
procedural pipeline isn't going to match that out of the gate — what
it CAN do is produce good stylized leaves, decent mid-distance
foliage, and an authoring loop that's fast enough to iterate
species by species. Where we want to push closer to AAA, the lever
is to model leaves as actual 3D meshes (cards with displacement,
proper normals, instanced arrangements) and use a `scene-to-texture`
bake — same way Blender does it. The plan accommodates both.

How any of this gets *drawn* in a forest scene (alpha-to-coverage,
dithered stippling, sort order, wind, LOD) is out of scope for
this plan.

Target species: **oak, birch, maple, palm leaflet, pine needle,
fern leaflet, clover** + a generic parametric base. Where a species
is naturally compound (palm frond, fern, clover, pine cluster), the
compound version is built by instancing leaflet cards in 3D and
baking — see Phase 2.

---

## 1. Pipeline overview

Two complementary paths:

**Path A — 2D parametric, no mesh.** A single leaflet texture from
a fragment-shader-evaluated parametric outline + vein pattern,
colored and normal-mapped via existing texture nodes. Fast,
composable, fits the current pipeline. Good for: oak, birch, maple,
generic leaflets, the *leaflet input* to compound leaves.

**Path B — 3D meshes + scene-to-texture bake.** A small mesh card
carrying a Path-A leaflet texture, instanced N times in 3D space,
rendered to an offscreen texture. Good for: palm fronds, fern
fronds, clover, pine-needle clusters, anything that needs depth
overlap and per-leaflet shading.

Both paths output a Texture2D. Downstream nothing knows or cares
which path produced it.

---

## 2. Preview support

The current Texture2D preview is flat (no lighting, checkerboard
background) — already correct for noise textures. For leaves it
needs **one** change:

- Enable **standard alpha blending** in the flat-preview pipeline
  so transparent pixels in the texture composite over the
  checkerboard. Single shader/pipeline-state change.

This goes first — without it, every later step is "author blind."

---

## 3. Phase 1 — single leaflet textures (Path A)

All Path A. Outputs are Texture2D, evaluated by fragment shaders, no
geometry involved. Slots into the existing perlin/worley/blend
pipeline.

1. **`leaf/skeleton`** — parametric leaflet outline + vein pattern
   in one node. Two outputs:
   - `shape` (Texture2D, 2-channel: R = mask 0/1, G = signed
     distance from edge)
   - `veins` (Texture2D, 1-channel: vein density 0..1)

   Inputs:
   - `outline` (enum: `ovate` / `lanceolate` / `cordate` / `palmate`
     / `obovate` / `needle`) — picks the base parametric outline
   - `length`, `width`, `tipPointedness`, `baseCurvature`
   - `asymmetry`
   - `lobeCount`, `lobeDepth`, `lobeSharpness` (oak/maple)
   - `serrationAmplitude`, `serrationFrequency` (birch)
   - `branchCount`, `branchAngle`, `branchTaper` (primary veins)
   - `subBranchCount` (fine venation)
   - `seed`, `resolution`

   Implementation: a fragment shader evaluating distance to a
   parametric midrib + branch skeleton, plus an outline SDF derived
   from those same strokes (dilate by a width profile). One pass,
   one upload, same shape as `worley`.

2. **`leaf/colorize`** — composes RGBA. Inputs:
   - `shape`, `veins` from `leaf/skeleton`
   - `baseColor`, `veinColor`, `edgeColor` (Colors)
   - `edgeFalloff` (how far in from the edge `edgeColor` reaches)
   - `blotchTexture` (optional Texture2D — usually worley/perlin)
   - `blotchStrength`
   - `season` (0..1, spring → summer → autumn — biases palette)

   Output: Texture2D RGBA. RGB composed; alpha = shape mask.

3. **`leaf/normal`** — heightfield → normal map. Inputs:
   - `shape` (uses SDF channel for body bulge + edge falloff)
   - `veins` (etched as grooves)
   - `bodyHeight`, `veinDepth`, `edgeCurl`

   Output: Texture2D (RGB tangent-space normal).

   May start as a small subgraph using existing
   `core/normal-from-height` rather than a custom node.

**Done at end of Phase 1:** oak, birch, maple, generic ovate, pine
needle all buildable as subgraphs producing albedo + normal Texture2Ds.
Parameter changes alone get most species. They look stylized, not
photoreal, but they're proper leaves with vein detail.

---

## 4. Phase 2 — compound leaves via mesh + bake (Path B)

The bottleneck here is `scene-to-texture`. Once it exists, compound
leaves are subgraphs over existing primitives + instancing nodes.

4. **`scene/render-to-texture`** — bake any Scene to a Texture2D.
   Inputs:
   - `scene` (Scene)
   - `cameraPosition` (Vec3)
   - `cameraTarget` (Vec3)
   - `projection` (enum: `orthographic` / `perspective`)
   - `orthoSize` (Vec2, when orthographic — defines world-units fit
     into the texture)
   - `fov` (when perspective)
   - `lighting` (Lighting — optional; if absent, render unlit and
     let the future PBR runtime apply lighting later)
   - `resolution` (Vec2i)
   - `clearColor` (Color, defaults to fully-transparent)

   Output: Texture2D RGBA. Alpha 1 where the scene drew, 0 where it
   didn't.

   Implementation: a slimmed-down reuse of the main scene renderer
   rendering to an offscreen target. No bloom or tonemap (or
   optional, behind a flag). Output is pre-multiplied alpha so
   downstream `leaf/compose-2d` blends correctly.

   Independently useful for: flowers, mushrooms, dirt-patch
   textures, debris, decals.

5. **Mesh primitive: `leaf/card`** — a single quad with the leaf
   texture and normal applied via PBR. Just `core/plane` + a leaf
   material. Probably built as a tiny subgraph rather than its own
   node.

6. **Compound leaves** — subgraphs combining existing primitives:
   - **Clover:** 3 (or 4) `leaf/card` instances arranged radially,
     fed to `scene/render-to-texture`. Existing
     `instance-geometry-on-points` + a "radial point" generator
     does this; we may need to add **`grid-distribute-radial`** or
     similar if a fitting point-emitter doesn't already exist.
   - **Palm frond:** ~30 `leaf/card` instances arrayed linearly
     along a slight curve, baked. Same machinery.
   - **Fern frond:** recursive — the fern leaflet is itself a small
     pinnate arrangement, baked, used as the texture for the next
     level up. Two levels gets a believable fern.
   - **Pine cluster:** N needle-cards in a radial fan from a center,
     baked. Same as clover but with needle texture and more
     count.

**Done at end of Phase 2:** clover, palm, fern, pine all available
as one-card textures suitable for billboard use, built by composing
Phase 1 leaflets into 3D arrangements and baking.

---

## 5. Phase 3 — out of scope (rendering integration, future)

For when leaves actually go on trees in scenes. NOT part of this
plan, listed so the design space is visible:

- `alphaCutoff` on PbrMaterial (hard cutout, cheap, no sorting
  needed)
- Alpha-to-coverage path (smooth edges with MSAA)
- Dithered/stipple alpha (UE5-style screen-space dither —
  cheap and works without MSAA)
- Bush meshes — N intersecting plane cards using these leaf
  textures, scattered onto tree branches
- Per-fragment wind sway

All of these are rendering choices that read the alpha channel of
the leaf textures Phase 1/2 produce. The texture pipeline doesn't
care which the runtime picks.

---

## 6. Suggested order

1. **Preview alpha blending** — unblocks visual authoring.
2. **`leaf/skeleton`** — foundational Path A node.
3. **`leaf/colorize`** — leaves with color.
4. **`leaf/normal`** — leaves with surface detail.
5. End-to-end **oak-leaf subgraph** as a proof. Birch and maple
   follow as parameter variations.
6. **`scene/render-to-texture`** — unblocks Path B.
7. **Clover and pine cluster** subgraphs — simplest Path B cases,
   shake out the bake pipeline.
8. **Palm frond, fern frond** — full Path B.

---

## 7. Open design questions

- **Texture-level compound (`leaf/compose-2d` blending leaflets in
  2D) vs always-mesh-and-bake?** Previous draft of this plan had a
  2D-only compound option. Dropped — quality is too compromised
  (no depth, no overlap shading, no per-leaflet normal variation).
  Path B is the answer for compound shapes.
- **Render bake unlit or with simple lighting?** Probably an option.
  Unlit gives a "clean" albedo texture that the future PBR runtime
  re-lights. With-lighting bakes in environment ambient and
  silhouette shading — gives more depth at the cost of being tied
  to one lighting condition. Default unlit, expose a flag.
- **One node or two for skeleton+shape?** Bundled. Same parametric
  math drives both. Split later if authoring asks.
- **Resolution defaults.** ~256 for individual leaflets, ~1024 for
  baked compounds (a fern frond needs more pixels than a single
  oak leaf).
- **`leaf/skeleton` on CPU or GPU?** GPU fragment shader, matches
  the existing worley/perlin pattern. CPU only if profiling shows
  uniform buffer overhead matters.
