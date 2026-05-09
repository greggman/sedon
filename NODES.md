# Sedon — Node Taxonomy Reference

Working catalog of node types we expect to need, organized by category. For each node:

- **(inputs) → (outputs)** at a glance
- short description of what it does
- _Refs:_ canonical names in Substance Designer (SD), Blender Geometry Nodes (BGN), Blender Shader/Texture Nodes (BSN), Houdini (H), Unreal Material Editor (UE), Frostbite world tools (FB)

This is a **planning document**, not a spec. The POC needs ~6 of these; the long-term system probably wants 200–300. Tags:

- **[POC]** — needed for the proof of concept (sphere + grid texture + color → render)
- **[v1]** — needed for the first usable system (small terrain, scattered trees, textured buildings)
- **[v2+]** — later

---

## 1. Socket / Type System

These aren't nodes — they're the types that flow on edges. Listed first because the node catalog assumes them.

| Type | Description | Example producers | Color (suggested) |
|---|---|---|---|
| `Float` | scalar | Math, Map Range | orange |
| `Int` | integer scalar | Random Int, Index | yellow |
| `Bool` | boolean | Compare | white |
| `Vec2` | 2-component vector | UV, Resolution | light blue |
| `Vec3` | 3-component vector | Position, Normal | blue |
| `Vec4` | 4-component vector | Tangent (xyz=dir, w=sign), generic 4-vec | dark blue |
| `Quaternion` | unit quaternion (rotation) | Axis-Angle, Euler-to-Quat, Look-At | indigo |
| `Color` | RGBA color | Color picker, Gradient sample | purple |
| `Texture2D` | GPU 2D image (any channel layout) | every texture node | green |
| `Texture3D` | GPU 3D image | 3D LUT, 3D Noise, SDF Volume | dark green |
| `Geometry` | mesh: positions, normals, uvs, indices, custom attrs | Sphere, Cube, Subdivide | red |
| `Material` | bundle of textures + scalar params | Material node | pink |
| `Curve` (1D ramp) | float-valued curve over [0,1] | Float Curve | teal |
| `Gradient` | color-valued ramp over [0,1] | Color Ramp | rainbow |
| `Spline` | parametric curve in 3D (positions + tangents) | Bezier, Path | brown |
| `Heightfield` | `Texture2D` + world bounds (origin/size XZ) + height range | Terrain Generator | olive |
| `PointCloud` | unstructured points with attributes | Scatter, Distribute on Surface | grey |
| `Instances` | references to geometry placed at transforms | Instance on Points | dark red |

Connection rules (initial):
- Strict same-type unless a published implicit conversion exists.
- Implicit: `Float → Vec2/3/4` (broadcast), `Color ↔ Vec4`, `Int → Float`. No others by default.
- Connection validation lives in the editor (`isValidConnection`); evaluator is the source of truth and rejects bad graphs at compile time too.

Design notes on the type system:

- **Why `Quaternion` is separate from `Vec4`.** A quaternion's operations are different from a vec4's: Hamilton product (not component multiply), slerp (not lerp), unit-norm constraint. Wiring a Quaternion to a generic Vec4 Math node and getting "add" silently produces garbage. (Blender added a `Rotation` type to Geometry Nodes for exactly this reason.) The general rule: separate types when the *operations* differ, not when the *meaning* differs. Tangents stay as Vec4 by this rule — a tangent is a Vec3 with a sign packed in `w`, and the math is just normal vector ops.
- **Why `Heightfield` is separate from `Texture2D`.** The pixel data is one channel of a texture, but the *metadata* (world origin, world size, height range, eventually LOD/tile info) travels with it. Erosion, slope, "flatten near this spline", and most terrain ops need world units; modeling heightfields as bare `Texture2D` and asking every terrain node to take a separate "world bounds" parameter would invite mismatch bugs. Conversion to/from `Texture2D` is provided by explicit nodes (it's a real operation, not free).
- **Why no `Vec2i` / `Vec3u` / etc. yet.** Internally vectors are parameterized as `Vec<N, T>` so we *can* add integer/unsigned variants when a real node needs them. We don't register them now to avoid type-table explosion (six more types, six more colors, six more conversion rules). Until something forces it, `Int` parameters and `Vec2` with a boundary cast are fine.
- **What's coming but not registered yet.** `TextureCube` (cubemap for environment / IBL — needed when PBR lighting lands in Phase 4) and `Texture2DArray` (layered materials, atlases). Same rule: register when a node forces the issue.

A note on importing data: the project's "no asset import" non-goal is about *generated content* — geometry, textures, materials we can synthesize ourselves. *Small constants* like 3D color LUTs (a 32³ float LUT is ~12KB) are conceptually data values, not assets, and fit the "small wire-format" goal. So `Load 3D LUT` from a `.cube` file is in scope.

---

## 2. Geometry — Primitives

All output `Geometry`. Generated GPU-side where possible (compute shader writes vertex/index buffers).

- **Sphere [POC]** — `(radius: Float, segments: Int, rings: Int)` → `Geometry`. UV-sphere. _Refs: BGN "UV Sphere", H "sphere"_
- **Ico Sphere [v1]** — `(radius, subdivisions)`. _Refs: BGN "Ico Sphere"_
- **Cube [v1]** — `(size: Vec3, subdivisions: Int)`. _Refs: BGN "Cube", H "box"_
- **Cylinder [v1]** — `(radius, depth, segments, caps: Bool)`. _Refs: BGN "Cylinder", H "tube"_
- **Cone [v1]** — `(radius_bottom, radius_top, depth, segments)`. _Refs: BGN "Cone"_
- **Plane / Grid [v1]** — `(size: Vec2, divisions: Vec2)`. _Refs: BGN "Grid"_
- **Torus [v2+]** — `(major_r, minor_r, major_seg, minor_seg)`.
- **Capsule [v2+]** — `(radius, length, segments)`.
- **Quad [v2+]** — single quad, useful as a building block.

## 3. Geometry — Mesh Operations / Modifiers

All take `Geometry` in, output `Geometry`. These are where Blender Geometry Nodes shines.

- **Transform [v1]** — `(geo, translate: Vec3, rotate: Vec3, scale: Vec3)`. _Refs: BGN "Transform Geometry"_
- **Subdivide [v1]** — `(geo, level: Int)`. Catmull-Clark or simple. _Refs: BGN "Subdivide Mesh"_
- **Extrude [v1]** — `(geo, selection, offset: Vec3)`. _Refs: BGN "Extrude Mesh"_
- **Bevel [v2+]** — `(geo, width, segments)`.
- **Bool Union/Difference/Intersect [v2+]** — `(a, b)`. _Refs: BGN "Mesh Boolean", H "boolean SOP"_
- **Triangulate [v1]** — `(geo)`.
- **Set Position [v1]** — `(geo, position: Vec3 attr, selection?)`. The fundamental "deform anything" node. _Refs: BGN "Set Position"_
- **Set Normal [v2+]** — `(geo, normal: Vec3 attr)`.
- **Set Material [v1]** — `(geo, material)`. _Refs: BGN "Set Material"_
- **Set UV [v1]** — `(geo, uv: Vec2 attr)`.
- **Lathe / Revolve [v2+]** — `(profile: Spline, axis, segments)`. _Refs: H "lathe SOP"_
- **Sweep / Extrude Along Spline [v2+]** — `(profile: Spline, path: Spline)`. _Refs: BGN "Curve to Mesh"_
- **Mirror [v2+]** — `(geo, axis)`.
- **Array [v2+]** — `(geo, count, offset)`.
- **Solidify [v2+]** — `(geo, thickness)`.
- **Decimate [v2+]** — `(geo, ratio)`.
- **Smooth [v2+]** — `(geo, iterations)`.

## 4. Geometry — Distribution / Scattering

The key world-building category.

- **Distribute Points on Faces [v1]** — `(geo, density, seed)` → `PointCloud`. _Refs: BGN "Distribute Points on Faces", H "scatter SOP"_
- **Distribute Points in Volume [v2+]** — `(geo, density)` → `PointCloud`.
- **Distribute Points on Spline [v2+]** — `(spline, count or spacing)` → `PointCloud`.
- **Poisson Disk Sample [v2+]** — `(geo, min_distance)` → `PointCloud`. Better visual distribution.
- **Instance on Points [v1]** — `(points, instance: Geometry, rotation, scale)` → `Instances`. _Refs: BGN "Instance on Points"_
- **Realize Instances [v1]** — `(instances)` → `Geometry`. Bake.
- **Density Mask [v1]** — multiply a `PointCloud`'s density by a `Texture2D` or `Heightfield` value. Usually inline on the distribute node.

## 5. Geometry — Splines / Curves (3D)

- **Bezier [v1]** — `(control_points)` → `Spline`.
- **Line [v1]** — `(start: Vec3, end: Vec3, divisions: Int)` → `Spline`.
- **Spiral [v2+]**, **Star [v2+]**, **Circle [v2+]**, **Quadratic Bezier [v2+]**.
- **Resample Spline [v2+]** — `(spline, count or length)`.
- **Trim Spline [v2+]** — `(spline, start, end)`.
- **Spline to Mesh [v1]** — `(spline, profile)` → `Geometry`.
- **Spline Parameter [v1]** — sample position/tangent/normal at t.
- **Curve from Path [v2+]** — load a road/river path.

## 6. Texture / 2D Generation

All output `Texture2D`. Resolution is a graph-level parameter (or per-node override). **Eval strategy: fuse adjacent texture nodes into a single fragment shader** — see PLAN.md §Architecture.

### Generators

- **Solid Color [POC]** — `(color: Color)` → `Texture2D`. _Refs: BSN "RGB"_
- **Grid [POC]** — `(fg: Color, bg: Color, divisions: Vec2, line_width: Float)` → `Texture2D`. _Refs: SD "Tile Generator", BSN "Checker"_
- **Checkerboard [v1]** — `(a, b, divisions: Vec2)` → `Texture2D`. _Refs: BSN "Checker"_
- **Bricks [v1]** — `(mortar, brick, divisions, offset, mortar_size, variance)`. _Refs: SD "Brick"_
- **Hex Grid [v1]** — `(size, gap)`. _Refs: SD "Hexagon Pattern"_
- **Stripes [v2+]** — `(a, b, count, axis)`.
- **Voronoi Pattern [v1]** — `(scale, seed, jitter, distance_metric)`. _Refs: SD "Voronoi", BSN "Voronoi"_
- **Gradient [v1]** — `(direction, colors: Gradient)`. Linear/radial/conic. _Refs: BSN "Gradient"_
- **Shape (circle/square/poly) [v2+]** — primitive masks.

### Noise

The texture toolkit. All `(scale, octaves, lacunarity, gain, seed) → Texture2D`.

- **Perlin Noise [v1]** — _Refs: SD "Perlin Noise", BSN "Noise", H "noise VOP"_
- **Simplex Noise [v1]**
- **Worley / Cellular [v1]** — Voronoi distance field. _Refs: SD "Cells", BSN "Voronoi" (distance mode)_
- **Curl Noise [v2+]** — vector field.
- **Gabor Noise [v2+]**
- **FBM (Fractal) [v1]** — multi-octave sum of any base noise.
- **Domain Warp [v2+]** — distort UVs by another noise.

### Filters / Compositing

- **Blend [POC]** — `(a: Texture2D, b: Texture2D, factor, mode)`. Mix, Add, Multiply, Screen, Overlay, etc. _Refs: SD "Blend", BSN "MixRGB"_
- **Levels [v1]** — `(in_min, in_max, gamma, out_min, out_max)`. _Refs: SD "Levels"_
- **Curves [v2+]** — RGB channel curves. _Refs: SD "Curve"_
- **Hue/Sat/Light [v1]** — _Refs: SD "HSL", BSN "Hue/Saturation"_
- **Invert [v1]**.
- **Threshold [v1]** — _Refs: SD "Threshold"_
- **Histogram Scan [v2+]** — _Refs: SD "Histogram Scan"_
- **Blur (Gaussian) [v1]** — _Refs: SD "Blur HQ"_
- **Blur (Directional) [v2+]**.
- **Warp / Distort [v2+]** — `(input, warp_field, intensity)`. _Refs: SD "Warp"_
- **Edge Detect [v2+]** — Sobel.
- **Distance / Slope [v2+]** — _Refs: SD "Distance"_
- **Normal from Height [v1]** — `(height: Texture2D, intensity)` → normal map. _Refs: SD "Normal"_
- **AO from Height [v2+]** — _Refs: SD "Ambient Occlusion"_
- **Curvature from Normal [v2+]** — _Refs: SD "Curvature"_
- **Gradient Map [v1]** — `(grayscale: Texture2D, ramp: Gradient)` → `Texture2D`.
- **Channel Combine / Split [v1]** — pack/unpack R, G, B, A.
- **UV Transform [v2+]** — scale/rotate/offset UVs of an input.
- **Tile [v2+]** — replicate an input.

### 3D Textures / LUTs / Volumes

All produce or consume `Texture3D`.

- **Load 3D LUT [v1]** — `(file: .cube)` → `Texture3D`. Standard color-grading LUT import. _Refs: most DCC packages, OpenColorIO_
- **Apply 3D LUT [v1]** — `(input: Texture2D, lut: Texture3D, strength: Float)` → `Texture2D`. Color grading.
- **Perlin Noise 3D [v2+]** — `(scale, octaves, seed)` → `Texture3D`. Volumetric noise for clouds, fire, fog, marble.
- **Worley Noise 3D [v2+]** — `(scale, seed)` → `Texture3D`.
- **Slice 3D [v2+]** — `(volume: Texture3D, axis, t: Float)` → `Texture2D`. Sample one slice for preview/debug.
- **SDF from Geometry [v2+]** — `(geo: Geometry, resolution)` → `Texture3D`. Bake a signed distance field. _Refs: H "isooffset/SDF VOPs"_

## 7. Materials / Output

- **Material [POC]** — `(basecolor: Texture2D, normal?, roughness?, metallic?, ao?, emissive?, height?)` → `Material`. _Refs: SD "PBR Output", UE "Material"_
- **Output / Viewport [POC]** — `(geo: Geometry, material?: Material)`. Eval root; what the preview renders.
- **Group Input / Group Output [v1]** — boundary nodes for supernodes (see §10).

## 8. Math / Logic / Utility

These are tiny but you need a lot of them.

- **Math [POC]** — `(a: Float, b: Float, op: enum)` → `Float`. add, sub, mul, div, pow, log, sqrt, abs, min, max, mod, floor, ceil, round, sin, cos, tan, atan2, ... _Refs: BGN "Math"_
- **Vector Math [v1]** — same for `Vec3`. add, sub, scale, cross, dot, length, normalize, reflect, refract.
- **Map Range [v1]** — `(value, in_min, in_max, out_min, out_max, clamp: Bool)`. _Refs: BGN "Map Range"_
- **Clamp [v1]**.
- **Mix / Lerp [POC]** — `(a, b, factor)`. Polymorphic over Float/Vec3/Color.
- **Compare [v1]** — `(a, b, op)` → `Bool`.
- **Switch [v1]** — `(condition: Bool, true_val, false_val)`. Polymorphic.
- **Random Float / Vec3 / Color [v1]** — `(min, max, seed)`. _Refs: BGN "Random Value"_
- **Float Curve [v1]** — sample a `Curve` at t. _Refs: BGN "Float Curve"_
- **Color Ramp [v1]** — sample a `Gradient` at t. _Refs: BGN "Color Ramp"_
- **Combine XYZ / RGB [POC]**, **Separate XYZ / RGB [POC]**.
- **Constant** nodes for each scalar/vector type — really just inline constants on input sockets, but useful as standalone for sharing values.

## 9. Terrain / Heightfield (v1+, large category)

This is the "world generation" half of the system. References: Houdini Heightfield SOPs, Frostbite world editor, World Creator, Gaea.

### Heightfield generators
- **Heightfield Generator [v1]** — `(size, resolution, seed, noise_params)` → `Heightfield`.
- **Heightfield from Texture [v1]** — `(tex: Texture2D, world_size, max_height)` → `Heightfield`.

### Heightfield modifiers
- **Heightfield Erode (Hydraulic) [v2+]** — water erosion. _Refs: H "heightfield_erode_hydro"_
- **Heightfield Erode (Thermal) [v2+]**.
- **Heightfield Slope [v1]** → `Texture2D` mask.
- **Heightfield Curvature [v2+]** → mask.
- **Heightfield Blur [v1]**.
- **Heightfield Layer [v1]** — composite multiple heightfields with a mask.
- **Heightfield Carve (River/Road) [v2+]** — `(field, spline, depth, falloff)`. Cut a path.
- **Heightfield Flatten [v2+]** — flatten near a spline (for roads/towns).

### Heightfield to world
- **Heightfield to Mesh [v1]** — tessellate. _Refs: H "heightfield_convert"_
- **Heightfield Sample [v1]** — sample height/normal at a Vec2 world coord.

## 10. Group / Supernode (v1)

Per discussion: a group node is `(inputs, outputs, kernel = sub-evaluator)` — i.e., a node whose evaluation is "run this inner graph." Editor UX (enter/exit, edit boundaries) is the work; the data model is small.

- **Group Input [v1]** — special node that exposes the group's external inputs as outputs to the inner graph.
- **Group Output [v1]** — vice versa.
- **Group Instance** — the outer-graph node that references a group definition. Not really a separate registered node — it's a node *kind* whose definition is a saved group.

Open question: are groups *referenced* (edit once, all instances update — like Substance subgraphs) or *copied* on insert? Recommend referenced. Per-instance overrides for exposed parameters.

## 11. Asset References / Imports (late phase)

These are the bridge to multi-graph projects and external files. See [PLAN.md §A8](PLAN.md) for the architectural model.

### Cross-graph references (Phase 5, with groups)
- **Group Reference [v1]** — `(file: relative-path)` plus the group's exposed parameters as inputs → the group's exposed outputs. Instantiates a group defined in a sibling `.sedon` file. Edits to the referenced file invalidate this node's cache. _Refs: Substance "subgraph instance", Blender "Node Group", Unity "Prefab"_

### File imports (Phase 8)
- **glTF Import [v2+]** — `(file: .gltf/.glb)` → `Geometry`, `Material` (multiple outputs if the file has multiple meshes/materials).
- **Texture Import [v2+]** — `(file: .png/.jpg/.exr/.hdr)` → `Texture2D`. EXR/HDR for IBL and float data.
- **3D LUT Import [v2+]** — covered in §6 already (`Load 3D LUT`).

USD, FBX, OBJ are out of scope unless a specific use case demands them.

## 12. Coverage Notes — What's Missing vs. References

| Reference system | What we don't have an answer for yet |
|---|---|
| Blender Geometry Nodes | Attribute domain semantics (per-point vs. per-face). Need a model. |
| Substance Designer | "Pixel Processor" — per-pixel custom shader node. Probably v2+. |
| Houdini | VEX / per-element scripted nodes. Not planning to support. |
| Substance / SBSAR | Exposed parameters on a graph for end-user tweaking (treat root graph as a group). |
| Unreal Material Editor | Static switches / shader permutations. We compile per-graph anyway, less of an issue. |
| Frostbite | Layered material blending across terrain (slope+altitude+noise driven). Build from primitives. |

---

## How to use this doc

- When designing a new node, check whether SD/BGN/H already named it — use the same name and parameter shape.
- When tagging POC vs. v1 vs. v2+, the bias is: anything needed to render a textured sphere is POC; anything needed to make one believable scene (terrain, scatter, PBR) is v1; everything else is v2+.
- Add to this doc whenever we discover a node we'll need that isn't here.
