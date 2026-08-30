# Extreme performance program

Status: unstamped research and implementation program dated 2026-08-16.

The current conclusion: Waves 0–3 and the bounded GPU-scene revolution are in the tree. The
current scene contract supports 64 rendered prototypes × 8 canonical paints across 512 bins,
dense 8-byte mover commands with exact 800,016-byte 100,000-mover uploads, indexed 12-byte fallback,
device/pass/encoder epoch recovery, and segmented palette/cull/scene-render timestamps. Schema 7
raw runs plus the schema 4 promotion aggregate place resident repeatability, formal performance,
sustained 600, and overall promotion at GO. Heterogeneous delivery and its independent 16.67 ms
promotion are GO. Collision repeatability is GO on the WebGPU whole-frame gate.
Packaged HarfBuzz worker SIMD is HOLD because the variant regressed 2.51%. The sealed million-live
artifact passes the 64 MiB and 8/24/32/48-byte Wave 2 contract. Historical schema 2 resident
evidence preserves 16-byte mover captures; historical R1a evidence preserves the indexed 12-byte /
1,200,016-byte capture. The 1.1.0 public contract and instanced MSDF/SDF/alpha/color path remain the
published baseline, with core gzip and atlas-pressure frame CI gates deferred.

This record is the research ledger and delivery sequence. Published numbers stay in [`docs/performance.md`](../../docs/performance.md) and [`benchmarks/PERFORMANCE.md`](../../benchmarks/PERFORMANCE.md). The 1.0 specification still owns budgets until a human tightens them.

## Current ceiling

Version 1.1.0 already meets the formal million-label frame and mutation budgets on the reference Apple M1 Pro Chrome fixture. The remaining gap is not “can it hold 60 Hz on the happy path.” It is:

1. Atlas churn is unbounded. `atlas-pressure` records 638.50 ms frame p95 while packing 20,000 unique 16×16 glyphs under a 4 MiB ceiling with 3,616 evictions. The budget gate only checks bytes and eviction activation, so this cliff is currently legal.
2. Dynamic text is at the wall. `dynamic-counters` records 16.40 ms frame p95 and 15.70 ms mutation p95 against a 16.67 ms limit.
3. Camera-only CPU queries use a tri-state spatial route: ordered grid sort through one-quarter density, an ordered reusable bitset through seven-eighths density, and a linear scan for near-full queries. Fragmented high-slot scenes still make the bitset scatter proportional to the highest occupied word.
4. The 8,000,000-glyph “full visibility” frame number in 1.1.0 artifacts is a synthetic `GlyphMesh`. The sealed `million-live` product-path artifact records 0.10 ms p95 and owns the current Wave 2 runtime-store and submission proof.
5. CPU and GPU still store the same fill/scale/effect record. `TextStore` columns and a GPU palette texel or storage slot. `SpatialIndex` keeps a local box and aliases the store origin, so a position storm does not write world min/max. On the WebGPU storage path the GPU table owns live x/y after the first upload; the CPU submits who moved. Fill-only labels use 32 bytes on the GPU. The CPU store now packs the non-position columns; one million reserved slots stay ≤ 48 MiB in unit measurement. The 1.1.0 artifacts still report 72 MiB and 64-byte records.

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
4. **Atlas upload shape — LANDED including admission budget.** Single-channel and four-channel pages
   upload staged glyph rectangles, promoting to a full upload when rects exceed half the page.
   Four-channel RGB is premultiplied on the CPU so a raw sub-rect write matches Pixi's former
   upload-time step. Atlas residency is wired: the coordinator refcounts each label's atlas keys
   and pins/unpins entries, so eviction can no longer reuse rectangles that live instances sample —
   under all-pinned pressure the atlas now reports capacity loudly instead of corrupting silently.
   Off-screen first-seen admission spends `culling.offscreenAdmitBudgetBytes` (default 64 KiB,
   32 bytes per intern-hit ring label). Tight-view labels always finish. Deferred ring hits resume
   on a later ring query, not leftover rAF. Atlas texel uploads for already-instanced glyphs stay
   ungated.
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
15. **Columnar spatial translate — LANDED, then derived origins.** `translateMany` still slides
    owned origins for a standalone index. `TextLayer` aliases `TextStore` x/y, so a position
    storm does not write a second world AABB. Intake calls `rehashCurrent`. Size class stays.
    Only a cell-boundary crossing rebuckets. `writePositions` records one dirty span when the
    slot column is dense. Camera residency refresh keeps rendered movers on that lane. Do not
    rewrite z or visibility. Wave 1's ≤ 8 ms `dynamic-counters` target still needs a reference
    M1 Pro artifact before anyone claims the number.
16. **Admit fill merge — LANDED.** Unique first-seen groups that share a `style.fill`
    identity concatenate slots/xy and call `writeFills` once. Instance columns and
    draw-state inserts stay per (text, style). Distinct fill identities stay separate.
    Do not merge by resolved paint when the fill objects differ. On-screen unique still
    finishes in that commit.
17. **Optional UI SDF side export — LANDED.** `pixi-glyphflow/prebuilt` (`uiSdfPrebuilt`) bakes
    a coarse VGA 8×8 SDF of U+0020–U+007E at 16 px. First call encodes; later calls remap keys.
    `RasterGlyphProvider` retries a miss with `glyphId: 0` when `glyphText` is one Unicode
    scalar so HarfBuzz ids crop that page. Ligatures stay exact-key only. A native 16 px page
    does not rematch onto a 32 px request. Default pages stay
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
20. **Optional charset TinySDF prebake — LANDED.** `charsetSdfPrebuilt` paints a host charset
    at `max(fontSize, distanceFieldMinFontSize)`, skips empty-ink scalars, and remaps keys
    on later calls. `mergePrebuilt` concatenates family pages. No CJK bitmaps ship in the
    core gzip graph. The homepage demo bakes its language samples after `FontFace.load`.
    A bake at one clamp-equivalent logical size crops the others and interns the field.
    Unseen ink still generates.
21. **Atlas texture array — LANDED.** Two `sampler2DArray` / `texture_2d_array` textures hold
    R8 (sdf/alpha) and RGBA8 (msdf/color) pages as layers. Instance metadata low bits are
    the same-format layer. Compact walks no longer split on `floor(page/8)`. Pixi buffer
    uploaders stay 2D; the surface allocates the array and writes `texSubImage3D` /
    `writeTexture` at `z = layer`.
22. **Prebuilt physical rematch — LANDED.** A bake keyed at one logical size that stores
    `rasterScale` crops any first sight whose physical size matches. The crop interns into
    the TinySDF/MSDF field table. A 64px miss still generates.     `uiSdfPrebuilt` at 16 px
    does not serve 32 px. On-screen unique ink still finishes in that commit.
23. **Palette storage buffer — LANDED, then GPU-owned x/y.** WebGPU with vertex storage
    binds the 32-byte fill records as `array<vec4<f32>>`. After the first full upload
    the GPU table owns live x/y. Position storms skip `writePositions` and upload one
    packed move-command buffer; `patch_xy` writes `transforms[slot * 2].xy`. Camera-only
    frames upload nothing. WebGL and devices with `maxStorageBuffersInVertexStage` 0
    keep the texture path. A storage rebuild refreshes CPU origins before a full upload
    so stale texels cannot clobber movers. Hit-test stays on the aliased store columns.
    Compute-cull records still carry world AABB and stay a separate upload. Published
    budgets stay.

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

## GPU Scene v2 and collision formal checkpoint (2026-08-29)

Schema 6 formal artifacts use 1,000,000 resident labels, 10 warmup frames, 120 camera frames,
120 position-mutation frames, and 100,000 packed position mutations per mutation frame. Renderer,
artifact role, and exploratory status resolve to separate artifact identities. WebGL measures the
actual scene with `EXT_disjoint_timer_query_webgl2`; WebGPU injects timestamp writes into Pixi's
actual scene render pass and resolves the query buffer. Both artifacts captured 260 valid GPU
timestamps with zero fallbacks. The cross-renderer browser gate also passed submitted-glyph
readback, pixel/alpha tolerance, and one-pixel bounds tolerance.

| Renderer | Phase | Frame p95 | CPU p95 | Commit p95 | GPU p95 | Upload p95 | Cull p95 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| WebGL | camera | 131.30 ms | 102.30 ms | 102.30 ms | 23.27 ms | 50.20 ms | 30.80 ms |
| WebGL | position mutation | 207.10 ms | 171.70 ms | 171.70 ms | 23.74 ms | 44.20 ms | 37.10 ms |
| WebGPU | camera | 150.40 ms | 125.10 ms | 125.00 ms | 21.56 ms | 48.20 ms | 22.30 ms |
| WebGPU | position mutation | 145.80 ms | 116.70 ms | 116.50 ms | 16.52 ms | 42.20 ms | 18.40 ms |

The 16.67 ms GPU Scene frame budget remains red for all four renderer/phase pairs. Every schema,
sample-count, renderer-path, timestamp-quality, accounting, readback, and admission-budget check
passed. WebGPU inspected at most 2,048 off-screen labels per commit and materialized at most 340.
The 16 MiB active-scatter command cap reduced position-phase upload p95 to 1,600,816 bytes; periodic
surface-apply frames still reached 42.20 ms p95. Preserve this formal workload and budget. The
explicit resident scene keeps a separate workload identity and separate artifacts.

The one-million-label high-overlap collision workload passed its direct CPU/collision budgets on
both renderers with 512 submitted labels, 4,096 submitted glyphs, and a stable selection hash. The
three-run WebGPU active-scatter comparison moved CPU p95 mean from 19.00 to 16.20 ms and upload p95
from 16,810,240 to 65,552 bytes. All three after runs passed the CPU/collision budget; whole-frame
p95 mean remained 18.03 ms. The raw repeatability artifact preserves run range, coefficient of
variation, hash, accounting, WebGL control, and before/after phase data.

The current 2026-08-30 schema 2 aggregate closes the whole-frame gate. Its three WebGPU frame p95
values are 12.2/11.5/11.9 ms, CPU p95 is 8.3/8.5/8.3 ms, and collision p95 is 2.9 ms in every run.
The spatial index routes candidate density through ordered grid sort at or below one quarter, a
reusable ordered bitset above one quarter and below seven eighths, and a linear scan at seven
eighths or above. Exact boundary tests, mid-density hit-test coverage, exceptional-output cleanup,
and randomized brute-force parity protect the route. All six WebGL/WebGPU candidates retain 512
labels, 4,096 glyphs, selection hash `0x611785c5`, and exact accounting. Collision repeatability is
GO.

## Explicit GPU-scene resident checkpoint (2026-08-29)

`culling.residency: "gpu-scene"` is an explicit opt-in with `"viewport"` as the default. The
supported lane requires WebGPU compute, a storage palette, sufficient device limits, collision
disabled, and at most 64 effective-visible rendered prototypes crossed with 8 canonical paints
across 512 typed columns. Labels use fill-only unit transforms, zero anchors/z, alpha 1, normal
blend, and dense monotonic setup slots. Capability and eligibility failures retain viewport
residency with one stable public fallback reason.

The resident scene keeps 32-byte absolute-AABB records and one indexed local-bounds table on the
GPU. A camera commit refreshes only the compute viewport uniform. A sorted, unique, strictly
contiguous active position wave submits one dense 8-byte exact-f32 `x`/`y` command per label plus a
16-byte `baseSlot`/`count` header. Sparse, reordered, duplicate, and holed waves submit indexed
12-byte `slot`/`x`/`y` commands with the same header. The fused palette pass writes transform origins
and record AABBs before compute culling. CPU spatial rebucketing stays in a typed deferred journal
until a CPU query or fallback consumes it.

The current promotion proof uses five independent schema 7 formal runs and one schema 4 aggregate:

Thirteen byte-exact raw evidence sources use deterministic `.json.gz` archives plus a manifest of
logical filenames, uncompressed bytes, archive bytes, and SHA-256. The materializer restores the
original `.json` names before formal reruns while keeping storage mechanics outside the frozen
harness fingerprint.

- [`promotion-repeatability`](../../benchmarks/results/browser-gpu-scene-resident-webgpu-promotion-repeatability-1.2.0.json),
  SHA-256 `7f47a509e2f94e1f3a1c95707526849c7967432395e685c0db48830939d266ea`;
- [`canonical source`](../../benchmarks/results/browser-gpu-scene-resident-webgpu-canonical-source-1.2.0.json),
  SHA-256 `e8149d863b2d75af2e2ac997114597f5ab8ae4a3ca2746cf54c92f7672d69f7c`;
- [`sustained 600`](../../benchmarks/results/browser-gpu-scene-resident-webgpu-fastlane-fused-600-1.2.0.json),
  SHA-256 `61dd5fb7932fcb10868bb9fa3be13b6e4e71201b010da2b783464c8faedaddf5`.

The five formal runs and the sustained run share production-build fingerprint
`1cb31044438ee914eb5525b97c751488641312f4271127e32d08fdb0f0b27ef4`, harness fingerprint
`2c27dffff28bd1029c6c227471cff106f2bcf120ad6f7395c8c5382d8027244e`, and runtime fingerprint
`5179504654b69449d6d2219ef12d1f6f8a12d053c89881702db871c38dd6fec7`. Each invocation has a
distinct UUIDv4 run id, capture time, and evidence digest.

Formal camera p95 across the five runs is 8.2/8.0/7.9/7.9/6.9 ms. Position p95 is
10.8/9.7/9.5/10.0/8.3 ms. The aggregate camera p95/p99/max is 7.9/9.4/10.6 ms and position is
9.8/11.0/12.5 ms, with zero frames above 16.67 ms in both 600-frame sets. Five of five runs pass
every strict formal budget. The independent sustained run records camera 10.5/13.5/21.5 ms with
4/600 overruns and position 8.1/9.9/11.6 ms with zero overruns. Its sustained gate is GO.

All six invocations preserve 50,000 ordered references with hash `0x45cfd045`, pixel hash
`0xa8ad90b4`, and 302,457 non-transparent pixels. Formal timestamp telemetry is
1,300 readbacks / 1,300 fused resolves / 0 standalone submissions; sustained telemetry is
1,220/1,220/0. All 1,300 formal segmented samples resolve palette/cull/scene-render boundaries with
zero fallback and p95 0.13/0.59/5.44 ms. Truth repeatability, output identity, formal
performance, sustained evidence, and overall promotion are GO.

The current mover ABI has a dense 8-byte exact-f32 lane and an indexed 12-byte fallback. Dense
10,000- and 100,000-mover product frames upload exactly 80,016 and 800,016 bytes including the
16-byte command header. The current Task 12.39 artifacts use this dense lane. Historical schema 2
resident evidence preserves 16-byte mover totals; historical R1a evidence preserves its indexed
12-byte / 1,200,016-byte capture.

## R1a heterogeneous GPU-scene delivery checkpoint (2026-08-30)

R1a retains the GPU Scene v2 2-unit grid, pixi-viewport camera sequence, 1280×800 surface, and
roughly 259,605-label final selection. This gives the delivery gate the same full-screen pressure as
the fixed WebGPU v2 camera/position baseline of 199.5/199.9 ms. The resident scene contains
1,000,000 labels, 100,000 movers, 64 actual single-glyph geometry/raster prototypes, and 8 canonical
fill paints. Prototype and paint sequences interleave independently and cover all 512 pairs. The
supported lane fixes z 0, unit transforms, zero anchors, alpha 1, normal blend, and collision
disabled.

The formal `gpu-scene-heterogeneous-64` artifact carries two repetitions. Each repetition launches
a fresh Chrome process, performs 10 warmups plus 120 camera and 120 position samples, and records
live `residencyActive`, prototype, paint, and per-label-object stats. Camera upload is zero. The
current formal and candidate artifacts use the dense 8-byte lane and record exactly 800,016 bytes.
Frozen legacy R1a artifacts preserve the indexed 12-byte / 1,200,016-byte capture. Cull-record
upload remains zero. Every sampled frame records product/fused/standalone
submissions of 1/1/0 and complete palette/cull/scene-render timestamp segments.

Count/hash truth comes from an independent CPU selection over all one million slots, the actual 64
prototype bounds, and each phase's final binding viewport after timed sampling. The compact GPU
count/hash must match that result. Each repetition reads pixels twice, and both repetitions must
share exact count, hash, pixel hash, and non-transparent-pixel count. The 10K browser correctness
gate adds same-content resident-product and general-reference shader pixel parity.

The delivery gate requires camera and position frame p95 at or below 33.34 ms plus at least 4×
speedup over the fixed v2 baseline. Camera CPU/commit limits are 4/2 ms; position CPU/commit limits
are 8/4 ms; surface apply is 2 ms; GPU timestamp is 30 ms; setup is 2,000 ms; heap is 512 MiB.
Per-label GPU-scene objects and post-setup shaped/admitted/query deltas stay zero. The 16.67 ms
target retains its own promotion status. The existing strict one-prototype resident gate continues
with its current limits.

The two sealed 2026-08-30 artifacts establish **delivery GO** and **promotion GO**. Their four
fresh-process repetitions record camera p95 values of 10.3, 10.1, 9.6, and 9.8 ms and position
p95 values of 11.0, 11.0, 11.3, and 11.4 ms. The corresponding fixed-baseline speedups stay above
19.3× for camera and 17.5× for position.
All component, setup, heap, residency, upload, transaction, timestamp, and post-setup gates pass.

Every repetition produces camera identity `343,635 / 0x33d2c553`, position identity
`259,609 / 0x9dbf0bd5`, pixel hash `0x8c5162ca`, and 1,011,427 non-transparent pixels. The promotion
miss counts are 0/0 camera/position frames across all four repetitions.

Run the two evidence captures serially after GPU activity is quiet:

```sh
bun run benchmark:workload -- --workload gpu-scene-heterogeneous-64 --renderer webgpu --output benchmarks/results/browser-gpu-scene-heterogeneous-64-webgpu-formal-1-1.2.0.json
bun run benchmark -- --workload gpu-scene-heterogeneous-64 --renderer webgpu
```

The canonical report consumes
`benchmarks/results/browser-gpu-scene-heterogeneous-64-webgpu-candidate-1.2.0.json`; the first path
retains the independent fresh-run artifact.

The canonical file/evidence SHA-256 values are
`372c87ad4530c0d941eaa01bce18d7da62d4845ec56f58e88f3bc311bc6ec0b8` and
`9e2ef3d378b72b0436d0c1a78fd836de1a7c983690749d3683807f49e1b345da`. The independent file/evidence
values are `46175af513d4d8ca0ec49f70f6b76dc16891063c86ac803c3118a3446d2ad49f` and
`99bf160f1c9c422423290ed3b9279df8561a900ee228e5b774e5e74e21ffb883`. Both captures share build
fingerprint `1cb31044438ee914eb5525b97c751488641312f4271127e32d08fdb0f0b27ef4` and harness fingerprint
`2c27dffff28bd1029c6c227471cff106f2bcf120ad6f7395c8c5382d8027244e`.

Resident compact-output capacity follows the maximum submitted glyph count. The first allocation
used the single shared-prototype count and reserved one eight-byte reference for a 50,000-reference
scatter. Schema 2 retains the first five attempts as pre-fix invalidated history. Three of those
attempts passed the timing budgets:

| Run | Setup | Camera frame/GPU p95 | Position frame/GPU p95 |
| --- | ---: | ---: | ---: |
| Former candidate | 769.6 ms | 2.2 / 0.262144 ms | 9.8 / 0.393216 ms |
| Former repeat 2 | 762.0 ms | 3.5 / 0.393216 ms | 10.3 / 0.393216 ms |
| Former repeat 3 | 762.4 ms | 1.6 / 0.196608 ms | 10.9 / 0.393216 ms |

Five isolated post-capacity, pre-fusion 1M-label / 100K-mover attempts exercised the complete
output:

| Attempt | Setup | Camera frame/GPU p95 | Position frame/GPU p95 |
| ---: | ---: | ---: | ---: |
| 6 | 789.1 ms | 9.8 / 8.323072 ms | 18.5 / 9.371648 ms |
| 7 | 777.2 ms | 11.1 / 8.323072 ms | 18.8 / 9.699328 ms |
| 8 | 800.7 ms | 10.1 / 8.323072 ms | 19.5 / 10.092544 ms |
| 9 | 791.4 ms | 11.6 / 8.323072 ms | 20.0 / 10.289152 ms |
| 10 | 802.1 ms | 11.9 / 8.323072 ms | 19.9 / 10.223616 ms |

Every post-fix run read exactly 50,000 ordered references with hash `0x45cfd045` directly from
`gpu-instances-out`, then produced matching paired pixel hash `0xa8ad90b4` and 302,457
non-transparent pixels. Each run retained one prototype, 260 valid timestamps, zero camera
uploads, 1,600,016 position-transform bytes, zero cull-record upload bytes, and zero
shaped/admitted/query deltas. The
[`schema 2 snapshot`](../../benchmarks/results/browser-gpu-scene-resident-webgpu-repeatability-1.2.0.json)
has frozen SHA-256 `b74ff555d22fa8b7f39fe0203c81293e3e55a633283a7f5322b3c16c8d9c8aa0`. It records the embedded
attempt 10 source digest
`d4914d86952b310de210cb517d3a2f12073494c86dc38eb609af1095a61de2eb`. Schema 3 promotion evidence
owns the formal canonical candidate, repeatability, and sustained status.

Single-submit fusion stages palette, cull, and Pixi render work in one product command buffer. The
historical `submit-fusion-600` artifact is a digest-only standalone-timestamp baseline with
SHA-256 `24239c2fdf6431dbb91f6f8b8f2fdc1ca99e585d9bfdd93c78bbe72a212da245`.
It records 1,220 total / 1,220 fused / 0 standalone transactions, one fused submission per sampled
camera and position frame, and two phase-end identity readbacks. Its timer also issues 1,220
separate timestamp diagnostic submissions, so the zero-standalone value describes product
transaction telemetry. Camera frame p95/p99/max is 11.8/13.0/14.3 ms with 0 / 600 frames above
16.67 ms. Position frame
p95/p99/max is 17.7/19.2/21.7 ms with 598 / 600 (99.67%) above budget. Actual output remains 50,000
ordered references with hash `0x45cfd045`, paired pixel hash `0xa8ad90b4`, and 302,457
non-transparent pixels. GPU output identity is GO. Throughput and release-tail promotion are PAUSE
for this historical checkpoint. The current schema 7/schema 4 proof above provides fused timestamp
truth and the active promotion decision.

The resident fill hot path preserves the general shader's byte-exact `over(fill, zero)` rounding.
`tests/browser/gpu-scene-reference.pw.ts` runs the formal 1M-label / 100K-mover / 1280×800 /
120-frame fixture through the product single-prototype shader, forced resident multi-prototype
shader, and forced general shader. All three must match the canonical 50,000-entry GPU identity,
pixel hash `0xa8ad90b4`, and 302,457 non-transparent pixels. The fragment keeps the general
composition's instruction shape with a dynamic-zero parity term, and `tests/GlyphMesh.test.ts`
pins that WGSL expression.

The current `gpu-scene-v2` control remains RED across all four WebGL/WebGPU camera/position frame
gates. It preserves the general viewport-residency workload and establishes the CPU preparation and
surface costs that the uniform resident contract removes.

## Structural diagnosis

These are code facts, not profiler folklore. Each item names the structure that has to change.

### Atlas pack and evict were quadratic under pressure

`Packer` is now Skyline Bottom-Left plus a waste map and a next-fit shelf for the current equal-height row; rectangle keys are packed integers when the page is under 8192. `GlyphAtlas` evicts through a per-mode doubly-linked LRU. The 1.1.0 `atlas-pressure` artifact still measures the old guillotine and linear clock scan.

That is why `atlas-pressure` spends seconds in setup and hundreds of milliseconds per batch. Jylänki’s survey treats guillotine as the simple/fast teaching algorithm, not the online font-atlas algorithm. Production font atlases use Skyline for online inserts (`stb_rect_pack`, FontStash, NanoVG) and MaxRects for offline prebakes.

### Instance writes were scalar DataView traffic

`GlyphInstanceStore` now writes through `Float32Array` / `Uint16Array` / `Uint32Array` views. Content commits skip `#matches`. The coordinator reuses scratch batches. The free list is a power-of-two segregated first-fit with adjacent merge. Live atlas keys are packed integers; string keys remain for tests, prebuilt pages, and identities that cannot pack.

This is the likely core of `dynamic-counters` sitting at 16.40 ms. Live instances now use a 24-byte stride (four `f16` local-rect components). Bind the rect as `uint32x2` and unpack with `unpackHalf2x16` / `unpack2x16float`; CI Chrome/ANGLE drew 0 pixels with a `float16x4` vertex format. The published 32-byte ceiling stays until new artifacts exist.

### Transforms are parsed and stored three times

`TransformPalette.set` writes a 32-byte fill-only core (xy, scale, packed half2 rotation, packed half2 anchors, packed RGB, packed alphas plus an effect flag). Stroke and drop shadow occupy one extra texel after `capacity * 2`, allocated only when any label first uses those effects. Numeric fills skip PixiJS `Color`. The texture path still calls `writePositions` so a position storm dirties 16 bytes per label, or one span when the slot column is dense. The WebGPU storage path leaves those CPU texels stale and patches GPU `transforms[slot].xy` from packed move commands. `TextStore` keeps `x`/`y`/`zIndex` as `Float32` and packs scale, rotation, alpha, and anchors as binary16 so they match the GPU palette quanta. Occupied, visible, and the position-only kind share one flag byte. Generation is `u16`; source revision is `u32`. The dirty journal still has a per-slot mask but grows the dirty-slot list with the pending wave and releases it on publish. `SpatialIndex` stores a local box and aliases the store origin columns on `TextLayer`; world min/max are derived.

Historical 1.1.0 browser artifacts retain the 128 MiB store and 64-byte transform ceilings. The
current `million-live` gate enforces a 64 MiB complete live runtime store, a 32-byte fill core, and
a 48-byte effectful maximum through its sealed M1 Pro artifact.

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
| Chlumsky, *Shape Decomposition for Multi-channel Distance Fields* (2015); [msdfgen](https://github.com/Chlumsky/msdfgen) | RGB distance channels preserve corners; the generator also exposes SDF, PSDF, and MTSDF | Keep MSDF for scalable UI and zoom and use its quality model in the tier router | Runtime generation and prebuilt pages retain separate measured lanes |
| Esfahbod, [glyphy](https://github.com/behdad/glyphy) | Arc-approximated SDF, no large bitmap atlas | Optional huge-glyph / extreme-zoom quality | Per-fragment cost too high for 8M tiny labels |
| Lengyel, *GPU-Centered Font Rendering Directly from Glyph Outlines*, [JCGT 6(2)](https://jcgt.org/published/0006/02/02/) (2017); shaders now [public-domain / MIT](https://github.com/EricLengyel/Slug) | Analytic coverage from quadratic Béziers in the fragment shader | Optional `glyphMode: "outline"` for huge zoom and 3D-ish projection | Default path: divergent fragments, no cheap minification, CJK/color fonts still need atlases |
| Loop and Blinn, *Resolution Independent Curve Rendering*, SIGGRAPH 2005 | Implicit curve tests on GPU | Historical baseline for Slug | Precision artifacts Lengyel later fixed |
| Mapbox TinySDF + PBF glyph ranges; [native text wiki](https://github.com/mapbox/mapbox-gl-native/wiki/Text-Rendering) | 24 px SDF, local CJK via canvas, protobuf range cache, IndexedDB | Fast local SDF, prebaked Latin/CJK ranges, halo from distance | Server glyph protocol as a required dependency |
| Unity TextMeshPro | Static SDF atlas + dynamic fallback atlas | Hybrid prebake + runtime populate | Object-per-label CPU model |
| [PixiJS `BitmapText`](https://pixijs.com/8.x/guides/components/scene-objects/text/bitmap) | Pre-generated shared bitmap/SDF/MSDF atlas for high-volume dynamic text | Keep the upstream compatibility baseline and shared-atlas economics | Dynamic Unicode and heterogeneous paint continue through measured glyphflow lanes |
| [troika-three-text `BatchedText`](https://github.com/protectwise/troika/blob/main/packages/troika-three-text/README.md) | Worker-built on-demand SDF atlas, material patching, and batched Three.js text | Reuse worker generation, shared atlas, and batched metadata ideas | The local renderer keeps its Pixi host and numeric scene contract |

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
| [Mapbox cross-tile collision](https://github.com/mapbox/mapbox-gl-native/wiki/Collision-Detection) and [MapLibre retained placement](https://github.com/maplibre/maplibre-gl-js/blob/main/src/symbol/placement.ts) | Stable cross-tile symbol identity, previous-placement opacity, collision fades, and variable-anchor continuity | Retain symbol identity and anchor history across camera, zoom, tile, and scene revisions | Application sources keep ownership of geographic identity and priority policy |
| [CesiumJS `LabelCollection`](https://cesium.com/learn/cesiumjs/ref-doc/LabelCollection.html) and [deck.gl `TextLayer`](https://deck.gl/docs/api-reference/layers/text-layer) | A few large collections, static/dynamic partitioning, and data-driven label layers | Bin shared prototypes and paint into a bounded set of large resident batches | Rich per-label properties enter through explicit capability bins |

### Shaping, layout, and engines we will not become

| Source | What it is | Steal | Reject as default |
| --- | --- | --- | --- |
| HarfBuzz; [harfbuzzjs](https://github.com/harfbuzz/harfbuzzjs); Behdad SIMD notes | Production shaper, digest filters, optional SIMD | Keep worker HarfBuzz; intern shape plans; transferable caches | Replacing it with rustybuzz (1.5–2× slower) |
| cosmic-text / Parley | Shape-plan and run caches | Cache key shape already specified; make it numeric and shared | In-process editor semantics |
| [glyphon 0.12](https://docs.rs/crate/glyphon/latest) / cosmic-text 0.19 and [wgpu_glyph](https://github.com/hecrj/wgpu_glyph) | Current wgpu atlas middleware plus its glyph-brush predecessor; glyphon renders into an existing pass | Keep the existing-pass integration pattern, atlas ownership boundary, and shaped-run cache model | Rust/wgpu integration remains a portable lineage reference |
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
- Stop mirroring x/y into spatial storage as a second write; derive query bounds from position plus cached local width/height. LANDED: `TextLayer` aliases store x/y; the index stores the local box.
- Quantize instance local rectangles to f16 or 16-bit fixed point relative to the label origin. UVs are already `uint16`. Current unique prototype records use 24 bytes; visible draw references use 8 bytes. Historical synthetic artifacts retain the 32-byte instance ceiling.
- Intern `style` and `text` references in `TextStore` so 100,000 counters that share a format do not hold 100,000 style objects.
- Upload only dirty palette texels and dirty instance ranges. Position storms should not rewrite fill/effect texels.

Primary targets: the constructor base store stays within 48 MiB plus 256 B for 1,000,000 reserved
slots; the complete `million-live` runtime store stays within 64 MiB; fill-only transforms use a
32-byte core and effects add one 16-byte sparse record; unique prototype glyphs use 24-byte
records; visible draw references use 8 bytes; `position-storm` frame p95 stays ≤ 4 ms.

Verify: the constructor base-store assertion stays in `tests/TextStore.test.ts`. The current
`million-live` schema 7 artifact carries 10 warmup plus 120 sampled product frames and feeds the
hard checks in `benchmarks/budgets.ts`.

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
- Combining atlas pages into a texture array landed (two format arrays). The transform
  palette is a WebGPU storage buffer when the vertex stage can bind it. WebGL keeps the
  texture. Do not build a second feature-complete stack.
- Optional LOD: `culling.lod` drops labels whose projected font height is below one pixel. Default off, because it changes pixels.

Primary targets: camera-only CPU ≤ 1.00 ms p95 at 1,000,000 residents / 50,000 visible; WebGPU `viewport-drag` and `viewport-zoom` at or below the Wave 1 CPU-grid numbers; WebGL 2 unchanged within variance.

Verify: `bun run test:browser -- glyph-rendering` and both-adapter site/browser suites. Capability diagnostics must report `compute-cull` vs `cpu-grid`.

### Wave 4 — Glyph generation and residency

The packer is no longer the limiter; generation and upload are.

- TinySDF is in tree behind `rasterizerOptions.tinySdf`. It builds an SDF from the canvas mask so `@zappar/msdf-generator` is not on the first miss. Binary families install through `FontFace`, interned per family so a miss burst does not start N loads. Same-size misses share a microtask batch; EDT stays per unseen physical glyph that has ink. Empty-ink scalars skip generation. Logical sizes that clamp to `distanceFieldMinFontSize` intern one field. Exact HarfBuzz glyph IDs still go through MSDF when the flag is off.
- `rasterizerOptions.prebuilt` is the hybrid page lookup (TMP / Mapbox PBF model). Dynamic TinySDF or MSDF handles the long tail. Default alphabet pages stay out of the core bundle. Optional `pixi-glyphflow/prebuilt` (`uiSdfPrebuilt`) is the side export for a coarse ASCII page.
- `culling.lod` drops labels whose projected font height is below one pixel. Default is off.
- Budget atlas uploads per frame and resume across frames. A 20,000-glyph first miss must not hitch a single commit. First-seen layout runs in the seeing commit for the tight draw view. The 0.25-viewport ring may admit intern hits and same-commit copies of a tight unique string up to `offscreenAdmitBudgetBytes`. Ring-only unique misses stay unshaped. Do not drip-feed on-screen labels. Do not gate texel uploads for already-instanced glyphs.
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

#### Current decision matrix — 2026-08-29

| Track | Decision | Scope and remaining gate |
| --- | --- | --- |
| HarfBuzz GPU | GO packed / PAUSE direct | Packaged Worker/Wasm runtime and packed browser storage pass; direct `vec4<i32>` waits for its independent quality/performance gate at 114.8 MiB |
| Outline | GO | Explicit `glyphMode: "outline"` WebGPU compute/fragment integration and lifecycle gates pass; automatic atlas rendering remains the default |
| SharedArrayBuffer | GO | Advanced opt-in transport requires `SharedArrayBuffer`, `Atomics`, and cross-origin isolation; leased run views, browser worker protocol, and matching hashes pass |
| SIMD shaping | HOLD | Packaged HarfBuzz 11.2.1 scalar/SIMD Workers match exactly across CJKV, Arabic, Devanagari, Hebrew, and Thai; five isolated production-path samples show a 2.51% `variant-regression`, and package inclusion requires human approval |
| Collision | GO | Six sealed runs preserve selection identity; the WebGPU whole-frame p95 mean is 11.87 ms |

Task 12.8 remains open for a production SIMD asset and each remaining default-promotion workload.
The completed GO scopes retain explicit opt-in boundaries.

#### 2026-08-29 market refresh and next evolution

This is a representative mainstream/frontier project lineage for the next renderer revisions.
Each route keeps its own formal workload, capability boundary, output identity, and promotion gate.

Version snapshot: Mapbox GL JS main manifest 3.29.0; MapLibre GL JS main manifest 6.6.0; deck.gl
9.4 alpha; Troika 0.53.0; HarfBuzz GPU Draw 14.4.0; Vello 0.10.0 / Sparse Strips 0.2.0 / Glifo
0.3.0; glyphon 0.12 / cosmic-text 0.19; PixiJS upstream 8.20.1; this repository's PixiJS pin
8.19.0; `@pmndrs/glyph` manifest 0.0.0 during incubation.

| Route | Evolution | Representative lineage | Local next gate |
| --- | --- | --- | --- |
| R1 | Heterogeneous GPU Scene | [CesiumJS `LabelCollection`](https://cesium.com/learn/cesiumjs/ref-doc/LabelCollection.html), [deck.gl `TextLayer`](https://deck.gl/docs/api-reference/layers/text-layer), and [PixiJS `BitmapText`](https://pixijs.com/8.x/guides/components/scene-objects/text/bitmap) converge on a few large collections and shared glyph resources | Admit 64–256 prototype/paint bins into one revision while keeping a small number of large indirect batches under the current [WebGPU capability contract](https://github.com/gpuweb/gpuweb/issues/5175) |
| R2 | Revisioned Scene WAL | [`@pmndrs/glyph`](https://github.com/pmndrs/glyph) publishes retained revisioned render plans with resource lifetimes and minimal patches | Extend the frame transaction into an acknowledged write-ahead log with scene revision, checkpoint recovery, and deterministic retirement |
| R3 | Skia-tier Router | [Skia `SubRunContainer`](https://skia.googlesource.com/skia/+/main/src/text/gpu/SubRunContainer.h), [HarfBuzz GPU Draw](https://harfbuzz.github.io/harfbuzz-hb-gpu.html), [Slug](https://github.com/EricLengyel/Slug), [msdfgen](https://github.com/Chlumsky/msdfgen), [Troika](https://protectwise.github.io/troika/troika-three-text/), and [glyphon](https://docs.rs/crate/glyphon/latest) cover mask, SDF/MSDF, analytic outline, worker generation, and existing-pass wgpu text | Select mask, SDF/MSDF, analytic outline, compute outline, or color per projected size, transform, paint, font, and device capability |
| R4 | Map Symbol Continuity | [Mapbox cross-tile identity](https://github.com/mapbox/mapbox-gl-native/wiki/Collision-Detection) and [MapLibre retained placement](https://github.com/maplibre/maplibre-gl-js/blob/main/src/symbol/placement.ts) preserve label identity, opacity, anchors, and collision state across camera and zoom revisions | Add stable symbol ids, retained anchor choice, priority, and fade state to the scene WAL with deterministic camera/zoom fixtures |
| R5 | Sparse Glyph Strip Cache | [Vello issue #670](https://github.com/linebender/vello/issues/670) and the Vello 0.10 / Sparse Strips 0.2 / Glifo 0.3 family explore retained rendered paths and cached glyph work | Cache sparse strips for repeated huge paths and compare memory, zoom continuity, pixels, and sustained frame tails |

Execution priority is R1 Heterogeneous GPU Scene, then R2 Revisioned Scene WAL, then R3
Skia-tier Router. R4 and R5 retain independent continuity and sparse-path laboratories with their
own output and sustained-frame gates.

#### R4 map-symbol continuity checkpoint — 2026-08-30

R4 now has an advanced opt-in `SymbolContinuityIndex` with explicit logical and candidate identity,
multi-candidate tile overlap, retained-anchor preference, f32 priority, insertion order, separated
source/placement epochs, fade/readmit/TTL state, staged frame rollback, pure committed reads, u32 id
exhaustion, a 1,048,576-record hard ceiling, and a bit-level complete state hash. The targeted suite
covers collision losers, priority and retained winners, provisional-id isolation, reclaimed
tombstones, capacity recovery, signed and typed identity, and abort retry identity.

`bun run benchmark:symbol-continuity` reserves 100,000 records, warms five frames, and samples 20
full overlap/collision frames in both hash modes. Repeated local verification measured manual-mode
frame p95 at 9.85–11.57 ms, every-frame mode p95 at 14.46–16.17 ms, and the manual checkpoint hash
at 13.72–15.27 ms outside the sampled frame. Both modes retain an estimated 15,500,000 bytes. The
final committed hash is `1269277151`, the every-frame sampled hash is `485162081`, and all expected
counters match.

R4 correctness and the 100k dual-mode index microbenchmark are GO. TextLayer product integration is
HOLD through the R2 Scene WAL/delta source, browser workload, and sustained-frame gate.

#### R5 sparse-strip implementation checkpoint — 2026-08-30

R5 now has a versioned 4x4-tile CPU IR, a two-pass typed encoder, a byte-bounded defensive LRU,
power-of-two physical pixel buckets, grayscale/binary AA identity, and an independent WebGPU
rehydration adapter. The adapter writes a batched premultiplied `rgba8unorm` texture through the
existing `OutlineColorAtlas` seam and classifies capability, storage, shader, queue, destruction,
and cleanup outcomes. All u32 metadata and allocation products pass checked preflight; packing owns
its snapshot before pipeline compilation. Sweep-line placement validation stays near O(N log N),
and exact-workgroup-size dispatch groups keep mixed 256/512 padded invocations within 1.15× of
effective pixels in the browser gate.

`bun run benchmark:sparse-strips` uses the pinned HarfBuzz Arabic glyph 4. The 512-pixel sample
allocates 11,360 bytes plus 2,451 bytes of encoding scratch against 38,550 dense alpha bytes; final
and peak ratios are 29.47% and 35.83%. The 1024-pixel sample allocates 22,688 bytes plus 9,509 bytes
of scratch against 150,822 dense bytes; final and peak ratios are 15.04% and 21.35%. Warm CPU
rehydration p95 is 1.78 ms at 512 and 6.54 ms at 1024 in the recorded local run. Coverage and RGBA
hashes remain stable across repeated decoding.

The real Chrome WebGPU fixture rehydrates 256- and 512-pixel buckets, matches the CPU reference with
maximum channel delta one, zero mismatched channels, and a stable repeated texture hash. CPU
IR/cache correctness and single-batch GPU pixels are GO. Product routing is HOLD through the
five-run atlas-pressure, stable-atlas-hit, 600-frame tail, live-plus-retired memory, and package
promotion gates.

#### HbGpuDrawSpike checkpoint — 2026-08-29

`bun run benchmark:hb-gpu` compiles a native helper into a system temporary directory with argv-form
`pkg-config` and `clang` calls. The helper shapes the five deterministic Noto subset corpora, then
passes every unique glyph through `hb_gpu_draw_glyph_or_fail` and `hb_gpu_draw_encode`. The raw
artifact is [`benchmarks/hb-gpu/results/hb-gpu-draw-native-14.4.0.json`](../../benchmarks/hb-gpu/results/hb-gpu-draw-native-14.4.0.json).

The measured Apple M1 Pro run shaped 151 glyphs / 114 font-local unique glyphs with zero draw
failures, zero encode failures, zero intra-run blob mismatches, and matching SHA-256 hashes across
sequential repeats. Warm encode throughput was 377,560 glyphs/s; per-glyph encode was 2.125 µs p50,
6.882 µs p95, and 10.015 µs p99. The installed WGSL sources total 15,469 bytes. Native timing covers
CPU shaping and outline blob encode. The packed browser spike owns WGSL compilation, upload cost,
fragment coverage cost, fill-rate, ordering, blending, and pixel acceptance.

HarfBuzz 14.4.0 documents each blob as 8-byte `RGBA16I` texels in
[`hb-gpu-draw.cc`](https://github.com/harfbuzz/harfbuzz/blob/14.4.0/src/hb-gpu-draw.cc), while its
WGSL draw helper consumes `array<vec4<i32>>` in
[`hb-gpu-draw-fragment.wgsl`](https://github.com/harfbuzz/harfbuzz/blob/14.4.0/src/hb-gpu-draw-fragment.wgsl).
Direct storage-buffer upload therefore sign-extends each 8-byte texel into 16 bytes. The corpus
occupies 327,232 packed bytes and 654,464 sign-extended bytes. At the `atlas-pressure` 20,000-unique
projection, packed 16-bit storage is 57,409,123 bytes and fits the 64 MiB ceiling; direct
`vec4<i32>` storage is 114,818,246 bytes and triggers the pause gate. The aggregate sign-extended
p95 is 12,896 bytes per glyph, inside the 16 KiB pathology gate.

The 10,000 glyphs/s native floor represents about 166 cold glyph encodes in one 16.67 ms frame.
The primary storage gate divides 64 MiB across the `atlas-pressure` 20,000-unique workload, yielding
3,355 bytes per glyph on average. The 16 KiB p95 gate serves as a single-glyph pathology detector;
cache capacity follows the mean-byte projection.

The packed browser artifact is GO for both `array<vec2<u32>>` signed-16 unpack and available
`rgba16sint` texture loads. They produce matching repeated pixel/mask hashes across five script
samples and project to 57,409,123 bytes at 20,000 unique glyphs. The packaged Worker/Wasm encoder is
also GO: it matches native blob hashes, reaches 19,607 warm glyphs/s, keeps cold start below 100 ms,
and releases all synchronized font resources. Its raw artifacts are
[`hb-gpu-draw-browser-14.4.0.json`](../../benchmarks/hb-gpu/results/hb-gpu-draw-browser-14.4.0.json)
and
[`hb-gpu-draw-wasm-browser-14.4.0.json`](../../benchmarks/hb-gpu/results/hb-gpu-draw-wasm-browser-14.4.0.json).

Direct `vec4<i32>` production storage stays PAUSE at 114,818,246 projected bytes. The existing
SDF/MSDF/color atlas renderer remains the shipping WebGL/WebGPU default. HarfBuzz lists
`libharfbuzz-gpu` among its experimental libraries, so the lab pins both `harfbuzz-gpu` and
`harfbuzz` to 14.4.0. Version drift pauses artifact creation; the current atlas renderer supplies
the compatibility fallback. Reproduction uses `bun run benchmark:hb-gpu`,
`bun run benchmark:hb-gpu-browser`, and `bun run benchmark:hb-gpu-wasm`. The installed `hb-gpu.h`
carries the HarfBuzz permissive license; the five fixture fonts retain SIL OFL 1.1 provenance in
`site/public/fonts/README.md` and remain outside the npm package file set.

Each track needs its own workload and a documented pixel tolerance. None of them may raise the core gzip size.

## Budget status

Task 12.5 now has executable current Wave 2 semantics. Promotion stays open through the formal M1
Pro artifact capture and passing gate. The remaining rows retain proposal status.

| Budget | 1.1.0 historical rule | Current rule or proposal |
| --- | --- | --- |
| atlas-pressure frame p95 | unchecked | 16.67 ms after Wave 1 |
| dynamic-counters frame p95 | 16.67 ms | 8.00 ms after Wave 1 |
| camera-only CPU at 1M / 50k | folded into frame | 1.00 ms after Wave 3 on WebGPU |
| live-layer 8M glyphs | synthetic `million-full` | `million-live` product frame p95 ≤ 16.67 ms |
| CPU store / 1M | 128 MiB (72 used) | live runtime ≤ 64 MiB; constructor base ≤ 48 MiB + 256 B |
| transform record | 64 B | 32 B fill core; 48 B effectful maximum |
| glyph storage | 32 B synthetic instance | 24 B prototype record; 8 B draw reference |
| core ESM gzip | 40 KiB CI fail deferred | measured graph with deferred fail threshold |

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
