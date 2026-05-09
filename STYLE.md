# Sedon — Style Guide

Project-specific conventions. The web has plenty of generic TS/WGSL style advice; this doc is only the choices that are *not obvious* or that we want to enforce against the default.

When an existing file disagrees with a rule here, fix it; don't propagate the old style.

---

## WGSL

### Short type forms, always

Use `vec4f`, `vec3f`, `vec2f`, `mat4x4f`, `mat3x3f`, etc. **Not** `vec4<f32>`, `mat4x4<f32>`. Same for integer/unsigned variants: `vec2u`, `vec3i`, `mat2x2i`.

```wgsl
// Yes
let p: vec3f = vec3f(1.0, 2.0, 3.0);
struct Uniforms { mvp: mat4x4f };

// No
let p: vec3<f32> = vec3<f32>(1.0, 2.0, 3.0);
struct Uniforms { mvp: mat4x4<f32> };
```

The expanded form is only acceptable when the alias doesn't exist (rare — e.g. matrices over non-standard types).

### Naming

- **Functions:** `snake_case`. `compute_normal`, `sample_height`, not `computeNormal`.
- **Entry points:** `vs_main`, `fs_main`, `cs_main` (one per stage per file is the default; if you need more, name them by purpose, e.g. `vs_shadow`, `fs_grid`).
- **Variables:** `snake_case`. `let view_dir = ...`.
- **Struct names:** `PascalCase`. `VertexOutput`, `Uniforms`.
- **Struct fields:** `camelCase` to match the TS-side struct that fills the buffer. `modelView`, `projection`. (Mismatch between WGSL `snake_case` for code and `camelCase` for fields is intentional — fields cross the JS boundary, code doesn't.)

### Bind groups and locations

- Always write `@group(N) @binding(M)` explicitly. Never rely on implicit ordering.
- Group layout:
  - `@group(0)` — per-frame uniforms (camera, time, lighting).
  - `@group(1)` — per-material (textures, material params).
  - `@group(2)` — per-object (model matrix, instance data).
  - `@group(3)` — compute scratch / one-off.
- Vertex attribute `@location` numbers: `0` position, `1` normal, `2` uv0, `3` tangent, `4+` extra streams.

### Files

- One `.wgsl` file per shader purpose. Imported as a string via esbuild's `text` loader.
- Prefer one entry point per stage per file unless multiple stages share substantial code.

### Pipeline configuration (TS side)

- **Omit WebGPU defaults.** Only set fields that differ from the spec default. Setting a field to its default value adds noise and obscures the choices that actually matter. Common defaults we routinely *don't* write:
  - `entryPoint` — when the shader module has exactly one `@vertex`/`@fragment`/`@compute` entry point.
  - `primitive.topology: 'triangle-list'` — the default.
  - `primitive.frontFace: 'ccw'` — the default.
  - `primitive.cullMode: 'none'` — the default (so write `'back'` only when you actually want culling).
  - `multisample.count: 1` — the default.
  ```ts
  // Yes — only the non-default fields
  primitive: { cullMode: 'back' },
  vertex: { module, buffers: [...] },

  // No — redundant restatements of defaults
  primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'back' },
  vertex: { module, entryPoint: 'vs_main', buffers: [...] },
  ```
- Use `layout: 'auto'` for one-off pipelines. Define an explicit `GPUPipelineLayout` only when bind groups are shared across pipelines or when you want a stable layout independent of the shader.
- Bind group ordering follows the WGSL convention above (`@group(0)` per-frame, `@group(1)` per-material, etc.).

---

## TypeScript

### Imports

- **Use `.js` extensions** in import paths, even though sources are `.ts`. esbuild and `tsx` resolve these to the `.ts` source. This is the modern ESM-friendly convention and matches what TypeScript's own `--moduleResolution: bundler` recommends.
  ```ts
  import { generateSphere } from './render/sphere.js';  // resolves to sphere.ts
  ```
- **No `.ts` extensions** in import paths. (We do not enable `allowImportingTsExtensions`.)
- Prefer named exports over default exports for everything except single-purpose modules (e.g. a shader file imported as default string).

### Naming

- **Files:** `lowercase` for single words (`sphere.ts`, `pipeline.ts`), `kebab-case` for multi-word (`graph-evaluator.ts`, not `graphEvaluator.ts` or `graph_evaluator.ts`).
- **Variables, functions:** `camelCase`.
- **Types, interfaces, enums:** `PascalCase`.
- **Constants:** `camelCase` for module-scope, `UPPER_SNAKE_CASE` only for genuine compile-time constants that act as enums.
- **Test files:** `<unit>.test.ts`, mirroring the `src/` path under `test/unit/`.

### Type system

- `interface` for object *shapes* that might be extended or implemented. `type` for unions, intersections, mapped types, function signatures, and aliases.
- Avoid `any`. Prefer `unknown` and narrow.
- Use `readonly` on properties that don't change after construction. Prefer `ReadonlyArray<T>` (or `readonly T[]`) for parameters that aren't mutated.
- Strict mode is on, including `noUncheckedIndexedAccess`. Index access (`arr[i]`) returns `T | undefined`; assert with `!` only when the bound is truly proven (e.g. inside a `for` loop with a known length), never out of laziness.

### Async

- Use `async`/`await`, not raw `.then()` chains.
- Always `.catch()` at the top-level entry point. Surface errors to the user (`#error` div for browser code).

### Comments

- **Default to no comments.** Names should explain what; code should explain how.
- Only write a comment when the *why* is non-obvious — a hidden constraint, a workaround for a specific bug, surprising behavior. Lead with **Why:** when it helps.
- Don't write what-comments (`// increment counter`) or current-task comments (`// fix for issue #42`).

### Errors

- Throw `Error` (or subclass) with a user-readable message. The message should tell the user what they can do (e.g. `'WebGPU not supported in this browser. Try Chrome 113+ or Edge.'`), not just what failed.

---

## Shell scripts and build

- Build/dev scripts live under `scripts/` as `.mjs` (no TS — keep tooling free of compile steps so they run in any Node).
- Don't add a tool to make a tool work — if a build step needs a 5-line wrapper, write the wrapper as a `.mjs` file.

---

## Git / repo

- **Don't commit** `dist/`, `node_modules/`, IDE folders. The `.gitignore` covers these.
- Source files end with a trailing newline.
- LF line endings (the editor and git config should handle this; don't fight it).

---

## When in doubt

If a rule here doesn't cover the case and there's no obvious right answer, match the surrounding code. If multiple files disagree, raise the question and we'll add a rule.
