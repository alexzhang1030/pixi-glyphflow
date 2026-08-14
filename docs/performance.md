# Performance

## Reference contract

The reference suite runs on an Apple M1 Pro with Bun 1.3.14 and headless Chrome. Browser workloads
use WebGL 2, explicit `gl.finish()`, warmup frames, p50/p95/p99 distributions, and one isolated Chrome
process per workload.

Raw artifacts live in [`benchmarks/results`](../benchmarks/results). The generated table lives in
[`benchmarks/PERFORMANCE.md`](../benchmarks/PERFORMANCE.md).

## Scale fixtures

- 1,000,000 resident labels
- 8,000,000 visible glyph instances for full visibility
- 100,000 text and transform updates per dynamic commit
- 100,000 packed x/y updates during viewport motion
- Real pixi-viewport drag, deceleration, wheel, pinch, zoom, and rotation events
- Latin, CJK, Arabic, Devanagari, and emoji streams
- 20,000 unique glyphs under a 4 MiB atlas ceiling

## Enforced budgets

| Budget                                  |              Limit |
| --------------------------------------- | -----------------: |
| Million-label core browser frames       |       16.67 ms p95 |
| 100,000 bulk mutation intake            |       16.67 ms p95 |
| CPU label store at one million capacity |            128 MiB |
| Glyph instance record                   |           32 bytes |
| Eight-million-glyph instance buffer     |            256 MiB |
| Transform palette record                | 64 bytes per label |
| Core transitive ESM graph               |        40 KiB gzip |
| Atlas pressure allocation               |              4 MiB |
| Full-visibility draw submission         | One instanced draw |

`bun run benchmark:check` validates artifact presence, formal scale, browser completion, boolean
invariants, frame budgets, mutation budgets, storage ceilings, atlas eviction, draw submission, and
the current build graph.

## Running the suite

```bash
# Full isolated matrix and generated report
bun run benchmark

# One workload
bun run benchmark -- --workload viewport-zoom

# Committed budget gate
bun run build
bun run benchmark:check
```

Useful workload flags include `--renderer`, `--labels`, `--mutations`, `--warmup`, `--frames`, and
`--timeout`. A scale override produces an exploratory artifact. Formal artifacts use the defaults in
`benchmarks/workloads.ts`.

## Reading results

Setup time covers layer construction, label insertion, the initial commit, and fixture-specific GPU
allocation. Frame time covers the workload operation and its completion boundary. Mutation and
commit distributions separate synchronous intake from publication work.

The full-visibility fixture records actual `drawElementsInstanced` calls, maximum submitted instance
count, and non-transparent framebuffer output. This evidence connects logical counters to a real GPU
submission path.

## Application tuning

- Reserve the expected label capacity.
- Reuse `Float64Array` IDs and `Float32Array` position buffers.
- Use `updatePositions` for movement and `updateTextPositions` for counter-style streams.
- Keep viewport culling enabled for large worlds.
- Reuse styles and fonts to maximize shaping and layout cache hits.
- Set an atlas ceiling that matches the product glyph working set.
- Read diagnostics at telemetry cadence.
