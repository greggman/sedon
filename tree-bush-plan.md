# Tree & bush plan

## Scope and honest quality expectations

Produce trunk-and-branch **meshes** for trees and bushes, plus the
**point lists** that downstream nodes use to place leaves and
flowers. Targets: oak / birch / generic deciduous, generic bush,
pine (and other conifers), palm (and other unbranched single-stem
plants).

A note on quality up front: the procedural approach itself is not
the gap to AAA — SpeedTree's output is procedural too. The actual
gap is in three categories, roughly by impact:

1. **Authoring effort per species.** Shipped-AAA trees ride on
   art-directed parameter presets that took artists days or weeks
   each. The pipeline below can produce equivalent quality given
   that effort.
2. **Specific quality features.** Y-joint geometry blending where
   branches meet trunks, extra bark cards/fins for crevices,
   buttress roots, multi-card leaf clusters with depth. Listed
   below as out-of-scope, but they're real and worth adding later.
3. **Runtime concerns.** Leaf subsurface shader, anisotropic bark
   specular, LOD cross-fades, wind animation. Outside this plan's
   scope, but the meshes and point lists we emit have to be
   *structured* so the runtime side can pick them up later without
   re-generating assets (see section 6, Forward compatibility).

What this plan delivers out of the gate: stylized but believable
mid-distance trees, a fast species-by-species authoring loop, and
clean point lists for leaf and flower placement.

This plan covers **structure**: the trunk-and-branch skeleton, the
mesh swept around it, and the point lists sampled off it. Leaves
themselves (textures, cards, leaflet meshes) come from
`leaf-plan.md`. The two plans meet only at the point lists this
one emits.

---

## 1. Approach overview

**Curves first, geometry second.** Two decoupled stages:

1. **Generate a `BranchGraph`** — a graph of branch curves with
   per-vertex radius. One generator node per plant family
   (`recursive`, `whorled-pine`, `palm`, `space-colonization`, …).
   Different families branch in fundamentally different ways (a
   palm has no branching at all), so they get separate nodes
   rather than one universal generator with a `mode` enum.

2. **Realize the BranchGraph** — generic, family-agnostic nodes:
   - sweep a tapered tube around the curves → `Mesh`
   - sample points along the curves with filters → `Point` list
   - bend the curves under gravity / toward sun → `BranchGraph`

This separation means every species shares the same tube and
point-sampling code. The species-specific logic lives only in the
generator that produced the BranchGraph.

---

## 2. Core datatype: `BranchGraph`

A graph of branch curves. Minimum content:

- An ordered list of **branches**, each a polyline (list of
  vertices).
- Per-vertex attributes: `position` (Vec3), `radius` (float),
  `branchDepth` (int — 0 = trunk, 1 = primary, 2 = secondary, …),
  `arcLength` (float, distance along its own branch from its
  base).
- Per-branch attributes: `parentIndex` (int, -1 for root
  branches), `parentT` (float in 0..1, where along the parent it
  attaches).

That's enough for tube sweep (radius and position per vertex,
tangent from neighbors), point sampling (filter on depth, radius,
arc-length; attach offsets along a branch), and tropism (manipulate
positions only).

**Storage is named attribute arrays** (Houdini-style: per-vertex
and per-branch dictionaries of named float/int/vec arrays), not
a fixed struct. Adding new attributes — `age`, `branchPhase`,
`materialId` — is non-breaking. A fixed struct would force a
pipeline-wide rev for every new feature; we'd rather pay a small
indirection cost now.

Tangent / up / right frames are computed on demand from positions
via parallel transport rather than stored. Keeps the datatype small
and means tropism passes never have to maintain orientation
invariants.

---

## 3. Phase 1 — recursive branching, end to end

Build the foundation plus one family (recursive parametric
branching) good enough to author oak, birch, generic deciduous,
and generic bush.

1. **`branch/recursive`** — `BranchGraph` from parameters:
   - `trunkHeight`, `trunkRadius`, `trunkSegments`
   - `maxDepth` (recursion depth, 3–5 typical)
   - `branchesPerSegment` (count, with jitter)
   - `branchAngle`, `branchAngleJitter`
   - `lengthRatio` (child length ÷ parent length)
   - `radiusRatio` (child radius ÷ parent radius)
   - `branchCurvature` (per-branch in-plane bend as it grows)
   - `phyllotaxisAngle` (137.5° = golden, gives natural spirals)
   - `seed`

   Bush is the same node with shallow `maxDepth`, high
   `branchesPerSegment` near the root, and low `radiusRatio`.

2. **`branch/tube`** — `BranchGraph` → `Mesh`.
   - `sides` (cross-section count, 6–8 for distance, 16+ hero)
   - `uvTilingV` (along-branch tiling for bark textures)
   - Continuous taper from per-vertex radius. Branch-to-parent
     joins are plain intersection in Phase 1; Y-joint blending is
     a known follow-up (see open questions).
   - **Emitted vertex attributes (minimum):**
     - `branchDepth` (int) — for wind hierarchy, depth-blended
       bark materials
     - `branchId` (int, unique per branch) — for per-branch wind
       phase variation, decal scattering
     - `arcLengthAlongBranch` (float) — for wind sway falloff,
       bark V-tiling continuity, age-based shading

     Cheap to emit, very expensive to retrofit after meshes ship.
     These exist from day one even though no runtime currently
     reads them.

3. **`branch/sample-points`** — `BranchGraph` → `Point` list
   (positions + orientations).
   - Filters: `depthMin` / `depthMax`, `radiusMin` / `radiusMax`,
     `onlyTips`, `density` (points per unit arc length).
   - `orientationMode`: `along-branch` / `normal-to-branch` /
     `hemispherical-jitter`.
   - `seed`.

   Typical authored tree uses this node **twice** off the same
   BranchGraph: once tuned for leaf placement (thin twigs + tips,
   high density, hemispherical jitter), once tuned for flowers
   (tips only, lower density, own seed).

4. **`branch/tropism`** — `BranchGraph` → `BranchGraph`. Curve
   deformation pass.
   - `gravity` (per-depth weight curve — branches sag, trunks
     don't)
   - `phototropism` (Vec3 direction + strength — bend toward sun)
   - `wobble` (small noise displacement, breaks up procedural
     regularity)

   Cheap, stackable, massive naturalism payoff. Belongs in
   Phase 1 even though it's optional.

**Done at end of Phase 1:** an authored subgraph
`branch/recursive → branch/tropism → branch/tube` produces a
believable oak/birch trunk-and-branch mesh. A parallel branch
`(same BranchGraph) → branch/sample-points (twigs+tips) →
instance-geometry-on-points (leaf card)` puts leaves on it. A
third branch with a flower-filter `branch/sample-points` puts
flowers on it.

---

## 4. Phase 2 — other plant families (sketched)

Each is its own generator node outputting `BranchGraph`. Tube,
sample-points, and tropism are reused unchanged.

5. **`branch/whorled-pine`** — monopodial: a single dominant trunk
   with lateral branches in **whorls** (rings) at intervals.
   Covers pine, spruce, fir, especially young conifers.
   - `trunkHeight`, `trunkTaper`, `trunkLean`
   - `whorlCount`, `whorlSpacing` (or auto from height ÷ count)
   - `branchesPerWhorl` (4–7), `whorlPhaseOffset`
   - `branchLengthAtBase`, `branchLengthAtTop` (top whorls
     shorter → conical envelope)
   - `branchAngle`, `branchSag`
   - `subBranchDepth` (sparse secondary branching, 0 or 1)

6. **`branch/palm`** — single unbranched curving trunk with crown
   point at tip. Variant covers banana, tree fern, agave —
   single-stem unbranched morphologies generally.
   - `height`, `trunkRadiusBase`, `trunkRadiusTip`,
     `trunkSegments`
   - `leanAngle`, `leanCurvature` (palms curve)
   - Outputs a BranchGraph with **one** branch curve. Fronds are
     placed by a downstream `branch/sample-points` configured to
     grab the tip with N rotational copies, fed into
     `instance-geometry-on-points` with a frond mesh from the
     leaf pipeline.

7. **`branch/space-colonization`** — Runions et al.: scatter
   attractor points in a crown-shaped volume, grow branches toward
   nearest attractors, kill attractors when reached. Best
   naturalism for deciduous canopies — oak, maple, big shade
   trees.
   - `crown` (Mesh — the envelope to fill)
   - `trunkStart` (Vec3), `trunkInitialDirection` (Vec3)
   - `attractorDensity` (points per unit volume in crown)
   - `attractorRadius`, `killRadius`, `segmentLength`
   - `maxIterations`

   Heavier compute. Implement after simpler generators have
   shaken out the rest of the pipeline.

8. **`branch/merge`** — `[BranchGraph] → BranchGraph`. Combine N
   graphs sharing or near-sharing a base.
   - Multi-stem bush: 3–5 `branch/recursive` graphs at jittered
     root offsets, merged.
   - Also useful for adding dead/snapped branches to a main tree.

---

## 5. Out of scope

Listed so the design space is visible:

- **Bark textures.** Produced by the existing texture pipeline
  (noise / worley / etc.) and assigned to the tube mesh's
  material. Independent concern.
- **Y-joint blending** in `branch/tube` — geometry that smoothly
  merges where a branch leaves its parent rather than
  intersecting. AAA does it; we ship without.
- **Bark cards / fins** — extra overlapping geometry to add depth
  to trunk crevices.
- **Buttress roots** — flares at the base of mature trees.
- **LODs, billboards, impostors.** Runtime renderer concern.
- **Wind / sway.** Vertex shader at runtime; reads the vertex
  attributes `branch/tube` exports.
- **Roots above ground.** Could be `branch/recursive` run downward
  with flattening, but a separate concern.
- **Hollow trunks, scars, damage.** Mesh edits or texture work,
  not procedurally generated by this system.
- **Procedural growth animation.** A BranchGraph parameterized by
  an `age` 0..1 (truncate recursion, scale radii, shorten tips) is
  compelling but not in this plan.

---

## 6. Forward compatibility

The out-of-scope items above are real future work, not killed
features. The design above leaves room for them as **future
additions**, not future rewrites. Mapping each to what unlocks it:

| Future feature | What enables it | Already in plan? |
|---|---|---|
| Y-joint blending | `parentT` per branch | yes — on `BranchGraph` |
| Bark cards / fins | sample-points filtered to depth 0 | yes — existing node |
| Buttress roots | radius profile near `arcLength=0` | yes — `branch/recursive` parameter add |
| Wind / sway | `branchDepth`, `branchId`, `arcLengthAlongBranch` on tube verts | yes — emitted from day one |
| LODs / impostors | operates on final `Mesh` | yes — no upstream impact |
| Growth animation | `age` 0..1 input on each generator | extensible via attribute arrays |
| Roots above ground | `branch/recursive` run downward | yes — same node |
| Depth-blended bark | per-vertex `materialId` | extensible via attribute arrays |

The two load-bearing decisions making this work:

- **`BranchGraph` storage as named attribute arrays**, not a fixed
  struct. New per-vertex / per-branch attributes are additive.
- **`branch/tube` emits the wind/LOD vertex attributes from day
  one**, even though nothing reads them yet. Adding them later
  means re-baking every mesh.

---

## 7. Suggested order

1. **`BranchGraph` datatype** + a debug visualizer that draws
   curves as line segments with radius circles. Authoring is
   blind without this.
2. **`branch/recursive`** — first generator.
3. **`branch/tube`** — first realization. Wire up the full vertex
   attribute set (`branchDepth`, `branchId`,
   `arcLengthAlongBranch`) even though nothing reads them yet.
4. **`branch/sample-points`** — unblocks leaf placement.
5. **`branch/tropism`** — bend pass.
6. End-to-end **oak subgraph** as a proof. Birch and generic
   bush follow as parameter sets.
7. **`branch/palm`** — simplest secondary family, exercises the
   no-branching case.
8. **`branch/whorled-pine`** — second family.
9. **`branch/merge`** — multi-stem bushes.
10. **`branch/space-colonization`** — when natural deciduous
    canopies become the bottleneck.

---

## 8. Open design questions

- **Orientations stored on `BranchGraph` vertices, or always
  computed from tangents at use time?** Leaning compute-on-demand
  — smaller datatype, no orientation invariants to maintain across
  tropism passes. Cost is recomputing parallel-transport frames
  each time we sample, which is cheap.
- **Y-joint blending in `branch/tube`, or plain intersection?**
  Plain intersection in Phase 1. Y-joint blending is a known
  follow-up if hero closeups need it.
- **One Mesh output from the tube, or one per branch-depth?**
  Single Mesh for simplicity. Per-depth would let us assign
  different materials (smooth twig bark vs. cracked trunk bark) —
  defer until there's a real need; `materialId` attribute makes
  it cheap to add when wanted.
- **CPU or GPU generation?** All generators CPU. They're branchy,
  not pixel-parallel; the texture pipeline's compute path is the
  wrong shape. Tube sweep also CPU — runs once, output uploaded
  like any static mesh.
- **Leaves vs. flowers — separate point-list nodes or one node
  with multi-output?** Two separate `branch/sample-points`
  invocations with different filter parameters. No new
  abstraction; flowers just use tighter filters and their own
  seed.
- **Per-branch UV continuity in `branch/tube`.** Easy for a
  single branch (V wraps around, U follows arc length). Across
  branch-to-parent joins, UVs reset — visible bark seam at the
  join. Acceptable in Phase 1; revisit if it reads poorly.
- **Seeding strategy across nodes.** Each generator and each
  sample-points has its own `seed`. Wiring a shared upstream seed
  through subgraphs is an authoring convenience, not a node-level
  concern.
