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

`bun run benchmark:check` validates artifact presence (the current package version, or the newest
older formal file), formal scale, browser completion, boolean invariants, frame budgets, mutation
budgets, storage ceilings, atlas eviction, and draw submission. It still measures the core ESM gzip
graph and does not fail that size. `bun run benchmark:check -- --require-current` is an optional
local gate that refuses a version with no matching files; `release:check` does not use it.

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

Atlas pages live in two texture arrays (R8 and RGBA8). Page-alternating multilingual runs retain
instance order in one mesh per blend/z, keeping WebGPU submission below its uniform-batch capacity.

## Known cliffs

The 1.1.0 suite meets the formal million-label frame and mutation budgets. Three facts still cap
how far the current code can go:

- `atlas-pressure` is legal today because the gate only checks the 4 MiB ceiling and eviction
  activation. The same artifact records 638.50 ms frame p95 while packing 20,000 unique glyphs.
- `dynamic-counters` sits at 16.40 ms frame p95, 0.27 ms under the 16.67 ms wall.
- `million-full` draws a synthetic 8,000,000-instance mesh. It proves one instanced GPU
  submission. `million-live` is the product-path workload; it has no 1.1.0 artifact yet.

Wave 1 of that program is in source: Skyline atlas packing, a next-fit equal-height shelf, per-mode
O(1) LRU, typed instance writes, numeric fill packing, a hierarchical hash grid, packed live atlas
keys, power-of-two instance free-list buckets, and policy-costed dirty uploads. Wave 2 has started
without changing
published ceilings: shared styles intern, position-only commits patch 16 palette bytes,
z-index is `Float32`, fill-only GPU transforms use 32 bytes with a sparse effect tail, the
CPU store packs non-position columns so one million reserved slots stay within 48 MiB plus
the journal floor, and live glyph instances use 24 bytes. Wave 3 adds stable WebGPU compute
compaction on the direct single-bank mesh. Camera frames inside an expanded CPU working set upload
only the tight draw viewport. Position-only storms inside that set patch resident AABBs and
palette texels without another grid query. WebGL keeps the tight CPU grid. Wave 0 adds `million-live`, split
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
- Leave `computeCull` at `"auto"` for WebGPU camera workloads. Set it to `false` to force the
  WebGL-compatible CPU grid.
- Pass `requestComputeCullGpu()` into `Application.init({ gpu })` so compute cull can bind
  instance storage larger than the 128 MiB WebGPU default, and so the vertex stage can bind
  the palette storage buffer. WebGL and devices without vertex storage keep the texture
  palette. A WebGPU storage path does not gather 1,000,000 x/y values on a position-only or
  camera-only commit. After the first full upload the GPU table owns live x/y, and a
  position-only storm uploads one packed move-command buffer.
- Reuse styles and fonts to maximize shaping and layout cache hits. Duplicate strings intern one
  layout result per (family, size, weight, text). Broadcast `updateTextPositions` with default
  anchors uses a columnar content lane: one layout, a shared prototype range, packed x/y, and
  `placeMany` for the shared local box. Position-only storms write store x/y once; the
  spatial index aliases those columns and only rebuckets on a cell crossing. Non-zero anchors,
  non-unit scale, shaping overrides, and trusted runs stay on the object path. Duplicate
  strings do not copy instance bytes. Draw instances are 8 bytes per visible glyph; shaders
  fetch the unique store from a
  prototype texture. Compact and scatter stamp the palette index.
- Set an atlas ceiling that matches the product glyph working set.
- Compute-cull layouts first-seen labels in the tight draw view. The 0.25-viewport ring may
  admit intern hits and same-commit copies of a tight unique string, up to
  `culling.offscreenAdmitBudgetBytes` (default 65536). Ring-only unique misses stay unshaped.
  Deferred ring hits resume on a later ring query or when they enter the tight view. Atlas
  texel uploads for already-instanced glyphs stay ungated. The expanded working set is residency
  slack, not a prepare batch. Known strings hit the shape cache on the same turn and share
  instance ranges. First-seen fill-only copies of those strings skip per-label snapshots and
  write the palette in a column. Distinct first-seen strings prepare those columns in parallel.
  Unique groups that share a fill write one `writeFills` column.
- Put stable UI alphabets on `rasterizerOptions.prebuilt` pages. Do not ship those pages in the
  core bundle. `pixi-glyphflow/prebuilt` (`uiSdfPrebuilt`, `charsetSdfPrebuilt`) is the optional
  side export; import it from that entry, not from `pixi-glyphflow`. Empty-ink scalars skip
  generation. Known CJK can be a crop when the host bakes that charset. A bake at one logical
  size that clamps to `distanceFieldMinFontSize` also serves the other clamp-equivalent sizes
  on first sight. Unseen ink and sizes above the minimum still generate in that commit.
- `culling.lod` drops labels whose projected font height is below one pixel. Leave it off unless
  the product accepts missing subpixel text.
- Read diagnostics at telemetry cadence.
