# pixi-glyphflow project context map

- [1.0 product specification](pixi-glyphflow-blueprint.md) — product scope, public interface, renderer architecture, performance budgets, verification, and release criteria.
- [Technology stack](technology-stack.md) — pinned development tools, runtime boundaries, package quality gates, and compatibility constraints.
- [Extreme performance program](performance-plan.md) — research-backed diagnosis of the 1.1.0 cliffs, papers and systems to steal or reject, and Waves 0–5.
- [Paid traps](gotchas.md) — compute-cull working-set residency, no on-screen admission drip, stamp rendered epochs on unchanged residents, TinySDF FontFace for binary fonts, prebuilt keys without revision, LOD remirror only on one-pixel crossings, compact-mesh veto after late glyph allocation, WGSL reserved `from`, PixiJS 128 MiB storage-binding default, CI Chrome/`float16x4` instance attributes, packed atlas keys vs `glyphText`, the deferred atlas-pressure frame gate, and budget-check artifact fallback.
- [100× performance path](performance-100x.md) — why compute-cull felt slower than cpu-grid, what 100× actually means on the homepage, and the remaining slices.
- [Implementation plan](../../tasks/plan.md) — dependency order, delivery phases, checkpoints, risks, and release sequence.
- [Task ledger](../../tasks/todo.md) — small implementation slices with acceptance criteria and verification commands.
- [Interactive documentation site](../../site/README.md) — Nuxt build contract, live-render scale, WebGPU when available, cull-path readout, browser acceptance, and local operation.
- [Font and language guide](../../docs/fonts.md) — custom font sources, CJKV routing, fallback semantics, shaping controls, and MSDF asset setup.

The 1.0 specification is the current unstamped design record. Tests, benchmarks, package artifacts, and tagged release evidence are the authoritative proof for implementation claims.
