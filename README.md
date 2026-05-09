# Sedon

Procedural 3D content generator built around a typed node graph. Targets WebGPU; eventually portable to native runtimes.

See [TODO.md](TODO.md) for goals, [PLAN.md](PLAN.md) for the architecture and phased plan, [NODES.md](NODES.md) for the node taxonomy, and [STYLE.md](STYLE.md) for code conventions.

## Status

Phase 0 — scaffold. A hello-sphere renders in the browser via WebGPU. The node engine, type system, editor, and PBR all come later.

## Requirements

- Node.js 20.6+
- A browser with WebGPU (Chrome 113+, Edge, recent Firefox Nightly with the flag, Safari 17+ on macOS)

## Quick start

```sh
npm install
npm run dev      # http://localhost:8000
npm run build    # writes dist/main.js
npm test         # runs node:test under tsx
npm run typecheck
```

## Layout

```
src/
  render/   WebGPU device init, sphere generator, mat4 math, shader, pipeline
  core/     graph engine, types, evaluator (Phase 1)
  nodes/    built-in node definitions (Phase 2+)
  editor/   React Flow editor UI (Phase 3+)
test/unit/  node:test specs
scripts/    esbuild build + dev server
```

## Stack

- TypeScript, WebGPU, esbuild — chosen for minimal transitive dependencies.
- `node:test` + `tsx` for tests (Vitest avoided because it pulls in Vite).
- React + `@xyflow/react` arrive in Phase 3 with the editor.
