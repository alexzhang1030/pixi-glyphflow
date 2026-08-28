# Changelog

## Unreleased

### Changed

- The homepage live demo frames a readable multilingual specimen band, paints that first camera
  view before the rest of the million-label allocate, and reports `stats.palettePath` next to
  the cull path. Extra engine numbers sit behind a disclosure. WebGL stays on the texture
  palette. Published benchmark numbers are unchanged.

### Added

- `TextLayerCullingOptions.offscreenAdmitBudgetBytes` caps compute-cull first-seen admission
  for labels that sit only in the 0.25-viewport prepare ring. Each intern-hit ring label charges
  32 bytes. Tight-view labels always finish. Default is 65536. `0` admits the tight view only.
- Optional `pixi-glyphflow/prebuilt` `charsetSdfPrebuilt` / `mergePrebuilt` / `uniqueInkCharset`:
  host-painted TinySDF pages for a charset (CJK included). First bake encodes; later calls
  remap keys. No CJK bitmaps ship in the package. The homepage demo bakes its language
  samples after `FontFace.load`.
- Optional `pixi-glyphflow/prebuilt` export: `uiSdfPrebuilt` serves a coarse VGA 8×8 SDF of
  printable ASCII (U+0020–U+007E) as `rasterizerOptions.prebuilt` pages. The first call encodes;
  later calls remap keys. Size is 16 px only. The pages are not in the core ESM graph.

### Performance

- WebGL dirty uploads of the `rgba32float` transform table write complete texture rows at
  `x = 0`. A mid-row 39-texel `texSubImage2D` from a banded position storm blanked the first
  view on ANGLE / SwiftShader after the initial full `texImage2D`. `packedFloatTexelView` still
  copies a non-zero `byteOffset`. WebGPU keeps the tight rectangles.
- WebGPU owns the 32-byte transform table in a storage buffer when the vertex stage can bind
  it. Position-only storms skip the CPU 32-byte scatter and submit the mover slot list. A
  compute pass writes x/y from the store columns. Camera-only frames do not gather the full
  palette. WebGL and devices with `maxStorageBuffersInVertexStage` 0 keep the texture path.
  `requestComputeCullGpu()` requests that vertex-storage limit. `TextLayerStats.palettePath`
  reports `"storage"` or `"texture"`. Published budgets stay. Hit-test still uses the aliased
  store columns.
- Prebuilt distance-field pages rematch by physical size. A `charsetSdfPrebuilt` bake at 14px
  crops a 13px or 32px first sight of the same glyph and interns the field, instead of starting
  TinySDF or MSDF. Sizes above `distanceFieldMinFontSize` still generate. On-screen unique ink
  still finishes in that commit.
- Position-only storms write store x/y once. `SpatialIndex` aliases those columns as the origin
  and keeps a local box, so it does not store a second world min/max. Intake only rebuckets on a
  cell-boundary crossing. `writePositions` records one dirty span when the slot column is dense.
  A camera residency refresh keeps rendered movers on that lane instead of per-label snapshots.
- Compute-cull first-seen admission now spends `offscreenAdmitBudgetBytes` on ring intern hits
  and same-commit ring copies. Tight-view unique raster still finishes in that commit. Deferred
  ring hits resume on a later ring query, not a leftover rAF. Atlas texel uploads for already-
  instanced glyphs stay ungated.
- Atlas pages bind as layers in two texture arrays (R8 sdf/alpha, RGBA8 msdf/color). Shaders
  sample `uAtlasR` / `uAtlasRGBA` by mode and layer. Compact walks split only on blend and z.
  `GLYPH_TEXTURE_BANK_SIZE` is now `2`. Array sources skip Pixi's 2D buffer uploader. WebGPU
  glyph rects pad `bytesPerRow` to 256.
- Empty-ink scalars (White_Space except Ogham U+1680, plus default ignorables) skip raster
  and instance quads. Layout advance and label AABBs stay. Trusted runs, ligatures, and
  shared-cluster marks still generate. An empty TinySDF mask skips both EDTs.
- TinySDF and MSDF intern one physical field at `distanceFieldMinFontSize`. Logical sizes
  that clamp to that size share pixels and keep their own `rasterScale`. TinySDF also shares
  across HarfBuzz ids for the same `glyphText`. Sizes above the minimum still generate.
- Prebuilt lookup retries `glyphId: 0` when `glyphText` is a single Unicode scalar, so a
  HarfBuzz-shaped ASCII miss can still crop a family page instead of starting TinySDF or MSDF.
  Ligatures stay on the exact key.

- Unique admit groups that share a `style.fill` identity write one `writeFills` column.
  Instance ranges and draw-state inserts stay per string.
- Position storms slide spatial AABBs through `translateMany`. Size is unchanged, so the
  hash-grid size class stays and only a cell-boundary crossing rebuckets. `updatePositions`
  and same-text `updateTextPositions` no longer call `translate` per label.
- Same-size TinySDF misses share one FontFace wait and serialize canvas plus EDT. A miss
  burst does not start N `FontFace.load()` calls for one family. EDT stays per glyph.
- First-seen admit groups prepare unique strings in parallel. Layout count stays one per
  (text, style). Instance and palette writes stay serial after that wave.
- Compute-cull no longer rasters a unique miss that only sits in the 0.25-viewport prepare ring.
  Tight-view unique text still finishes in that commit. Ring intern hits and same-commit copies
  of a tight unique string are eligible that turn, then gated by the off-screen admit budget.
  There is no leftover rAF wave.
- Draw instances are 8 bytes (`prototypeGlyph`, `paletteIndex`). Shaders fetch unique rect, UV, and
  metadata from an RGBA32F prototype texture. UV is rewritten as f16 pairs and metadata as two
  16-bit integer floats so RGBA32F cannot canonicalize NaN. Prototype width comes from
  `textureSize` / `textureDimensions`, not a third glyph uniform. The first stroke rebinds
  `uPrototype` after the palette grows. WebGL proto/palette dirty uploads copy a zero-offset
  float view; ANGLE ignores `Float32Array.subarray` byte offsets on RGBA32F. Growing the palette
  rewrites the existing proto texture so Pixi's first-upload snapshot cannot drop dirty glyphs
  after texel 0. Replacing that `Texture` uploads on the CPU, but vertex `texelFetch` is zeros.
  WebGPU scatter and CPU compact write two uints per visible glyph instead of copying the
  24-byte store. One mesh and insertion order stay.
- Duplicate strings intern one layout result per (family, size, weight, text). Later first-seen
  copies and broadcast `updateTextPositions` skip `LayoutEngine.layout` until the font registry
  revision changes.
- `clone` rewrites an existing dest range in place when capacity already fits, and copies instance
  bytes with `copyWithin`.
- Broadcast text-plus-position updates keep the position-only transform kind. Labels with default
  zero anchors patch 16 palette bytes; non-zero anchors still rewrite the fill record.
- Rendered labels that share one interned text and style skip the per-label snapshot pipeline
  (`applyContentLane`). One layout, `shareMany` onto one prototype range, then a packed x/y write.
  Spatial AABBs come from `placeMany` (packed origins plus the shared run box). Object-path
  content-plus-position commits (mixed text, shaping, non-zero anchors, non-unit scale) still
  rewrite spatial AABBs from the laid-out run so hit bounds do not stay on the intake estimate.
- Duplicate strings share one glyph instance block. Compact/draw writes each label's palette
  index from the cull record. Store `highWater` stays at unique glyphs.
- First-seen fill-only duplicates skip per-label snapshots (`applyAdmitLane`): one layout per
  (text, style), a shared prototype range, and a columnar full palette write. Scaled, rotated,
  anchored, z-indexed, and stroked first-seen labels stay on the object path.
- Commits with culling off no longer scan every resident through `queryAll` unless membership or
  visibility changed. Clearing a previous viewport still rebuilds the full set.
- `updateTextPositions` slides spatial AABBs when the text is unchanged, so a text-plus-position
  batch does not re-estimate bounds that a prior layout already measured.
- Dirty uploads that exceed eight coalesced ranges split into equal-width bands instead of one
  first-to-last span, so two far-apart clusters do not upload the hole between them.
- Four-channel atlas pages (MSDF/color) premultiply on the CPU and upload glyph rectangles, the
  same way single-channel pages already did.
- Bitmap layout cache hits return before constructing a PixiJS `TextStyle`. Instance builds
  dedupe atlas keys with a set instead of scanning the unique list.
- Creates after the first residency query join through the resident dirty path, so adding labels
  into a live layer does not `queryAll` the existing set.
- Palette uploads stack contiguous full texture rows into one write when the row stride meets
  WebGPU's 256-byte `bytesPerRow` rule. A 100k position storm is one or two writes, not one per
  row.

## 1.2.0 - 2026-08-22

Published frame and storage budgets are unchanged. Formal browser artifacts remain the 1.1.0
Apple M1 Pro Chrome files; `benchmark:check` and `release:check` fall back to those measurements.

### Added

- `requestComputeCullGpu()` requests a WebGPU adapter and device whose storage-binding limits fit
  million-label compute culling, for `Application.init({ gpu })`.
- `culling.computeCull` (`true` / `false` / `"auto"`) and `culling.lod` options; `cullPath`
  diagnostics report the path that ran.
- `rasterizerOptions.tinySdf` builds HarfBuzz glyphs as a local SDF from the canvas mask;
  `rasterizerOptions.prebuilt` serves packed pages before any generator; `prebuiltGlyphKey` is
  exported from the advanced surface.
- Laboratory: `million-live` draws the coordinator mesh for one million labels; `first-seen` jumps
  the camera onto never-rendered regions each frame; `camera-live` records which cull path a
  rendering camera ran. Scale overrides write `-exploratory` artifacts instead of overwriting
  formal ones. `TextLayer.stats` records layout, instance-write, palette-write, spatial, and
  upload timers.

### Fixed

- Bulk updates with duplicate ids could grow a scratch column past store capacity and crash the
  next commit.
- Every zero-z label insert re-sorted the whole draw list; sorts now trigger only on out-of-order
  inserts, z or order changes, or while any nonzero z-index is live.
- Compute-cull commits that patched resident labels left stale instance bytes and stale record
  offsets on the GPU; content edits now re-upload their dirty ranges and rewrite record
  offset/count.
- The browser benchmark suite had been unrunnable since the laboratory split pulled `node:os` into
  the page bundle; `benchmarkRuntime()` now lives in a node-only module.
- Dense spatial queries paid an O(K log K) insertion-order sort; the linear fallback now sums
  candidate bucket sizes with an early exit before walking the grid.
- `sourceRevision` is `u32`; a 10 Hz counter no longer throws after ~1.8 hours of edits.
- Atlas eviction could reuse rectangles that live instances still sample; the coordinator now
  refcounts each label's atlas keys and pins live entries, and all-pinned pressure reports
  capacity loudly.

### Performance

- Atlas packing uses Skyline Bottom-Left plus a waste map, and eviction walks a per-mode O(1) LRU
  instead of scanning every resident glyph.
- Glyph instances write through typed-array views. Content commits skip the byte-for-byte equality
  pass and reuse coordinator scratch batches.
- Numeric fills skip PixiJS `Color` parsing. Occupied slots can patch x/y through `setPosition`.
- Viewport queries use a hierarchical hash grid and fall back to the linear scan only when the
  query would visit most residents.
- The 40 KiB core gzip CI gate is deferred. `bun run benchmark:check` still measures the graph and
  does not fail that size.
- Shared label styles intern to one frozen object. Packed x/y commits patch only the palette
  position texels. Store and spatial z-index columns are `Float32`.
- Fill-only GPU transforms pack into 32 bytes. Stroke and drop shadow live in a sparse texel
  after the core palette region. The published 64-byte ceiling stays until new artifacts exist.
- The CPU store packs scale, rotation, alpha, and anchors as binary16, generations and source
  revisions as `u16`, and occupied/visible/kind into one flag byte. The dirty journal no longer
  reserves a full-capacity slot list. One million reserved slots stay within 48 MiB plus the
  journal floor. The published 128 MiB ceiling stays until new artifacts exist.
- Live glyph instances pack the local rectangle as four `f16` values and occupy 24 bytes. The mesh
  binds that field as `uint32x2` and shaders unpack it, so WebGL 2 does not need `HALF_FLOAT`
  instance attributes. The published 32-byte ceiling stays until new artifacts exist.
- Wave 0 laboratory: `million-live` draws the coordinator mesh for one million labels; rendering
  frames split CPU JS, upload bytes, and GPU completion; `TextLayer.stats` records layout,
  instance-write, palette-write, spatial, and upload timers. `atlas-pressure` frame p95 is
  measured and not failed against the 1.1.0 artifact.
- Live atlas keys pack to integers on the coordinator path. The instance free list is a
  power-of-two segregated first-fit. Dirty uploads merge a 256-byte gap, collapse after eight
  ranges, and promote when dirty bytes reach 75% of the live span. Techniques adapted from
  [pmndrs/glyph](https://github.com/pmndrs/glyph). Published frame and storage ceilings stay.
- Equal-height atlas cells pack along a next-fit shelf when they match the current row. Skyline
  still places the first cell of a new row and mixed sizes. Eviction holes still go through the
  waste map. Published `atlas-pressure` frame ceilings stay.
- WebGPU can compact an expanded CPU working set against the tight draw viewport with a stable
  prefix sum and indexed indirect draw. Camera motion inside that working set skips spatial queries
  and instance writes. A single-bank mesh stays on that path when late glyph allocation leaves the
  CPU store out of draw order. WebGL and multi-segment meshes retain the tight CPU grid. `cullPath`
  reports the path that ran.
- First-seen layout and raster run in the commit that first sees the label. Compute-cull prepares
  labels that intersect the tight draw view plus a 0.25-viewport ring. There is no leftover
  admission wave. Unchanged visible labels keep their rendered epoch so a sibling z-index or blend
  change does not evict them. Shape-cache hits return a run on the same turn. Duplicate strings
  clone instance ranges and only rewrite the palette index. `tinySdf: true` builds HarfBuzz glyphs
  with a local SDF from the canvas mask and skips the MSDF worker. `rasterizerOptions.prebuilt`
  serves packed pages before generation. `culling.lod` drops labels whose projected font height is
  below one pixel.
- Compute-cull GPU mirrors sync incrementally: commits upload only dirty instance byte ranges and
  changed or appended cull records, keyed by a draw-list epoch that appends preserve; re-sorts,
  removals, and cull-path fallbacks force a full resync. Camera frames skip the first-seen ring
  query while the draw viewport stays inside the last prepared ring.
- Same-font MSDF misses batch per (family, revision, raster size) into one generator pass — one
  font parse plus N crops instead of N parses — and TinySDF's distance transform reuses grow-only
  scratch. Multi-glyph atlases no longer fall back to the first glyph when a char is missing.
- Draw segments cache on the draw-list and instance-segment epochs, so content commits that keep
  glyph counts and pages stop walking every draw state and every glyph. The mesh vertex buffer
  skips its uploads while compute cull owns the draw and re-initializes on fallback.
- Rendered position-only movers take a columnar lane (`TransformPalette.writePositions`) instead
  of building two frozen snapshots and two wrapper objects per label. Dirty ranges store flat
  pairs with tail merging and skip the publish sort while offsets stay monotonic.
- Bulk intake memoizes text-bounds estimates by (text, style) identity, skips trigonometry at
  rotation zero, keeps the journal slot list at its high water, and skips `resolveGlyphText` on
  packed-identity paths (it sliced the remaining code points per HarfBuzz glyph). Duplicate-run
  labels ensure atlas glyphs once per (run, size, weight) per commit.
- Single-channel atlas pages upload staged glyph rectangles instead of re-uploading the whole page
  for one new glyph, promoting to a full upload when rectangles exceed half the page.

## 1.1.0 - 2026-08-15

### Added

- Independently created `TextGroupId` values with sparse membership, composed group visibility,
  group lifecycle operations, and synchronized rendering, culling, hit testing, and accessibility.
- Basic `vertical-rl` writing with upright top-to-bottom glyphs and right-to-left newline columns.
- Progressive site examples and regression coverage for minimal labels, independent groups,
  `TextId` visibility, vertical writing, `fontWeight`, and `fill`.
- Allocation-stable `showAll()` and `hideAll()` mutations for the complete resident label set.
- CJKV regional glyph selection, broad complex-script fallback, custom binary fonts, and sparse
  per-label language, script, direction, feature, and variation controls.
- Exact glyph-ID MSDF rasterization for contextual forms, ligatures, and localized alternates, plus
  an explicitly configurable worker and WebAssembly asset boundary.
- Interactive documentation with one million resident multilingual labels, five custom Noto font
  subsets, 100,000 position updates, and live WebGL 2 / WebGPU switching.

### Fixed

- Single-family bitmap layout keeps a scalar PixiJS font family, restoring deterministic browser
  compositing and renderer reattachment.
- Completed render work preserves the latest label and group visibility state across queued commits.
- Small CJK glyphs use oversampled distance fields with logical-size normalization, preserving
  continuous strokes across viewport zoom. The documentation CJK font uses a static Medium instance
  for deterministic MSDF outlines.
- Atlas pages bind in eight-texture banks, collapsing the documentation site's fully zoomed-out
  WebGPU workload from 2,111 page-alternating draws to one and keeping PixiJS uniform batches within
  capacity.
- Benchmark Vite servers disable file watching and HMR so every isolated workload closes cleanly
  after writing its artifact.

### Performance

- Default bitmap layout, HarfBuzz worker shaping, and dynamic glyph rasterization load on first use.
  The core ESM entry measures 39,996 bytes gzip, down from 47,995 bytes and within the 40 KiB budget.

## 1.0.0 - 2026-08-15

### Added

- Dense, generation-checked storage for 1,000,000 labels with immutable snapshots and compact
  diagnostics.
- Ergonomic CRUD, object-batch, packed-position, and columnar text-plus-position mutation APIs.
- PixiJS bitmap layout plus direct and worker-backed HarfBuzz shaping for multilingual text.
- Bounded MSDF, SDF, alpha, and color glyph atlases with generation-safe eviction.
- Compact glyph instances, transform palettes, dirty-range uploads, and paired WebGL/WebGPU shaders.
- Spatial culling, hit testing, bounds, z order, blend modes, effects, lifecycle isolation, and
  accessibility mirroring.
- pixi-viewport 6 binding for drag, deceleration, wheel, pinch, zoom, and rotated cameras.
- Interactive million-label playground with a 100,000-label position storm.
- Isolated browser benchmark laboratory, committed raw artifacts, generated reports, and CI budgets.
- Focused root, viewport, accessibility, shaping, advanced, and worker package entry points.

### Performance

- One million resident labels stay within 72 MiB of fixed-width CPU storage on the reference run.
- Eight million visible glyphs use a 256,000,000-byte instance buffer and one observed instanced draw.
- Million-label viewport, dynamic counter, drag, zoom, and position-storm frame p95 values stay within
  the 16.67 millisecond budget on the reference Apple M1 Pro browser fixture.

## 0.0.1 - 2026-08-15

### Added

- Publishable ESM package metadata for `pixi-glyphflow`.
- PixiJS-compatible `TextLayer` POC with label creation, mutation, removal, commits, lifecycle, and
  diagnostics.
- Bun tests for the public lifecycle and error paths.
- Bun, TypeScript 7, tsdown, Oxlint, Oxfmt, publint, and Are the Types Wrong verification gates.
- GitHub CI and npm Trusted Publishing workflows.
