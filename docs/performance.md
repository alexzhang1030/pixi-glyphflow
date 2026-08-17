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
| Atlas pressure allocation               |              4 MiB |
| Atlas textures per ordered draw bank    |                  8 |
| Full-visibility draw submission         | One instanced draw |

`bun run benchmark:check` validates artifact presence, formal scale, browser completion, boolean
invariants, frame budgets, mutation budgets, storage ceilings, atlas eviction, and draw submission.
It still measures the core ESM gzip graph and does not fail that size.

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

The synthetic full-visibility fixture (`million-full`) records actual `drawElementsInstanced` calls,
maximum submitted instance count, and non-transparent framebuffer output. `million-live` commits the
same label set through `TextLayer` and draws the coordinator mesh. Rendering frames split CPU JS,
upload bytes, and GPU completion. This evidence connects logical counters to a real GPU submission
path.

Atlas pages share an eight-texture draw bank. Page-alternating multilingual runs retain instance
order while consuming one PixiJS local-uniform slot per bank, keeping WebGPU submission below its
uniform-batch capacity.

## Known cliffs

The 1.1.0 suite meets the formal million-label frame and mutation budgets. Three facts still cap
how far the current code can go:

- `atlas-pressure` is legal today because the gate only checks the 4 MiB ceiling and eviction
  activation. The same artifact records 638.50 ms frame p95 while packing 20,000 unique glyphs.
- `dynamic-counters` sits at 16.40 ms frame p95, 0.27 ms under the 16.67 ms wall.
- `million-full` draws a synthetic 8,000,000-instance mesh. It proves one instanced GPU
  submission. `million-live` is the product-path workload; it has no 1.1.0 artifact yet.

Wave 1 of that program is in source: Skyline atlas packing, per-mode O(1) LRU, typed instance
writes, numeric fill packing, a hierarchical hash grid, packed live atlas keys, power-of-two
instance free-list buckets, and policy-costed dirty uploads. Wave 2 has started without changing
published ceilings: shared styles intern, position-only commits patch 16 palette bytes,
z-index is `Float32`, fill-only GPU transforms use 32 bytes with a sparse effect tail, the
CPU store packs non-position columns so one million reserved slots stay within 48 MiB plus
the journal floor, and live glyph instances use 24 bytes. Wave 0 adds `million-live`, split
CPU/upload/GPU frame samples, and commit phase timers. The
40 KiB core gzip and `atlas-pressure` frame CI gates are deferred; the check still prints those
sizes. Published browser artifacts remain 1.1.0 until the isolated Chrome suite is rerun on the
reference fixture. The
next program is recorded in
[`.agents/docs/performance-plan.md`](../.agents/docs/performance-plan.md). Published frame and
storage budgets stay until a human accepts new numbers.

## Application tuning

- Reserve the expected label capacity.
- Reuse `Float64Array` IDs and `Float32Array` position buffers.
- Use `updatePositions` for movement and `updateTextPositions` for counter-style streams.
- Keep viewport culling enabled for large worlds.
- Reuse styles and fonts to maximize shaping and layout cache hits.
- Set an atlas ceiling that matches the product glyph working set.
- Read diagnostics at telemetry cadence.
