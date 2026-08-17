# Extreme performance program

Status: unstamped research and implementation program dated 2026-08-16.

The current conclusion: Waves 1 and the first three Wave 2 slices are in the tree. Keep the 1.1.0 public contract and instanced MSDF/SDF/alpha/color path. Atlas packing is Skyline plus a waste map with per-mode O(1) LRU; instances write through typed arrays; numeric fills skip `Color`; spatial queries use a hierarchical hash grid; shared styles intern to one frozen object; position-only commits patch palette x/y texels; z-index is `Float32` in the store and spatial index; fill-only GPU transforms use two `rgba32float` texels (32 bytes) and stroke/shadow live in a sparse tail after the core region; the CPU store packs scale/rotation/anchors as `f16` and alpha as `u8`, generations and source revisions as `u16`, and occupied/visible/kind into one flag byte, and the dirty journal keeps a sparse slot list. The 40 KiB core gzip CI gate is deferred. Published browser artifacts are still 1.1.0 — rerun the isolated Chrome suite on the reference M1 Pro before tightening frame budgets. Live instance 24-byte stride and Wave 0 live-layer 8M measurement are still open. Slug and Vello stay optional quality tracks.

This record is the research ledger and delivery sequence. Published numbers stay in [`docs/performance.md`](../../docs/performance.md) and [`benchmarks/PERFORMANCE.md`](../../benchmarks/PERFORMANCE.md). The 1.0 specification still owns budgets until a human tightens them.

## Current ceiling

Version 1.1.0 already meets the formal million-label frame and mutation budgets on the reference Apple M1 Pro Chrome fixture. The remaining gap is not “can it hold 60 Hz on the happy path.” It is:

1. Atlas churn is unbounded. `atlas-pressure` records 638.50 ms frame p95 while packing 20,000 unique 16×16 glyphs under a 4 MiB ceiling with 3,616 evictions. The budget gate only checks bytes and eviction activation, so this cliff is currently legal.
2. Dynamic text is at the wall. `dynamic-counters` records 16.40 ms frame p95 and 15.70 ms mutation p95 against a 16.67 ms limit.
3. Camera-only frames still walk every resident label. `SpatialIndex.query` is a dense linear scan. Viewport workloads stay inside budget (5.40–7.60 ms p95) but leave little room for denser worlds, rotated cameras, or slower devices.
4. The 8,000,000-glyph “full visibility” frame number is a synthetic `GlyphMesh`, not the live `TextLayer` commit, cull, and instance-build path. Treat 0.10 ms p95 as GPU submission evidence, not product-path evidence.
5. CPU and GPU store the same transform three times: `TextStore` columns, `SpatialIndex` bounds, and a GPU palette texel. Fill-only labels use 32 bytes on the GPU. The CPU store now packs the non-position columns; one million reserved slots stay ≤ 48 MiB in unit measurement. The 1.1.0 artifacts still report 72 MiB and 64-byte records.

Extreme here means: keep 1,000,000 resident labels and 8,000,000 visible glyphs, then make atlas pressure, dynamic counters, and camera motion cheap enough that the 16.67 ms budget is headroom rather than a cliff. Do not replace the product with a document renderer, a compute-only 2D engine, or an outline-only GPU path.

## Measured baseline

Source: generated 1.1.0 report in [`benchmarks/PERFORMANCE.md`](../../benchmarks/PERFORMANCE.md), captured on Apple M1 Pro, HeadlessChrome 151, WebGL 2, explicit `gl.finish()`.

| Workload | What it actually stresses | Frame p95 | Status |
| --- | --- | ---: | --- |
| static-hud | Equal-content vs PixiJS BitmapText | 0.10 ms | At BitmapText, already won |
| million-full | Synthetic 8M-instance `GlyphMesh` | 0.10 ms | GPU draw is cheap; not the live layer |
| million-viewport | Linear cull of 1M labels | 5.40 ms | Inside budget, O(n) |
| viewport-drag | Camera + linear cull | 5.80 ms | Inside budget |
| viewport-zoom | Camera + visible-set churn | 7.60 ms | Inside budget, largest camera cost |
| position-storm | 100,000 packed x/y + spatial translate | 9.50 ms | Intake is fine (3.60 ms); commit is 6.10 ms |
| dynamic-counters | 100,000 text+transform mutations | 16.40 ms | At the formal wall |
| atlas-pressure | Pack + evict 20,000 unique glyphs | 638.50 ms | Unbudgeted cliff |
| multilingual-stream | Shape/fallback/atlas misses | 1.50 ms | Not the limiter at 10k labels |
| scale-scan | Distance-field quality across zoom | 6.10 ms | Quality path, not throughput |

Storage on the same artifacts: 72 MiB CPU store, 64-byte transform records, 32-byte glyph instances, 244.14 MiB for the 8M-glyph buffer. Those match the specification ceilings. They are not yet extreme.

## Structural diagnosis

These are code facts, not profiler folklore. Each item names the structure that has to change.

### Atlas pack and evict were quadratic under pressure

`Packer` is now Skyline Bottom-Left plus a waste map; rectangle keys are packed integers when the page is under 8192. `GlyphAtlas` evicts through a per-mode doubly-linked LRU. The 1.1.0 `atlas-pressure` artifact still measures the old guillotine and linear clock scan.

That is why `atlas-pressure` spends seconds in setup and hundreds of milliseconds per batch. Jylänki’s survey treats guillotine as the simple/fast teaching algorithm, not the online font-atlas algorithm. Production font atlases use Skyline for online inserts (`stb_rect_pack`, FontStash, NanoVG) and MaxRects for offline prebakes.

### Instance writes were scalar DataView traffic

`GlyphInstanceStore` now writes through `Float32Array` / `Uint16Array` / `Uint32Array` views. Content commits skip `#matches`. The coordinator reuses scratch batches. The free list is still a linear best-fit. String atlas keys still sit on the inner glyph loop.

This is the likely core of `dynamic-counters` sitting at 16.40 ms. The 32-byte stride itself is fine. The way it is filled is not.

### Transforms are parsed and stored three times

`TransformPalette.set` writes a 32-byte fill-only core (xy, scale, packed half2 rotation, packed half2 anchors, packed RGB, packed alphas plus an effect flag). Stroke and drop shadow occupy one extra texel after `capacity * 2`, allocated only when any label first uses those effects. Numeric fills skip PixiJS `Color`, and position-only commits call `setPosition` so a position storm dirties 16 bytes. `TextStore` keeps `x`/`y`/`zIndex` as `Float32` and packs scale, rotation, and anchors as binary16 so they match the GPU palette quanta. Alpha is `u8`, matching the palette. Occupied, visible, and the position-only kind share one flag byte. Generation and source revision are `u16`. The dirty journal still has a per-slot mask but grows the dirty-slot list with the pending wave and releases it on publish. `SpatialIndex` still stores a second copy as min/max bounds.

The published 128 MiB store and 64-byte transform ceilings stay until new M1 Pro Chrome artifacts exist. Do not fail CI on 48 MiB or 32-byte transforms yet.

### Culling was a full-resident scan

`SpatialIndex.query` and `hitTest` now walk a size-classed hash grid and fall back to the linear scan only when the query would visit most residents. The 1.1.0 artifacts still measure the linear path.

### The million-glyph GPU path is not the product path

`runMillionFull` builds a `TextLayer` for storage counters, then draws a separately filled `GlyphMesh`. That is useful GPU evidence (one instanced draw, 8,000,000 instances, non-transparent output). It does not measure layout, atlas lookup, instance compaction, or culling at that scale. An extreme program has to add a live-layer full-visibility workload before claiming 8M-glyph product performance.

### String maps sit on every hot cache

Atlas entries, pins, LRU clocks, pending rasters, layout runs, and draw states are `Map<string, …>` or `Map<number, object>`. Interned numeric glyph keys and slot-indexed arrays remove hash and GC traffic from the 100,000-mutation path.

## Research map

Each row is a technique this package can steal, adapt, or reject. URLs are durable sources, not session notes.

### Glyph imaging

| Source | What it is | Steal | Reject as default |
| --- | --- | --- | --- |
| Green, *Improved Alpha-Tested Magnification for Vector Textures and Special Effects*, SIGGRAPH 2007 courses | Single-channel SDF atlas, shader threshold + halo | Already the SDF/MSDF product model | Regenerating bitmaps on rotate/zoom |
| Chlumsky, *Shape Decomposition for Multi-channel Distance Fields* (2015); [msdfgen](https://github.com/Chlumsky/msdfgen) | RGB distance channels preserve corners | Keep MSDF for scalable UI and zoom | Offline-only generation; current dynamic path must stay |
| Esfahbod, [glyphy](https://github.com/behdad/glyphy) | Arc-approximated SDF, no large bitmap atlas | Optional huge-glyph / extreme-zoom quality | Per-fragment cost too high for 8M tiny labels |
| Lengyel, *GPU-Centered Font Rendering Directly from Glyph Outlines*, [JCGT 6(2)](https://jcgt.org/published/0006/02/02/) (2017); shaders now [public-domain / MIT](https://github.com/EricLengyel/Slug) | Analytic coverage from quadratic Béziers in the fragment shader | Optional `glyphMode: "outline"` for huge zoom and 3D-ish projection | Default path: divergent fragments, no cheap minification, CJK/color fonts still need atlases |
| Loop and Blinn, *Resolution Independent Curve Rendering*, SIGGRAPH 2005 | Implicit curve tests on GPU | Historical baseline for Slug | Precision artifacts Lengyel later fixed |
| Mapbox TinySDF + PBF glyph ranges; [native text wiki](https://github.com/mapbox/mapbox-gl-native/wiki/Text-Rendering) | 24 px SDF, local CJK via canvas, protobuf range cache, IndexedDB | Fast local SDF, prebaked Latin/CJK ranges, halo from distance | Server glyph protocol as a required dependency |
| Unity TextMeshPro | Static SDF atlas + dynamic fallback atlas | Hybrid prebake + runtime populate | Object-per-label CPU model |
| deck.gl `TextLayer`; troika-three-text `BatchedText` | Shared atlas, one draw, worker SDF | Confirms the current batching thesis | Per-text object graphs; troika’s `onBeforeRender` CPU tax |

### Atlas packing

| Source | What it is | Steal | Reject as default |
| --- | --- | --- | --- |
| Jylänki, *A Thousand Ways to Pack the Bin* (2010); [RectangleBinPack](https://github.com/juj/RectangleBinPack) | Empirical comparison of Shelf, Guillotine, MaxRects, Skyline | Skyline Bottom-Left + waste map for online glyphs; MaxRects for prebaked pages | Current leftover-area guillotine |
| `stb_rect_pack.h`, FontStash, NanoVG | Skyline in production font atlases | Same-height glyph rows pack as shelves | Offline-only MaxRects for streaming CJK |
| Unreal / TMP multi-atlas | Overflow to a new page instead of failing | Already have pages; add same-height shelves and O(1) LRU | Resetting the whole atlas on overflow |

### Spatial queries and GPU-driven submission

| Source | What it is | Steal | Reject as default |
| --- | --- | --- | --- |
| Schornbaum, *Hierarchical Hash Grids for Coarse Collision Detection* (2009) | Size-classed hash grids, O(1) insert/remove, billion-object class | Two- or three-level 2D hash grid for labels | Pointer quadtrees in JS |
| Unreal `THierarchicalHashGrid2D` | One cell per item, query box expanded by half a cell | Simple, mutation-friendly, good for mixed label sizes | Deep BVH rebuilds on every position storm |
| Karras / NVIDIA LBVH; Morton / Z-order papers | Sort by interleaved coordinates, linear BVH | Optional rebuild for mostly-static worlds | Rebuilding a BVH on 100,000 moves per commit |
| Frostbite / Ubisoft GPU-driven pipelines; [vkguide compute culling](https://www.vkguide.dev/docs/gpudriven/compute_culling/) | Compute frustum test, compact survivors, `drawIndirect` | WebGPU adapter: cull + compact instances on GPU | WebGL2 default; no compute, keep CPU grid |
| Three.js Blocks `BatchedText` / `ComputeInstanceCulling` | GPU frustum + LOD + bitonic sort for SDF batches | LOD glyph drop at tiny screen size; indirect args | Transparency sort that breaks our insertion-order contract |

### Shaping, layout, and engines we will not become

| Source | What it is | Steal | Reject as default |
| --- | --- | --- | --- |
| HarfBuzz; [harfbuzzjs](https://github.com/harfbuzz/harfbuzzjs); Behdad SIMD notes | Production shaper, digest filters, optional SIMD | Keep worker HarfBuzz; intern shape plans; transferable caches | Replacing it with rustybuzz (1.5–2× slower) |
| cosmic-text / Parley | Shape-plan and run caches | Cache key shape already specified; make it numeric and shared | In-process editor semantics |
| Vello (formerly piet-gpu), [linebender/vello](https://github.com/linebender/vello); Pathfinder; Forma | Compute-centric 2D, prefix sums, sparse strips | Ideas for huge outline glyphs and clip | Replacing PixiJS Mesh with a compute renderer |
| Flutter Impeller typography | Row-packed glyph atlas, integer boxes | Integer UV packing, row shelves | Skia/Impeller as a peer |
| Skia / Chrome text | Huge complexity, subpixel, hinting | Measurement honesty, cache hierarchy | Document-editor scope |

### Data-oriented packing

| Source | What it is | Steal |
| --- | --- | --- |
| Acton / Fabian data-oriented design | SoA, no objects on the hot path | Finish the job: slot arrays instead of `Map`s |
| [The Art of Packing Data](https://www.elopezr.com/the-art-of-packing-data/); Toji, [WebGPU compute + vertex data](https://toji.dev/webgpu-best-practices/compute-vertex-data.html) | f16, pack/unpack, storage-buffer alignment | Half-float local glyph offsets; `pack2x16float` on WebGPU |
| Chrome WebGPU `shader-f16` | Native f16 when the adapter allows it | Optional packed instance path; f32 fallback |

## Program

Ship in waves. Each wave must beat run-to-run variance on the existing isolated Chrome suite and preserve WebGL 2 as the compatibility baseline. Do not land an optimization that only wins on WebGPU unless the WebGL path stays within current frame and storage budgets. The 40 KiB core gzip CI fail is deferred; keep measuring the graph.

### Wave 0 — Measurement honesty

Make the laboratory tell the truth before changing algorithms.

- Add a live-layer full-visibility workload that commits 1,000,000 labels through `TextLayer` and draws the coordinator mesh, not only `createStressMesh`.
- Split every frame sample into CPU JS, upload bytes, and GPU completion. Keep `gl.finish()` / WebGPU `onSubmittedWorkDone` but report them separately.
- Put `atlas-pressure` under a real frame budget. The first honest number will fail; that is the point.
- Record mutation, layout, instance-write, palette-write, spatial-update, and upload timers in `TextLayer.stats` so later waves prove their own claim.
- Keep the synthetic 8M mesh as a GPU-throughput probe with a different workload id.

Acceptance: `bun run benchmark:check` fails `atlas-pressure` until Wave 1 lands, and the live full-visibility artifact exists even if it misses 16.67 ms.

### Wave 1 — CPU cliffs, same public contract

Highest leverage. No shader contract change. No new peer dependency.

**Atlas.** Replace guillotine with Skyline Bottom-Left plus a waste map for holes left by eviction. Keep page size and byte ceiling. Replace string rectangle keys with packed integer keys. Replace `#evictOldest` with a doubly-linked LRU (unpin moves to tail, evict pops head). Shelf-pack equal-height 16×16 / MSDF cells when the incoming size matches the current row.

**Instances.** Write instances through `Float32Array` / `Uint32Array` views over the same `ArrayBuffer`. Skip `#matches` when the dirty journal already says content changed. Bucket the free list by power-of-two size so allocate is O(1). Reuse per-thread scratch batches in `RenderCoordinator` instead of allocating six arrays per label.

**Transforms.** Add a packed numeric fill path that does not construct PixiJS `Color`. Add `writePositions(slots, xy)` that patches only the x/y texels. Precompute sin/cos only when rotation is dirty.

**Spatial.** Replace the linear scan with a two-level hierarchical hash grid: fine cells for ordinary labels, coarse cells for large or rotated bounds. One slot occupies one cell; queries expand by half a cell, matching Unreal’s 2D grid. Keep SoA bounds for the exact test. Store z-index as `Int32` unless a fixture proves it needs float.

**Keys.** Intern atlas and shape keys to numeric ids (`familyId`, `glyphId`, `sizeBucket`, `mode`). Keep the string form only for diagnostics.

Primary targets, versus 1.1.0 artifacts:

| Workload | 1.1.0 p95 | Wave 1 target |
| --- | ---: | ---: |
| atlas-pressure | 638.50 ms | ≤ 16.67 ms |
| dynamic-counters frame | 16.40 ms | ≤ 8.00 ms |
| dynamic-counters mutation | 15.70 ms | ≤ 6.00 ms |
| viewport-zoom | 7.60 ms | ≤ 3.00 ms |
| position-storm commit | 6.10 ms | ≤ 3.00 ms |

Verify: `bun test tests/GlyphAtlas.test.ts tests/GlyphInstanceStore.test.ts tests/culling.test.ts tests/TextLayer.commit.test.ts` and `bun run benchmark -- --workload atlas-pressure,dynamic-counters,viewport-zoom,position-storm`.

### Wave 2 — Compress duplicated state

Do this only after Wave 1 timers show where the remaining bytes and bandwidth go.

- Make `TransformPalette` the GPU view of `TextStore` columns plus a sparse effect table. Fill-only labels use a 16- or 32-byte record (xy, scale, packed rotation, packed rgba, packed flags). Stroke/shadow stay in a side table.
- Stop mirroring x/y into spatial storage as a second write; derive query bounds from position plus cached local width/height.
- Quantize instance local rectangles to f16 or 16-bit fixed point relative to the label origin. UVs are already `uint16`. Target 20–24 bytes per glyph before proposing a budget change. Keep the 32-byte public ceiling until artifacts prove the smaller stride.
- Intern `style` and `text` references in `TextStore` so 100,000 counters that share a format do not hold 100,000 style objects.
- Upload only dirty palette texels and dirty instance ranges. Position storms should not rewrite fill/effect texels.

Primary targets: CPU store ≤ 48 MiB per 1,000,000 allocated labels; transform ≤ 32 bytes per fill-only label; instance ≤ 24 bytes per glyph on the live path; `position-storm` frame p95 ≤ 4 ms.

Verify: existing storage assertions in `benchmarks/budgets.ts` plus new optional tighter checks behind the same command once artifacts exist.

### Wave 3 — WebGPU compute cull and storage buffers

WebGL 2 keeps the Wave 1 CPU grid. WebGPU gains a second adapter that does not walk JS arrays on camera-only frames.

- Move the transform palette from an `rgba32float` texture to a storage buffer. Eight atlas pages can become a 2D texture array so the fragment shader indexes one binding instead of eight.
- Upload label bounds once. A compute pass tests the viewport (or OBB for rotation), writes a compacted instance-index buffer, and patches `drawIndirect` arguments. No CPU readback on the hot path.
- Preserve insertion order and z-index. Do not use atomic append order for visible text. Prefix-sum or per-bin stable counts, then scatter.
- Optional LOD: drop or downsample glyphs whose projected height is below one pixel, following map-label practice. This is a policy flag, default off, because it changes pixels.

Primary targets: camera-only CPU ≤ 1.00 ms p95 at 1,000,000 residents / 50,000 visible; WebGPU `viewport-drag` and `viewport-zoom` at or below the Wave 1 CPU-grid numbers; WebGL 2 unchanged within variance.

Verify: `bun run test:browser -- glyph-rendering` and both-adapter site/browser suites. Capability diagnostics must report `compute-cull` vs `cpu-grid`.

### Wave 4 — Glyph generation and residency

The packer is no longer the limiter; generation and upload are.

- Add a TinySDF-style local SDF path for system and CJK fallback so `@zappar/msdf-generator` is not on the first miss for every ideograph. Keep exact HarfBuzz glyph IDs for registered binary fonts.
- Support prebaked MSDF/SDF pages as the default for known UI alphabets (TMP hybrid model; Mapbox PBF ranges). Dynamic pages handle the long tail.
- Budget atlas uploads per frame and resume across frames. A 20,000-glyph first miss must not hitch a single commit.
- Optional persistent cache is a product decision (IndexedDB, as in Mapbox local glyphs). Do not add it without a human license and privacy pass.
- Pin the visible set and a small predictive ring around the current viewport/zoom, so zoom does not evict the glyphs it will need on the next wheel tick.

Primary targets: `atlas-pressure` with real raster work, not 16×16 stubs, stays inside 16.67 ms after warmup; `multilingual-stream` commit p95 stays ≤ 2 ms at 1,000 mutations; first-use CJK miss rate falls without growing the core bundle.

### Wave 5 — Extreme quality tracks

These are optional modes. They must not disturb the default 8M-instance budget.

- `glyphMode: "outline"` using the public Slug algorithm for labels whose projected size exceeds an MSDF safe magnification. One font curve texture plus a spatial lookup texture, not a bitmap atlas. Expected use: title cards, extreme zoom, perspective. Not the million-label default.
- Huge-glyph compute raster (Vello/Pathfinder ideas) for a handful of billboard strings, composited as color atlas entries.
- Map-style collision and density: hide overlapping labels by priority instead of drawing 50,000 stacked strings. This is a new product feature, not a silent cull.
- WASM SIMD HarfBuzz if harfbuzzjs exposes it and a shaping microbench beats the current worker by more than variance.
- SharedArrayBuffer ring between the shaping worker and the instance store, so shaped runs never copy.

Each track needs its own workload and a documented pixel tolerance. None of them may raise the core gzip size.

## Proposed budget tightening

These are proposals. The specification budgets stay until a human accepts new numbers and Wave 0 can measure them.

| Budget | 1.1.0 rule | Proposed extreme rule |
| --- | --- | --- |
| atlas-pressure frame p95 | unchecked | 16.67 ms after Wave 1 |
| dynamic-counters frame p95 | 16.67 ms | 8.00 ms after Wave 1 |
| camera-only CPU at 1M / 50k | folded into frame | 1.00 ms after Wave 3 on WebGPU |
| live-layer 8M glyphs | synthetic mesh only | measured product path; budget set from Wave 0 |
| CPU store / 1M | 128 MiB (72 used) | 48 MiB after Wave 2 |
| transform record | 64 B | 32 B fill-only after Wave 2 |
| glyph instance | 32 B | 24 B after Wave 2, 32 B still the compatibility ceiling |
| core ESM gzip | 40 KiB CI fail deferred | still measured; no replacement ceiling |

## Constraints that stay in force

Always:

- Measure before and after every retained change. Variance still wins.
- Keep WebGL 2 correct and inside current budgets when a WebGPU-only path is added.
- Keep root imports side-effect free. Still measure core gzip; do not fail CI on it.
- Reject stale worker and atlas generations.

Ask first:

- Persistent glyph caches, new required WASM, or any dependency larger than the current optional shaping assets.
- Public budget changes and new `glyphMode` values.
- License changes. Slug shaders are MIT / public-domain; this package is still UNLICENSED.

Never:

- Replace `TextLayer` with a document editor, HTML/CSS layout, or a Vello/Skia host.
- Make Slug or compute-raster the default million-label path.
- Publish an unmeasured performance claim.
- Break sibling-layer and sibling-application resource isolation.

## Implementation order

    Wave 0 laboratory
      -> Wave 1 atlas Skyline + LRU, typed instance writes, hash grid, packed fills
        -> Wave 2 palette/store/instance compression
          -> Wave 3 WebGPU compute cull + texture array
            -> Wave 4 TinySDF / prebake / upload budget
              -> Wave 5 outline mode, collision, SIMD, SAB ring

Wave 1 is the only wave that should start without a new human budget decision. Waves 2–5 change published ceilings, shader bindings, or product surface and need an explicit accept.

## What this record is not

It is not a decision ledger. No ruling here is vouched. If this area should record human judgments, open `performance-plan-decisions.md` beside this file.

It is not a substitute for raw artifacts. After each wave, overwrite the generated report from isolated Chrome runs and point the map at those files.
