# Extreme performance program

Status: unstamped research and implementation program dated 2026-08-16.

The current conclusion: Waves 0–3 are in the tree. Keep the 1.1.0 public contract and instanced MSDF/SDF/alpha/color path. Atlas packing is Skyline plus a waste map, a next-fit equal-height shelf, and per-mode O(1) LRU; instances write through typed arrays; numeric fills skip `Color`; spatial queries use a hierarchical hash grid; shared styles intern to one frozen object; position-only commits patch palette x/y texels; z-index is `Float32` in the store and spatial index; fill-only GPU transforms use two `rgba32float` texels (32 bytes) and stroke/shadow live in a sparse tail after the core region; the CPU store packs scale/rotation/alpha/anchors as `f16`, generations and source revisions as `u16`, and occupied/visible/kind into one flag byte, and the dirty journal keeps a sparse slot list; live glyph instances use 24 bytes (four `f16` local-rect components, bound as `uint32x2` and unpacked in the shader). Live atlas keys pack to 52-bit integers; the instance free list is power-of-two segregated; dirty uploads merge a 256-byte gap, band leftover ranges after 8, and promote when dirty bytes reach 75% of the live span. WebGPU camera frames keep an expanded CPU working set and use stable prefix-sum compaction for the tight draw viewport on the direct natural-order mesh. WebGL and unsupported WebGPU draws keep the tight CPU grid path. Wave 0 adds `million-live` (coordinator mesh, not `createStressMesh`), splits rendering frames into CPU / upload / GPU completion, and records layout, instance-write, palette-write, spatial, and upload timers on `TextLayer.stats`. The 40 KiB core gzip and `atlas-pressure` frame CI gates stay deferred. Do not fail the 1.1.0 638 ms artifact. Published browser artifacts are still 1.1.0; `million-live` has no reference artifact yet. Slug and Vello stay optional quality tracks.

This record is the research ledger and delivery sequence. Published numbers stay in [`docs/performance.md`](../../docs/performance.md) and [`benchmarks/PERFORMANCE.md`](../../benchmarks/PERFORMANCE.md). The 1.0 specification still owns budgets until a human tightens them.

## Current ceiling

Version 1.1.0 already meets the formal million-label frame and mutation budgets on the reference Apple M1 Pro Chrome fixture. The remaining gap is not “can it hold 60 Hz on the happy path.” It is:

1. Atlas churn is unbounded. `atlas-pressure` records 638.50 ms frame p95 while packing 20,000 unique 16×16 glyphs under a 4 MiB ceiling with 3,616 evictions. The budget gate only checks bytes and eviction activation, so this cliff is currently legal.
2. Dynamic text is at the wall. `dynamic-counters` records 16.40 ms frame p95 and 15.70 ms mutation p95 against a 16.67 ms limit.
3. Camera-only frames still walk every resident label. `SpatialIndex.query` is a dense linear scan. Viewport workloads stay inside budget (5.40–7.60 ms p95) but leave little room for denser worlds, rotated cameras, or slower devices.
4. The 8,000,000-glyph “full visibility” frame number in 1.1.0 artifacts is a synthetic `GlyphMesh`. `million-live` now exists as the product-path workload; treat 0.10 ms p95 as GPU submission evidence until a reference `million-live` artifact exists.
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

## Same-machine A/B evidence (2026-08-22, non-reference)

Cloud VM, headless system Chrome on SwiftShader WebGL 2, identical harness semantics per workload
(drivers diffed against v1.1.0). Relative deltas only; not reference artifacts. The browser suite
had been unrunnable since Wave 0 (node:os in the page bundle — see gotchas); these are the first
post-Wave-1/2/3 browser numbers at all.

| Workload | v1.1.0 p95 | HEAD p95 | Read |
| --- | ---: | ---: | --- |
| atlas-pressure | 550.1 ms | 4.0 ms | Wave 1 packer/LRU delivered (~137×) |
| million-viewport | 6.4 ms | 0.3 ms | hash grid delivered (~21×) |
| position-storm | 10.3 ms | 8.3 ms | packed positions delivered (~1.2×) |
| viewport-zoom | 9.0 ms | 38.2 → 11.5 ms | grid sort cliff at dense results; fixed by the result-aware linear fallback |
| dynamic-counters | 15.1–16.6 ms | 23.5–24.9 ms | REGRESSION: mutation intake 14.5 → 19.6 ms (f16 column packs), commit 0.7 → 4.0 ms (2.9 ms hash-grid updates). Open. |
| million-live (HEAD only) | — | 0.10 ms | product-path 8M-glyph submission at the GPU floor |

The dynamic-counters regression is the Wave 1/2 trade surfacing: the store packs f16 columns per
mutated field and the grid re-hashes per moved label. Wave 1's ≤ 8 ms target is currently not
plausible without batch-aware packing or a cheaper grid update. Reference M1 Pro artifacts are
still required before changing any published number.

## Whole-repo audit (2026-08-22)

Four parallel code audits (CPU core, glyph pipeline, render pipeline, laboratory) against this
plan. Full evidence lives in the audit conversation; the durable conclusions:

**Delivered and near floor — stop optimizing here.** Skyline/waste/shelf packing, per-mode O(1)
LRU, 52-bit keys, the 48 MiB store (test-pinned, 44.9 MiB measured), the sparse journal, the
4-level hash grid, 24-byte instances, 32-byte fill transforms, camera-only WebGPU frames
(~50–100 µs CPU), and packing CPU (~µs/glyph). Verified in code, not just claimed.

**Where the next order of magnitude actually is, ranked (status as of the same day):**

1. **MSDF first-miss batching — LANDED.** `@zappar/msdf-generator` re-posts and WASM-re-parses the
   entire font per glyph (one worker atlas per glyph, 10–60 ms each) and it is the default HarfBuzz
   mode. Unpatched-cmap misses now batch per (family, revision, raster size) within a microtask
   window into one generator pass: one font parse plus N crops. Patched-cmap glyphs stay solo, and
   multi-glyph atlases no longer fall back to `glyphs[0]`.
2. **Draw-segment cache keyed on `drawListEpoch` — LANDED**, plus `GlyphInstanceStore.segmentEpoch`
   (bumps only when existing ranges are disturbed, so appends extend the cached walk). The mesh
   vertex buffer also stops mirroring dirty bytes while compute cull owns the draw; any CPU
   fallback re-initializes it.
3. **Columnar position-only commit lane — LANDED.** `TransformPalette.writePositions` plus
   slot/xy column copies at publish time; rendered movers skip the two frozen snapshots, the change
   object, and the prepared wrapper. Same-machine dynamic-counters returned to the 1.1.0 range
   (16.7 ms vs 15.1–16.6 baseline) while keeping the 48 MiB store and the hash grid.
4. **Atlas upload shape — LANDED except admission budget.** Single-channel and four-channel pages
   upload staged glyph rectangles, promoting to a full upload when rects exceed half the page.
   Four-channel RGB is premultiplied on the CPU so a raw sub-rect write matches Pixi's former
   upload-time step. Atlas residency is wired: the coordinator refcounts each label's atlas keys
   and pins/unpins entries, so eviction can no longer reuse rectangles that live instances sample —
   under all-pinned pressure the atlas now reports capacity loudly instead of corrupting silently.
   Still open: a per-frame byte budget with cross-frame resume must gate label admission, not texel
   uploads (deferring texels for already-instanced labels would draw stale pixels, which the
   no-drip gotcha forbids).
5. **Palette multi-row upload and incremental create — LANDED.** Contiguous full palette rows
   become one GPU write when the row stride is 256-byte aligned (default width 1024). Creates after
   the first residency query no longer flip `visibilityDirty`; the resident dirty path admits
   unrendered slots that belong in the current set. Hide/show/remove/group still refresh. On-screen
   creates still finish in that commit.
6. **Duplicate-string layout intern and in-place clone — LANDED.** First-seen copies of a known
   (family, size, weight, text) skip `LayoutEngine.layout`. `clone` keeps a dest range that already
   fits. Broadcast text-plus-position with zero anchors patches 16 palette bytes. Unique-glyph
   raster in the seeing commit is unchanged.
7. **Broadcast content lane — LANDED.** Rendered labels that share one interned (text, style) and
   zero anchors skip per-label snapshots: `applyContentLane` layouts once, clones in place, and
   writes packed x/y. Mixed text, shaping, trusted runs, and non-zero anchors stay on the object
   path.
8. **Batch clone and spatial place — LANDED.** `cloneMany` copies one prototype onto a dest
   column and bumps `segmentEpoch` once. `placeMany` writes AABBs from packed x/y plus a shared
   local box. Content-lane candidates now also require unit scale and zero rotation. Rendered
   unit-transform storms skip the intake estimate rehash. Wave 1's ≤ 8 ms `dynamic-counters`
   target still needs a reference M1 Pro artifact before anyone claims the number.
9. **Shared prototype instance ranges — LANDED.** Duplicate strings point at one instance block.
   Compute scatter and the CPU compact mesh stamp `paletteIndex` from the cull record / draw
   span. Store `highWater` tracks unique glyphs; `activeInstances` stays the logical sum.
10. **First-seen admit lane — LANDED.** Fill-only first-seen duplicates skip per-label snapshots:
    one layout per (text, style), `shareMany`, `writeFills`, draw-state insert, `placeMany`.
    Unique-glyph raster in the seeing commit is unchanged. Wave 1's ≤ 8 ms `dynamic-counters`
    target still needs a reference M1 Pro artifact before anyone claims the number.
11. **Prototype-fetch instance mesh — LANDED.** Draw instances are `(prototypeGlyph, paletteIndex)`.
    Shaders fetch the unique 24-byte store from an RGBA32F prototype texture. UV is packed as f16
    and metadata as two integer floats (raw store uints are NaN in RGBA32F). Width comes from the
    texture, not a third glyph uniform. Scatter and CPU compact write 8 bytes per visible glyph.
    Palette growth rewrites the existing proto texture so Pixi's first-upload snapshot cannot
    drop dirty glyphs after texel 0. Replacing the proto `Texture` leaves vertex fetches empty.
    One mesh per unique string stays rejected.
12. **Off-screen unique admit — LANDED.** Compute-cull still instances the 0.25-viewport ring.
    Tight-view unique layout and raster stay in the seeing commit. Ring-only unique misses stay
    unshaped until they enter the tight view or an intern hit exists. A ring copy of a tight
    unique string this commit stays in that group. No leftover rAF, no `prepareBudgetMs`.
    Unique glyphs that are on screen still raster in that commit.
13. **Parallel admit-group prepare — LANDED.** `applyAdmitLane` starts every unique group's
    layout and raster together, same as object-path `#prepareChanges`. Layout count stays one
    per (text, style). Wall-clock is no longer the sum of those prepares. Instance and palette
    writes stay serial after the wave settles. Tight-view unique still finishes in that commit.
14. **TinySDF microtask batch + FontFace intern — LANDED.** Same-size TinySDF misses share one
    FontFace wait and serialize canvas plus EDT after that wait. EDT stays per unseen ink
    glyph. Neighbors on one sheet would corrupt distances. Concurrent `#ensureDocumentFont`
    for one family shares
    one `FontFace.load()`. Do not ship default baked pages in the core gzip graph.
15. **Columnar spatial translate — LANDED.** `translateMany` slides occupied AABBs from packed
    deltas. Translate does not change size, so the size class stays and only a cell-boundary
    crossing rebuckets. Spill still goes through `#cellFor` in case a coord overflow can
    re-enter a cell. `updatePositions` and same-text `updateTextPositions` collect one delta
    column. Do not rewrite z or visibility. Wave 1's ≤ 8 ms `dynamic-counters` target still
    needs a reference M1 Pro artifact before anyone claims the number.
16. **Admit fill merge — LANDED.** Unique first-seen groups that share a `style.fill`
    identity concatenate slots/xy and call `writeFills` once. Instance columns and
    draw-state inserts stay per (text, style). Distinct fill identities stay separate.
    Do not merge by resolved paint when the fill objects differ. On-screen unique still
    finishes in that commit.
17. **Optional UI SDF side export — LANDED.** `pixi-glyphflow/prebuilt` (`uiSdfPrebuilt`) bakes
    a coarse VGA 8×8 SDF of U+0020–U+007E at 16 px. First call encodes; later calls remap keys.
    `RasterGlyphProvider` retries a miss with `glyphId: 0` when `glyphText` is one Unicode
    scalar so HarfBuzz ids crop that page. Ligatures stay exact-key only. Default pages stay
    out of `src/index.ts` and the core gzip graph. This is not production typography.
18. **Physical distance-field intern — LANDED.** TinySDF and MSDF intern the field at
    `max(fontSize, distanceFieldMinFontSize)`. A 16px and 32px miss of the same glyph share
    one canvas+EDT or one generator pass and keep per-request `rasterScale`. TinySDF keys
    omit HarfBuzz id because canvas paints `glyphText`. Sizes above the minimum stay unique
    physical rasters. Atlas entries stay per size bucket. A first unseen CJK at one size
    still generates once.
19. **Empty-ink generation skip — LANDED.** White_Space except Ogham U+1680, plus
    default-ignorable scalars, skip `#ensureGlyph` and instance quads. Layout advance and
    the label AABB stay, so hit tests do not shrink. Trusted runs, ligatures, and
    shared-cluster marks still generate. `encodeTinySdf` skips both EDTs when the mask has
    no covered pixel. A first unseen CJK with ink still generates once.

**Regressions and traps the audits confirmed:**

- dynamic-counters (see A/B table): intake paid f16 packs, an O(len) `estimateTextBounds` with
  unconditional sin/cos per `updateMany` entry, and megamorphic patch probing; commit paid the
  per-label object pipeline. CLOSED the same day: the estimate memoizes by (text, style) identity
  (broadcast batches share one reference pair), rotation-zero skips the trig, the journal keeps
  its slot list at high water, dirty ranges store flat pairs with tail merging, and the columnar
  lane removed the object pipeline. Same-machine result: 23.5–24.9 → 16.7 ms, inside the 1.1.0
  range. `sourceRevision` is also u32 now, so the 65,535-edit counter death is gone (store is
  ~46.9 MiB per million slots, still under the 48 MiB target).
- The dirty-range 8-range cap used to collapse leftover ranges into one first-to-last span. It now
  buckets them into equal-width bands so two tight clusters do not upload the hole between them.
  The 256-byte-gap model is still the merge for dense edits. A uniform scatter across the live
  buffer can still promote to a whole-buffer upload via the 75% rule.
- `atlasCommit.evictedKeys` had no consumer and `pin`/`unpin` had no callers: under real atlas
  pressure, evicted rectangles could be reused while live instances still sampled them. CLOSED the
  same day: the coordinator refcounts per-label atlas keys and pins live entries (clones share the
  prototype's key set). `evictedKeys` stays diagnostic-only.
- One nonzero z-index used to set a permanent sort ratchet; the coordinator now keeps a live
  count of nonzero-z draw states, so a z-using scene that returns to all-zero z gets the
  append-only fast path back.

**Laboratory limits that gate all published claims:** five headline workloads never create a
renderer (their "frame" is store+spatial commit cost — honest numbers, misleading names);
million-live samples static redraws, its product cost lives in setup; no workload can reach the
WebGPU compute-cull path at all (rendering off, culling off, WebGL default), so Wave 3's own
acceptance criterion is unmeasurable; and p95 on 5–7 samples is the max. The browser suite was
also unrunnable from Wave 0 until the `node:os` split (see gotchas). Landed since the audit: a
`first-seen` workload (rendering layer, camera jumps onto never-rendered regions each frame;
17.6 ms p95 for ~400 fresh labels per frame on the same-machine SwiftShader fixture — the first
probe of the 100× moment), and `--labels`/`--frames` overrides now write
`browser-<workload>-<version>-exploratory.json` with an `exploratory` marker instead of
overwriting the formal artifact. A `camera-live` workload now exists (rendering camera pans with
`computeCull: "auto"`, 200k labels; its invariants record which cull path ran, and
`--renderer webgpu` on WebGPU hardware exercises compute-cull — Wave 3's acceptance finally has a
probe; this VM's Chrome has no WebGPU, so only the CPU-grid side ran here at 5.1 ms p95).

## Structural diagnosis

These are code facts, not profiler folklore. Each item names the structure that has to change.

### Atlas pack and evict were quadratic under pressure

`Packer` is now Skyline Bottom-Left plus a waste map and a next-fit shelf for the current equal-height row; rectangle keys are packed integers when the page is under 8192. `GlyphAtlas` evicts through a per-mode doubly-linked LRU. The 1.1.0 `atlas-pressure` artifact still measures the old guillotine and linear clock scan.

That is why `atlas-pressure` spends seconds in setup and hundreds of milliseconds per batch. Jylänki’s survey treats guillotine as the simple/fast teaching algorithm, not the online font-atlas algorithm. Production font atlases use Skyline for online inserts (`stb_rect_pack`, FontStash, NanoVG) and MaxRects for offline prebakes.

### Instance writes were scalar DataView traffic

`GlyphInstanceStore` now writes through `Float32Array` / `Uint16Array` / `Uint32Array` views. Content commits skip `#matches`. The coordinator reuses scratch batches. The free list is a power-of-two segregated first-fit with adjacent merge. Live atlas keys are packed integers; string keys remain for tests, prebuilt pages, and identities that cannot pack.

This is the likely core of `dynamic-counters` sitting at 16.40 ms. Live instances now use a 24-byte stride (four `f16` local-rect components). Bind the rect as `uint32x2` and unpack with `unpackHalf2x16` / `unpack2x16float`; CI Chrome/ANGLE drew 0 pixels with a `float16x4` vertex format. The published 32-byte ceiling stays until new artifacts exist.

### Transforms are parsed and stored three times

`TransformPalette.set` writes a 32-byte fill-only core (xy, scale, packed half2 rotation, packed half2 anchors, packed RGB, packed alphas plus an effect flag). Stroke and drop shadow occupy one extra texel after `capacity * 2`, allocated only when any label first uses those effects. Numeric fills skip PixiJS `Color`, and position-only commits call `setPosition` so a position storm dirties 16 bytes. `TextStore` keeps `x`/`y`/`zIndex` as `Float32` and packs scale, rotation, alpha, and anchors as binary16 so they match the GPU palette quanta. Occupied, visible, and the position-only kind share one flag byte. Generation and source revision are `u16`. The dirty journal still has a per-slot mask but grows the dirty-slot list with the pending wave and releases it on publish. `SpatialIndex` still stores a second copy as min/max bounds.

The published 128 MiB store and 64-byte transform ceilings stay until new M1 Pro Chrome artifacts exist. Do not fail CI on 48 MiB or 32-byte transforms yet.

### Culling was a full-resident scan

`SpatialIndex.query` and `hitTest` now walk a size-classed hash grid and fall back to the linear scan only when the query would visit most residents. The 1.1.0 artifacts still measure the linear path.

### WebGPU camera frames compact an expanded working set

Compute culling separates CPU residency from the submitted draw set. The CPU grid shapes and
instances an expanded viewport. Camera motion inside that box uploads one tight viewport uniform
and dispatches stable prefix-sum compaction without rebuilding instances. Position-only storms
inside the same box patch resident cull AABBs and palette texels. They do not re-query or rebuild
draw segments. Crossing the working-set edge refreshes the draw-state set and cull records, but
keeps runs and instances so a later re-entry does not layout or raster again. Show/hide/add/remove
still goes through the store. WebGL and multi-segment meshes keep the tight CPU-grid path.

### The million-glyph GPU path is not the product path

`runMillionFull` still builds a `TextLayer` for storage counters, then draws a separately filled `GlyphMesh`. That remains the GPU-throughput probe. `runMillionLive` commits the same 1,000,000 labels through the coordinator and draws that mesh. A reference Chrome artifact for `million-live` is still required before claiming 8M-glyph product-path performance.

### String maps sit on every hot cache

Atlas entries, pins, LRU clocks, and pending rasters accept `string | number`. The coordinator intern packs family, glyph id, size bucket, weight class, mode, and font revision so the inner glyph loop does not build strings. Bitmap layout now builds the cache key and returns a hit before constructing PixiJS `TextStyle`. Shape-plan keys and some draw-state maps are still strings.

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
| [pmndrs/glyph](https://github.com/pmndrs/glyph) ([dirty-range upload research](https://github.com/pmndrs/glyph/blob/main/docs/planning/dirty-range-upload-research.md)) | Portable font bake + Wasm shape/layout; Three.js host; numeric glyph identities; policy-costed dirty uploads | Packed atlas keys; power-of-two free-list buckets; merge gap 256 B, max 8 ranges, promote at 75% of live bytes | Rust/Wasm layout engine; required GLB/`PMNDRS_font`; React/Three `Text` API; document edits; KTX2/Basis; Slug as the million-label default |

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

Acceptance: `million-live` is runnable beside `million-full`; frame samples split CPU, upload bytes, and GPU completion; `TextLayer.stats` exposes phase timers. `benchmark:check` measures `atlas-pressure` frame p95 and does not fail the 1.1.0 638 ms artifact. The live artifact is optional until a reference M1 Pro Chrome rerun.

### Wave 1 — CPU cliffs, same public contract

Highest leverage. No shader contract change. No new peer dependency.

**Atlas.** Replace guillotine with Skyline Bottom-Left plus a waste map for holes left by eviction. Keep page size and byte ceiling. Replace string rectangle keys with packed integer keys. Replace `#evictOldest` with a doubly-linked LRU (unpin moves to tail, evict pops head). Shelf-pack equal-height cells when the incoming height matches the current row (16×16 pressure tiles and common MSDF sizes).

**Instances.** Write instances through `Float32Array` / `Uint32Array` views over the same `ArrayBuffer`. Skip `#matches` when the dirty journal already says content changed. Bucket the free list by power-of-two size so allocate is O(1). Reuse per-thread scratch batches in `RenderCoordinator` instead of allocating six arrays per label. Dirty publishes use the pmndrs/glyph cost model (256-byte gap, 8-range cap, 75% whole-buffer promote).

**Transforms.** Add a packed numeric fill path that does not construct PixiJS `Color`. Add `writePositions(slots, xy)` that patches only the x/y texels. Precompute sin/cos only when rotation is dirty.

**Spatial.** Replace the linear scan with a two-level hierarchical hash grid: fine cells for ordinary labels, coarse cells for large or rotated bounds. One slot occupies one cell; queries expand by half a cell, matching Unreal’s 2D grid. Keep SoA bounds for the exact test. Store z-index as `Int32` unless a fixture proves it needs float.

**Keys.** Intern atlas keys to numeric ids (`familyId`, `glyphId`, `sizeBucket`, `weight`, `mode`, `revision`). Keep the string form for diagnostics, prebuilt pages, and identities that cannot pack. Shape-plan keys are still strings.

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

- The direct single-bank mesh now uploads label bounds with instance ranges. A compute pass tests
  the tight viewport, writes compacted instances, and patches indirect draw arguments.
- PixiJS keeps the 128 MiB storage-binding default. Million-label instance buffers request the
  adapter limit through `requestComputeCullGpu()` and fall back to `cpu-grid` when they still
  cannot bind.
- Camera-only commits inside the expanded CPU working set upload only the viewport uniform. Residency
  refreshes pack records and upload instances again. Leftover first-seen admission continues from a
  slot list and does not remirror the working set.
- Prefix sums and stable scatter preserve z-index and insertion order without atomic append order.
- WebGL, missing WebGPU devices, `computeCull: false`, and multi-segment compact meshes keep the
  tight CPU grid.
- Moving the transform palette to a storage buffer and combining atlas pages into a texture array
  remain follow-up work.
- Optional LOD: `culling.lod` drops labels whose projected font height is below one pixel. Default off, because it changes pixels.

Primary targets: camera-only CPU ≤ 1.00 ms p95 at 1,000,000 residents / 50,000 visible; WebGPU `viewport-drag` and `viewport-zoom` at or below the Wave 1 CPU-grid numbers; WebGL 2 unchanged within variance.

Verify: `bun run test:browser -- glyph-rendering` and both-adapter site/browser suites. Capability diagnostics must report `compute-cull` vs `cpu-grid`.

### Wave 4 — Glyph generation and residency

The packer is no longer the limiter; generation and upload are.

- TinySDF is in tree behind `rasterizerOptions.tinySdf`. It builds an SDF from the canvas mask so `@zappar/msdf-generator` is not on the first miss. Binary families install through `FontFace`, interned per family so a miss burst does not start N loads. Same-size misses share a microtask batch; EDT stays per unseen physical glyph that has ink. Empty-ink scalars skip generation. Logical sizes that clamp to `distanceFieldMinFontSize` intern one field. Exact HarfBuzz glyph IDs still go through MSDF when the flag is off.
- `rasterizerOptions.prebuilt` is the hybrid page lookup (TMP / Mapbox PBF model). Dynamic TinySDF or MSDF handles the long tail. Default alphabet pages stay out of the core bundle. Optional `pixi-glyphflow/prebuilt` (`uiSdfPrebuilt`) is the side export for a coarse ASCII page.
- `culling.lod` drops labels whose projected font height is below one pixel. Default is off.
- Budget atlas uploads per frame and resume across frames. A 20,000-glyph first miss must not hitch a single commit. First-seen layout runs in the seeing commit for the tight draw view. The 0.25-viewport ring still admits intern hits and same-commit copies of a tight unique string. Ring-only unique misses stay unshaped. Do not drip-feed on-screen labels.
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
