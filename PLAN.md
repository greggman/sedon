# Sedon — Implementation Plan

Status: Phases 0–2 complete. The POC graph (Color → Grid → Material with Sphere → Output) evaluates via WebGPU and renders a Lambertian-shaded textured sphere.

This plan reflects decisions made in initial design discussion. See [TODO.md](TODO.md) for the project's overall goals and [NODES.md](NODES.md) for the node taxonomy.

---

## Goals (from TODO.md, distilled)

1. Procedurally generate large 3D content (cities, biomes, terrain, plants) from a small node graph.
2. Be editable in realtime
3. Run in a web browser via WebGPU at 60 fps.
4. Be portable to non-browser environments (Rust/C++/Python eventually) — implies the **graph itself is the wire format** and node IDs/parameters need a stable, language-neutral schema.
5. Generate AAA-looking output.

## Non-goals (initial)

- Animation rigging, IK, character animation systems.
- Physics simulation.
- Multi-user editing.

## Deferred, not banned

- **Asset import (glTF, PNG/JPG/EXR).** Late phase. We can build a forest using only generated trees, but real-world use will involve importing models. v1 import scope: glTF for geometry+material, common image formats for textures. USD is out of scope unless a specific reason arises.
- **Cross-graph asset references.** Earlier than imports — needed once group nodes ship — see §A8.

---

## Architectural Decisions

### A1. The graph is the data format
JSON-serializable, schema-versioned, with stable node IDs (`core/sphere`, `core/texture/grid`, etc.). Anything we want to transmit in 100KB lives here. No baked binary asset format until we hit a wall with text.

### A2. Editor: React Flow (`@xyflow/react`)
Decision after evaluation. Strengths: typed handles via `isValidConnection`, hover-highlight via `useConnection()`, active maintenance, large ecosystem. Caveats:
- **Perf ceiling ~500–1500 visible nodes.** xyflow maintainers say "go canvas if you need more." We stay under via aggressive use of group/supernodes (collapse subgraphs).
- **Group nodes are partial.** React Flow gives us `parentId`/sub-flow rendering only. The typed-boundary supernode model (group input/output proxy handles, instances) is on us — but the data model is small (`group = inputs + outputs + sub-graph`).
- **Discipline required:** `React.memo` on every custom node, `onlyRenderVisibleElements: true`, Zustand-style external store for graph state. Skipping any of these tanks perf at ~100 nodes.

### A3. Evaluation: GPU-first, with shader fusion for textures
**Texture nodes are NOT one shader per node.** That'd dispatch hundreds of render passes per graph eval — too slow. Instead:
- Texture nodes declare a WGSL fragment (or compute) snippet plus its inputs.
- The evaluator walks runs of texture nodes and **fuses them into a single shader** that computes the run end-to-end in registers.
- Boundaries where fusion stops: nodes that need a fully-resolved texture as input (e.g. blur reads neighbors), graph branches that are reused (cache), and explicit "bake" markers.

**Geometry generation is also GPU-first.** Compute shaders write to vertex/index buffers. Some operations (scatter, prefix-sum-driven instancing, marching cubes) genuinely require this — building CPU-first and rewriting later is wasted work.

CPU fallback for tiny things (constant color, single-vertex primitives) is fine — but the framework assumes GPU is the hot path.

### A4. Type system on sockets
See [NODES.md §1](NODES.md) for the registered types. Strict same-type connections with a small set of published implicit conversions (`Float→Vec3` broadcast, `Color↔Vec4`, `Int→Float`). Each type gets a color in the editor for at-a-glance matching. The set grows as nodes force it — `TextureCube` and `Texture2DArray` are anticipated for Phase 4 PBR work.

### A5. Group / supernode = `(inputs, outputs, kernel)`
A group is a node whose evaluation is "evaluate this inner graph." Group definitions are referenced (not copied) — edit once, all instances update. Per-instance overrides for exposed parameters. Implementation effort is the editor UX (enter/exit/edit groups), not the model.

### A6. Renderer: throwaway → PBR
Reverse the order in TODO.md. Build a **throwaway unlit textured renderer** in Phase 0 just to put pixels on screen, then build the proper PBR renderer **after** the node engine works (Phase 4). Reason: PBR is a known, scoped problem; the node system is the unknown. Build the unknown while the known is cheap to defer.

### A7. Stack
- **TypeScript**, **WebGPU**.
- **esbuild** for TS transpile, dev server (`esbuild --serve`), and prod bundling. No Vite — too large a transitive dep tree for what it gives us, and framework bitrot is a recurring pain point on this project.
- **React 18+** for the editor UI (Phase 3+).
- **`@xyflow/react`** for the node canvas.
- **Zustand** for graph state (recommended pattern for large React Flow graphs).
- **Node's built-in `node:test`** for unit tests + **`tsx`** for TS execution. (Vitest was the original plan but it depends on Vite, which we excluded. `node:test` is a stable Node platform feature with no framework risk.)
- **Puppeteer** for E2E later — added when we have something visual to screenshot, not in Phase 0.
- No 3D engine dependency (Three.js, Babylon.js): we own the WebGPU code so we can compile node graphs straight into render passes and compute pipelines without fighting an abstraction. Reconsider if this becomes a bottleneck.

**Stack policy:** prefer the smallest direct surface area and fewest transitive deps. Defer adoption — "do we need this yet?" beats "this is the standard choice." When swapping in a framework would be cheap (one afternoon), defer until pain forces it.

### A8. Assets and multi-graph projects
A project is a **folder of `.sedon` graph files**, not a single graph. Some graphs produce assets (a tree); others consume them (a forest). The mechanism is a small extension of group nodes (§A5):

- **A group definition can live in its own file.** A `tree_oak.sedon` is structurally a group — it has typed inputs (maybe none), typed outputs (one `Geometry`), and an inner graph (the kernel).
- **A `Group Reference` node** in another graph instantiates that group from a relative path. Editing `tree_oak.sedon` invalidates any open graph that references it; the evaluator re-runs.
- **Imports (glTF, PNG, EXR)** are leaf nodes in the same shape — no inputs, file-path parameter, output of the appropriate type. They produce values; downstream consumers can't tell the difference between an imported mesh and a generated one.

**Identity model — two-tier:**
- **Inside a graph:** every node has a stable UUID. Edges reference nodes by UUID. (Required regardless — edges can't depend on node order or display name.)
- **Across graphs / for asset references:** relative paths, with content-hash for cache invalidation. *Not* UUIDs.
  - Editor-driven renames rewrite paths in workspace graphs.
  - Renames done outside tooling surface as "missing asset, last known at `path/to/oak.sedon`" — visible failure, fixable by hand.
  - If specific high-value assets need rename-safety beyond this, an optional `.meta` sidecar with a UUID can be added per asset later. Don't force the ceremony on everything.

**Why not Unity-style UUIDs everywhere:** sidecar `.meta` files for every asset (including small text graphs) doubles the file count and pollutes the directory; UUID-laden JSON is unreadable and unportable across projects; merge conflicts in version control are worse; and UUIDs don't actually solve renames done outside the tooling. Unity has UUIDs because its asset pool is thousands of binary files where content-hashing is expensive and humans can't read the files. Different problem from ours.

**Wire-format implication:** the small-data goal still holds. Graphs are small. Assets are either other small graphs (referenced by path) or external files (transmitted alongside, or via URL — same model as a webpage with `<img src="...">`).

### Open architectural questions (defer until they bite)
- Attribute-domain semantics for geometry (Blender-style per-point/per-face attributes flowing through the graph). Simpler model first; revisit when needed.
- Cross-language schema: how to make the JSON graph stable enough to feed a future Rust/C++/Python interpreter. Punt until the TS impl proves out.
- Caching strategy for partial graph re-eval (content-hash on subgraphs).
- Async / streaming evaluation (the "fill in the world incrementally" goal). Phase 5+.

---

## Project Structure

```
src/
  core/                  # graph engine, types, evaluator
    types.ts             # socket type registry + compatibility
    nodeDef.ts           # NodeDef interface, registry
    graph.ts             # Graph, Node, Edge data
    evaluate.ts          # topo-sort eval driver
    resources.ts         # GPU resource lifetime
    fusion.ts            # texture-node shader fusion
  nodes/                 # built-in node defs (one file per category)
    geometry/sphere.ts
    geometry/cube.ts
    texture/grid.ts
    texture/color.ts
    material.ts
    output.ts
    math/...
  render/                # WebGPU renderer
    device.ts            # adapter/device init
    pipeline.ts          # render pipelines
    pbr.ts               # PBR shader (Phase 4)
  editor/                # React + React Flow UI
    App.tsx
    NodeCanvas.tsx
    nodes/CustomNode.tsx
    handles/TypedHandle.tsx
    inspector/Inspector.tsx
    preview/Preview.tsx  # 3D viewport
    store.ts             # Zustand graph store
test/
  unit/
  e2e/                   # Puppeteer
```

---

## Phased Plan

### Phase 0 — Scaffold (1–2 days)
- TypeScript + esbuild (build + `--serve` for dev). No React yet — Phase 3 brings it in.
- WebGPU device init + "hello sphere" rendered to a canvas. Fragment outputs world-space normal as color so the sphere's shape is actually visible (still unlit, no lighting model).
- `node:test` + `tsx` smoke test.
- Folder structure above.
- README updated to describe what runs.

Puppeteer E2E waits until Phase 2 when there's something worth screenshotting.

**Done when:** `npm run dev` shows a sphere in a browser; `npm test` passes a smoke test.

### Phase 1 — Core graph engine (2–3 days)
- `types.ts`: socket type registry, color map, implicit conversion table.
- `nodeDef.ts`: `NodeDef` interface — `{ id, category, inputs, outputs, params, evaluate(ctx, inputs, params) }`. Global registry.
- `graph.ts`: `Graph = { nodes: Node[], edges: Edge[] }`, JSON-serializable.
- `evaluate.ts`: topological sort, pull from output node, content-hash cache on (nodeId, input hashes, params).
- `resources.ts`: GPU buffer/texture wrapper with refcount, freed on eval invalidation.
- Unit tests: graph round-trips through JSON, eval order is correct, cache hits where expected.

**Done when:** a hand-built graph in code (no UI yet) can output a `Color` constant and the test asserts the value.

### Phase 2 — POC nodes + minimal renderer wiring (2–3 days)
The minimum to render the user's described POC:
- `Color` — outputs `Color`. **[POC]**
- `Grid` — fragment-shader render to a 512×512 `Texture2D`. **[POC]**
- `Sphere` — compute-shader generated `Geometry` (or CPU-generated initial pass; revisit). **[POC]**
- `Material` — bundles a basecolor texture into a `Material`. **[POC]**
- `Output` — eval root: `(Geometry, Material)`.

Renderer: throwaway PBR-lite — basecolor texture on a sphere, hardcoded directional light. Not PBR yet.

**Done when:** a code-built graph (Color → Grid → Material with Sphere → Output) renders a colored grid texture on a sphere via the WebGPU renderer.

### Phase 3 — Editor UI (3–5 days)
- React Flow canvas with custom node component (rendered handles colored by socket type, parameter widgets inline).
- `isValidConnection` enforcing the type rules from §A4.
- `useConnection()`-driven hover highlight: while dragging from a socket, all matching-type sockets glow.
- Add-node menu (browse by category from the registry).
- Parameter inspector panel.
- 3D preview pane re-evaluating on graph change (debounced).
- Texture preview thumbnails on each texture node's output handle.
- Zustand store for graph state. `React.memo` on node components. `onlyRenderVisibleElements: true`.

**Done when:** user can build the POC graph entirely in the UI, drag-connect typed handles, and see the rendered result update live.

### Phase 4 — Real PBR renderer + texture-shader fusion (3–5 days)
- PBR shader: basecolor, normal, roughness, metallic, AO, emissive. IBL or analytic lights.
- Camera controls (orbit).
- Texture-node shader fusion (§A3): walk runs of texture nodes, generate one fused WGSL fragment shader per run, dispatch one render pass per run. Bench against one-shader-per-node to confirm the win.
- Material node grows the additional texture inputs.

**Done when:** a textured sphere with normal/roughness/metallic maps renders correctly under a moving light, and a 30-node texture graph evaluates in <16ms.

### Phase 5 — Node library expansion (incremental, ongoing)
Driven by content goals. Rough order, in concert with what we want to build:
1. **Math/utility** (Math, Vector Math, Map Range, Mix, Compare, Random, Color Ramp, Float Curve) — unlocks everything.
2. **More texture generators** — Perlin/Simplex/Worley, FBM, Bricks, Voronoi pattern.
3. **More texture filters** — Blend (already POC), Levels, HSL, Blur, Normal-from-Height, Gradient Map.
4. **More geometry primitives** — Cube, Cylinder, Plane, Cone.
5. **Geometry modifiers** — Transform, Subdivide, Set Position, Set Material.
6. **Distribution** — Distribute Points on Faces, Instance on Points, Realize Instances.
7. **Splines** — Bezier, Line, Spline to Mesh, Curve from Path.
8. **Group nodes** (editor UX work + boundary types).

This phase is open-ended. Each node is half a day to a day at this point. Cut V1 when we can build *one believable scene*.

### Phase 6 — Terrain (large; future)
- `Heightfield` type and storage.
- Heightfield Generator, Heightfield to Mesh, Slope, Layer.
- Erosion (compute shader). This is a multi-week subproject by itself.
- Spline-driven carving for rivers/roads.

### Phase 7 — Async / streaming eval
The "fill in the world incrementally" goal. Eval runs on workers / off-frame; LOD-driven priority; progressive results streamed to the renderer. Major architectural pass.

### Phase 8 — Asset import (glTF, image files)
- `glTF Import` node — file path → `Geometry` (+ `Material` if textures present in the file).
- `Texture Import` node — PNG/JPG/EXR/HDR → `Texture2D`.
- File watcher for live update when imported files change on disk.
- Content-hash caching so re-imports don't reparse unchanged files.

By this phase the rest of the system is mature enough that imported assets are just another way to produce values that node-generated content already produces. No new evaluator concepts needed.

### Phase 9+ — Cross-language schema, content libraries (cities, jungles, etc.)

---

## Risks / Things That Could Go Wrong

1. **React Flow caps out earlier than expected.** Mitigation: aggressive use of supernodes/collapse keeps the visible count low. Fallback: swap canvas-based renderer behind the same data model — graph state is in our Zustand store, not coupled to React Flow.
2. **Texture-shader fusion is harder than it looks.** Generating WGSL by string concat from typed snippets is doable but easy to get wrong (variable hygiene, type promotion). Mitigation: build the simplest version first (linear chains, no branches), expand once it works.
3. **Group node UX is its own project.** Mitigation: ship without groups in Phases 0–4; add in Phase 5 once the rest is stable.
4. **Geometry on GPU adds complexity early.** A purely CPU-generated sphere is 30 lines; a compute-shader sphere is a couple hundred. We commit to GPU upfront because rewriting later is worse — but we accept Phase 0–2 will move slower than CPU-first would.
5. **PBR + WebGPU + custom renderer.** This is real work. If it stalls Phase 4, fall back to a simpler analytical lighting model and defer IBL.

---

## Definitions of Done for "POC"

The user's stated POC, as a concrete acceptance test:

- [ ] User opens the editor in a browser.
- [ ] User adds a `Sphere` node, a `Grid` texture node, two `Color` nodes, a `Material` node, an `Output` node.
- [ ] User connects: `Color → Grid.fg`, `Color → Grid.bg`, `Grid → Material.basecolor`, `Sphere → Output.geometry`, `Material → Output.material`.
- [ ] Type-incompatible connections are refused with visual feedback.
- [ ] The 3D preview shows a sphere with a grid texture in the chosen colors.
- [ ] Editing any color or grid divisions parameter updates the preview within 100ms.

This is roughly the end of Phase 3.
