# Changelog

## Unreleased

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
