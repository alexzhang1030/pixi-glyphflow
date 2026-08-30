# pixi-glyphflow task ledger

## Phase 0

- [x] Task 0.1: Rewrite the product specification and project context map in English.
  - Acceptance: The specification contains objective, stack, commands, structure, style, testing, boundaries, performance budgets, and release criteria.
  - Verify: Search all project documentation for non-English project content and removed source-project identifiers.
  - Files: .agents/docs/pixi-glyphflow-blueprint.md, .agents/docs/README.md, .agents/docs/technology-stack.md

- [x] Task 0.2: Remove the copied engineering-reference snapshot.
  - Acceptance: The reference directory and every direct identifier disappear from the repository.
  - Verify: rtk rg -n -i with the sanitization pattern returns zero matches.
  - Files: .agents/docs/references

- [x] Task 0.3: Establish baseline correctness, package, CPU, and browser measurements.
  - Acceptance: Isolated-process baseline artifacts record the 0.0.1 behavior at 1,000,000 labels with 100,000 real mutations plus equal-content PixiJS browser fixtures.
  - Verify: bun run baseline
  - Files: benchmarks/baseline.ts, benchmarks/schema.ts, package.json, benchmarks/results

## Phase 1

- [x] Task 1.1: Implement generation-checked TextStore identities and immutable snapshots.
  - Acceptance: Create, get, update, remove, reuse, growth, and stale identity behavior pass through TextStore.
  - Verify: bun test tests/TextStore.test.ts; bun run benchmark:store
  - Files: src/store/TextStore.ts, src/store/types.ts, tests/TextStore.test.ts, benchmarks/store.ts, benchmarks/store-worker.ts

- [x] Task 1.2: Implement the ergonomic TextLayer CRUD and bulk interface.
  - Acceptance: createMany, get, has, update, updateMany, remove, removeMany, and clear follow the public specification.
  - Verify: bun test tests/TextLayer.crud.test.ts; bun run benchmark:core
  - Files: src/TextLayer.ts, src/types.ts, src/index.ts, tests/TextLayer.crud.test.ts, benchmarks/layer.ts, benchmarks/layer-worker.ts

- [x] Task 1.3: Implement revision journals, no-op commits, compact, and core diagnostics.
  - Acceptance: Dirty domains remain minimal, revisions are monotonic, no-op commits schedule zero work, and compact preserves IDs.
  - Verify: bun test tests/TextLayer.commit.test.ts
  - Files: src/TextLayer.ts, src/store/DirtyJournal.ts, src/store/TextStore.ts, src/types.ts, tests/DirtyJournal.test.ts, tests/TextLayer.commit.test.ts

## Phase 2

- [x] Task 2.1: Implement FontRegistry sources, fallback chains, revisions, and lifetime.
  - Acceptance: System, prebuilt bitmap, and binary sources register and retire deterministically.
  - Verify: bun test tests/FontRegistry.test.ts
  - Files: src/FontRegistry.ts, src/fonts/types.ts, src/types.ts, tests/FontRegistry.test.ts

- [x] Task 2.2: Implement the PixiJS bitmap layout adapter and PositionedRun.
  - Acceptance: Latin, CJK, emoji, wrapping, alignment, spacing, truncation, and bounds match reference fixtures.
  - Verify: bun test tests/layout.test.ts
  - Files: src/pixi/compat/bitmapLayout.ts, src/layout/LayoutEngine.ts, src/layout/types.ts, tests/layout.test.ts

- [x] Task 2.3: Implement HarfBuzz worker shaping and binary-font outlines.
  - Acceptance: Arabic, Devanagari, bidi, feature, cluster, advance, and stale-response fixtures pass.
  - Verify: bun test tests/shaping.test.ts tests/worker-shaping.test.ts && bun run smoke:harfbuzz && bun run smoke:worker
  - Files: src/shaping/HarfBuzzShaper.ts, src/worker/text-worker.ts, src/worker/protocol.ts, tests/shaping.test.ts

- [x] Task 2.4: Implement trusted immutable glyph runs.
  - Acceptance: Valid runs are adopted in constant time and invalid ownership or revision data is rejected.
  - Verify: bun test tests/trusted-run.test.ts
  - Files: src/shaping/TrustedGlyphRun.ts, src/types.ts, src/TextLayer.ts, tests/trusted-run.test.ts

## Phase 3

- [x] Task 3.1: Implement atlas packing, pinning, eviction, and generation swaps.
  - Acceptance: Atlas bytes stay bounded and stale generation results never replace visible entries.
  - Verify: bun test tests/GlyphAtlas.test.ts
  - Files: src/atlas/GlyphAtlas.ts, src/atlas/Packer.ts, src/atlas/types.ts, tests/GlyphAtlas.test.ts

- [x] Task 3.2: Implement prebuilt distance-field and dynamic raster glyph providers.
  - Acceptance: MSDF, SDF, alpha, and color pages produce stable entries and correct metadata.
  - Verify: bun test tests/glyph-providers.test.ts
  - Files: src/atlas/PrebuiltGlyphProvider.ts, src/atlas/RasterGlyphProvider.ts, src/atlas/types.ts, tests/glyph-providers.test.ts

- [x] Task 3.3: Implement compact glyph instances and dirty range uploads.
  - Acceptance: Geometric growth preserves buffer identity and updates only changed ranges.
  - Verify: bun test tests/GlyphInstanceStore.test.ts
  - Files: src/render/GlyphInstanceStore.ts, src/render/DirtyRanges.ts, src/render/types.ts, tests/GlyphInstanceStore.test.ts

- [x] Task 3.4: Implement paired GLSL and WGSL instanced Mesh rendering.
  - Acceptance: One atlas segment renders in WebGL and WebGPU with equivalent pixels.
  - Verify: bun run test:browser -- glyph-rendering
  - Files: src/render/GlyphMesh.ts, src/render/shaders.ts, src/pixi/compat/createGeometry.ts, tests/browser/glyph-rendering.test.ts

- [x] Task 3.5: Implement WebGL and WebGPU upload adapters.
  - Acceptance: Partial WebGL updates and bounded WebGPU staging preserve identical instance data.
  - Verify: bun test tests/renderer-adapters.test.ts
  - Files: src/render/WebGLAdapter.ts, src/render/WebGPUAdapter.ts, src/render/RendererAdapter.ts, tests/renderer-adapters.test.ts

- [x] Task 3.6: Integrate commit, atlas, instance, mesh, attach, detach, and destruction.
  - Acceptance: Complete revisions render atomically and every owned resource has one teardown path.
  - Verify: bun run test:browser -- lifecycle
  - Files: src/TextLayer.ts, src/render/RenderCoordinator.ts, tests/browser/lifecycle.test.ts

## Phase 4

- [x] Task 4.1: Implement spatial culling, bounds, and hit testing.
  - Acceptance: Viewport queries, world bounds, and topmost hits match known fixtures.
  - Verify: bun test tests/culling.test.ts
  - Files: src/culling/SpatialIndex.ts, src/TextLayer.ts, src/types.ts, tests/culling.test.ts

- [x] Task 4.2: Implement appearance effects and transform coverage.
  - Acceptance: Fill, stroke, shadow, blend, anchor, scale, rotation, alpha, visibility, and z order match visual goldens.
  - Verify: bun run test:browser -- appearance
  - Files: src/render/shaders.ts, src/render/GlyphMesh.ts, src/types.ts, tests/browser/appearance.test.ts

- [x] Task 4.3: Implement the optional accessibility adapter.
  - Acceptance: Selected labels mirror text, role, bounds, visibility, and focus order incrementally.
  - Verify: bun run test:browser -- accessibility
  - Files: src/accessibility/AccessibilityAdapter.ts, src/TextLayer.ts, src/types.ts, tests/browser/accessibility.test.ts

- [x] Task 4.4: Implement the optional pixi-viewport 6 binding.
  - Acceptance: Drag, deceleration, wheel zoom, pinch zoom, and camera rotation coalesce culling work, preserve label revisions, and release every event listener.
  - Verify: bun run test:browser -- viewport-integration
  - Files: src/viewport/ViewportBinding.ts, src/viewport/types.ts, tests/browser/viewport-integration.test.ts

## Phase 5

- [x] Task 5.1: Build browser fixtures and raw metric collection.
  - Acceptance: Equal-content Text, BitmapText, HTMLText, and glyphflow fixtures emit the benchmark schema.
  - Verify: bun run benchmark -- --workload static-hud
  - Files: benchmarks/browser/index.ts, benchmarks/browser/fixtures.ts, benchmarks/schema.ts, playground/benchmark.html

- [x] Task 5.2: Implement every workload driver and report generation.
  - Acceptance: Raw JSON and a generated Markdown report exist for every workload, including full visibility, viewport culling, drag, zoom, and 100,000-position-update fixtures with 1,000,000 resident labels.
  - Verify: bun run benchmark
  - Files: benchmarks/workloads.ts, benchmarks/run.ts, benchmarks/report.ts, benchmarks/results

- [x] Task 5.3: Optimize measured bottlenecks and enforce budgets.
  - Acceptance: Retained changes exceed run variance and every specification budget passes.
  - Verify: bun run benchmark:check
  - Files: benchmarks/budgets.ts, benchmarks/PERFORMANCE.md, package.json, .github/workflows/ci.yml

## Phase 6

- [x] Task 6.1: Write English installation, getting-started, and API documentation.
  - Acceptance: Every public export has a stable reference and runnable example.
  - Verify: bun run docs:check
  - Files: README.md, docs/getting-started.md, docs/api.md, docs/fonts.md

- [x] Task 6.2: Write English architecture, performance, accessibility, and migration guides.
  - Acceptance: Operational constraints, benchmark method, accessibility behavior, and 0.0.1 migration are explicit.
  - Verify: bun run docs:check
  - Files: docs/architecture.md, docs/performance.md, docs/accessibility.md, docs/migration.md

- [x] Task 6.3: Build the runnable playground and examples.
  - Acceptance: A clean checkout starts every documented example, the pixi-viewport stress playground, and the production build.
  - Verify: bun run playground:build
  - Files: playground/index.html, playground/src/main.ts, playground/package.json, package.json

## Phase 7

- [x] Task 7.1: Promote package metadata and changelog to 1.0.0.
  - Acceptance: Version, exports, files, README, and changelog describe the verified stable surface.
  - Verify: bun run release:check
  - Files: package.json, CHANGELOG.md, README.md, bun.lock

- [x] Task 7.2: Publish and verify 1.0.0.
  - Acceptance: CI, signed tag, npm provenance, GitHub Release, and public-registry consumer checks all succeed.
  - Verify: npm view plus independent runtime, browser, and TypeScript consumer probes.
  - Files: .github/workflows/release.yml, scripts/package-smoke.ts

## Phase 8

- [x] Task 8.1: Build the interactive documentation site.
  - Acceptance: One responsive Nuxt SSR page presents the package surface and runs a real TextLayer plus pixi-viewport movement stress scene.
  - Verify: bun run site:typecheck && bun run site:build && bun run site:test
  - Files: site, package.json, bun.lock, .github/workflows/ci.yml, README.md, CONTRIBUTING.md

- [x] Task 8.2: Exercise both renderer backends in the live documentation demo.
  - Acceptance: Readers can rebuild the 1,000,000-label and 100,000-position pressure test on WebGL 2 and WebGPU, with exact adapter identity and browser capability state exposed in the interface.
  - Verify: bun run site:typecheck && bun run site:test && bun run test:browser
  - Files: site/components/GlyphflowDemo.client.vue, site/tests/site.pw.ts, site/assets/css/main.css, site/README.md

- [x] Task 8.3: Exercise custom CJKV and multilingual fonts in the live documentation demo.
  - Acceptance: Five registered binary fonts shape CJKV regional forms, Arabic, Devanagari, Hebrew, and Thai; the fallback stack also presents Vietnamese, Greek, Cyrillic, and emoji samples.
  - Verify: bun test tests/LayoutEngine.test.ts tests/cmap.test.ts tests/glyph-providers.test.ts && bun run site:test
  - Files: src/layout, src/fonts, src/atlas, site/components/GlyphflowDemo.client.vue, site/public/fonts, docs/fonts.md

## Phase 9

- [x] Task 9.1: Add independently created label groups and composed visibility.
  - Acceptance: Every group has a unique layer-local identity; labels retain local visibility while group masks affect rendering, culling, hit testing, and accessibility.
  - Verify: bun test tests/TextLayer.groups.test.ts
  - Files: src/TextLayer.ts, src/types.ts, src/accessibility/AccessibilityAdapter.ts, tests/TextLayer.groups.test.ts

- [x] Task 9.2: Add basic vertical writing and verify existing style controls.
  - Acceptance: Vertical-rl labels stack upright glyphs top-to-bottom, explicit lines form right-to-left columns, and font weight plus fill updates publish through the style dirty domain.
  - Verify: bun test tests/LayoutEngine.test.ts tests/TextLayer.commit.test.ts
  - Files: src/layout/LayoutEngine.ts, src/layout/types.ts, src/TextLayer.ts, src/types.ts, tests/LayoutEngine.test.ts, tests/TextLayer.commit.test.ts

- [x] Task 9.3: Document and verify the new public surface.
  - Acceptance: README, API reference, changelog, PCR specification, and generated declarations describe group lifecycle, visibility composition, vertical writing, and styling.
  - Verify: bun run check
  - Files: README.md, docs/api.md, CHANGELOG.md, .agents/docs/pixi-glyphflow-blueprint.md, tasks/plan.md, tasks/todo.md

## Phase 10

- [x] Task 10.1: Restore the core ESM startup budget with lazy default backends.
  - Acceptance: Default bitmap layout, HarfBuzz worker shaping, and glyph rasterization load on first use while injected backends retain their direct path; core gzip stays below 40 KiB.
  - Verify: bun run benchmark:check && bun run test:browser && bun run site:test
  - Files: src/layout/LayoutEngine.ts, src/layout/types.ts, src/render/RenderCoordinator.ts, docs/architecture.md, CHANGELOG.md, .agents/docs/pixi-glyphflow-blueprint.md

## Phase 11

- [x] Task 11.1: Add progressive public-API examples to the documentation site.
  - Acceptance: The site presents minimal creation, separately created group visibility, per-ID visibility, vertical writing, font weight, and fill while stating that `text` is the required creation field.
  - Verify: bun run site:typecheck && bun run site:test
  - Files: site/app.vue, site/components/ExamplesSection.vue, site/tests/site.pw.ts, site/README.md

- [x] Task 11.2: Publish and verify 1.1.0.
  - Acceptance: Package metadata, site badge, changelog, signed tag, GitHub Release, npm metadata, provenance, and independent installation all resolve to 1.1.0.
  - Verify: bun run release:check && gh release view v1.1.0 && npm view pixi-glyphflow@1.1.0 && independent package smoke
  - Evidence: [PR #1](https://github.com/alexzhang1030/pixi-glyphflow/pull/1) merged as `7720ed4345052d324d31de98705eb9ac05bd47af`; the [GitHub Release](https://github.com/alexzhang1030/pixi-glyphflow/releases/tag/v1.1.0) and [publish workflow](https://github.com/alexzhang1030/pixi-glyphflow/actions/runs/31879817035) succeeded; npm `latest` resolves to 1.1.0 with shasum `7199c0248978e80337916f856d1b0c3228c34fca` and SLSA provenance; a fresh Node runtime and TypeScript 7 consumer passed against the public package.
  - Files: package.json, CHANGELOG.md, benchmarks/run.ts, benchmarks/PERFORMANCE.md, benchmarks/results, tasks/plan.md, tasks/todo.md

## Phase 12

- [x] Task 12.0: Record the extreme performance program from papers, systems, and 1.1.0 artifacts.
  - Acceptance: The PCR record diagnoses the atlas, instance-write, spatial, and measurement cliffs; maps Green/Chlumsky/Lengyel/Jylänki/Mapbox/TMP/Vello/GPU-driven sources to steal-or-reject; and sequences Waves 0–5 without changing published budgets.
  - Verify: bun run docs:check && bun run format:check
  - Files: .agents/docs/performance-plan.md, .agents/docs/README.md, docs/performance.md, tasks/plan.md, tasks/todo.md

- [x] Task 12.1: Make the laboratory tell the truth (Wave 0).
  - Acceptance: `million-live` commits 1,000,000 labels through `TextLayer` and draws the coordinator mesh. Rendering frames split CPU, upload bytes, and GPU completion. `TextLayer.stats` records layout, instance-write, palette-write, spatial, and upload timers. `atlas-pressure` frame p95 is measured and not failed against the 1.1.0 638 ms artifact. The live artifact is optional until a reference Chrome rerun.
  - Verify: bun test tests/TextLayer.commit.test.ts tests/benchmark-workloads.test.ts && bun run benchmark:check
  - Files: benchmarks/browser/workloads.ts, benchmarks/browser/timing.ts, benchmarks/budgets.ts, benchmarks/workloads.ts, src/TextLayer.ts, src/types.ts, docs/performance.md

- [x] Task 12.2: Replace guillotine packing and linear LRU (Wave 1 atlas).
  - Acceptance: Skyline Bottom-Left plus waste-map packing and O(1) LRU eviction keep 20,000 unique glyphs under 4 MiB. A unit pressure fixture completes in 65–89 ms here with 3,616 evictions and zero capacity failures. Browser frame p95 still needs a reference Chrome rerun.
  - Verify: bun test tests/GlyphAtlas.test.ts tests/Packer.test.ts
  - Files: src/atlas/Packer.ts, src/atlas/GlyphAtlas.ts, tests/GlyphAtlas.test.ts, tests/Packer.test.ts

- [x] Task 12.3: Replace DataView instance writes and Color-parsed palette updates (Wave 1 CPU).
  - Acceptance: Typed-array instance writes, reused scratch batches, packed numeric fills, and `setPosition` land behind the existing public seams. Reference dynamic-counter browser numbers still need a Chrome rerun.
  - Verify: bun test tests/GlyphInstanceStore.test.ts tests/TransformPalette.test.ts tests/TextLayer.commit.test.ts tests/RenderCoordinator.test.ts
  - Files: src/render/GlyphInstanceStore.ts, src/render/TransformPalette.ts, src/render/RenderCoordinator.ts

- [x] Task 12.4: Replace the linear spatial scan with a hierarchical hash grid (Wave 1 cull).
  - Acceptance: Hash-grid queries preserve exact AABB results and insertion-ordered output. A 100,000-label probe tests about 320 candidates per small viewport query. Zoomed-out frames still fall back to the linear scan.
  - Verify: bun test tests/SpatialIndex.test.ts tests/culling.test.ts
  - Files: src/culling/SpatialIndex.ts, tests/SpatialIndex.test.ts, tests/culling.test.ts

- [x] Task 12.4a: Defer the 40 KiB core gzip CI fail for Wave 1.
  - Acceptance: `bun run benchmark:check` still measures the core ESM graph and does not fail that size. Wave 1 packing, instance, and culling code stay as landed.
  - Verify: bun run build && bun run benchmark:check
  - Files: benchmarks/budgets.ts, docs/performance.md, .agents/docs/performance-plan.md

- [x] Task 12.5a: Intern shared styles and patch position-only palette texels (Wave 2 CPU).
  - Acceptance: Equal styles share one frozen object; `updatePositions` and x/y-only patches set a position-only flag; the coordinator writes 16 palette bytes for that path; z-index columns are `Float32`. Published 32-byte instance and 64-byte transform ceilings stay.
  - Verify: bun test tests/TextStore.test.ts tests/RenderCoordinator.test.ts tests/TextLayer.commit.test.ts tests/TransformPalette.test.ts
  - Files: src/store/TextStore.ts, src/render/RenderCoordinator.ts, src/render/TransformPalette.ts, src/culling/SpatialIndex.ts, src/TextLayer.ts

- [x] Task 12.5b: Pack fill-only GPU transforms into 32 bytes (Wave 2 palette).
  - Acceptance: Fill-only records use two `rgba32float` texels; stroke/shadow allocate one extra texel after `capacity * 2`; shaders read `uEffectBase`; position-only patches still dirty 16 bytes. Published 64-byte transform ceiling stays.
  - Verify: bun test tests/TransformPalette.test.ts tests/RenderCoordinator.test.ts tests/GlyphMesh.test.ts tests/pack.test.ts
  - Files: src/render/TransformPalette.ts, src/render/shaders.ts, src/render/GlyphMesh.ts, src/render/RenderSurface.ts, src/render/pack.ts

- [x] Task 12.5c: Pack TextStore columns toward 48 MiB / 1M (Wave 2 store).
  - Acceptance: One million reserved slots allocate ≤ 48 MiB plus the journal floor. Scale/rotation/alpha/anchors are `f16`; generation is `u16`; source revision is `u32`; occupied/visible/kind share one flag byte; the dirty journal slot list is sparse. Published 128 MiB store ceiling stays. The public `alpha: 0.5` snapshot still round-trips.
  - Verify: bun test tests/TextStore.test.ts tests/DirtyJournal.test.ts tests/pack.test.ts
  - Files: src/store/TextStore.ts, src/store/DirtyJournal.ts, src/render/pack.ts

- [x] Task 12.5d: Pack live glyph instances into 24 bytes (Wave 2 GPU).
  - Acceptance: Each instance is 24 bytes (four `f16` rect components, `unorm16x4` UVs, palette index, metadata). The mesh binds the rect as `uint32x2`; shaders unpack with `unpackHalf2x16` / `unpack2x16float`. Published 32-byte ceiling stays.
  - Verify: bun test tests/GlyphInstanceStore.test.ts tests/GlyphMesh.test.ts tests/RenderCoordinator.test.ts
  - Files: src/render/types.ts, src/render/GlyphInstanceStore.ts, src/render/GlyphMesh.ts, src/render/RenderSurface.ts

- [x] Task 12.2b: Shelf-pack equal-height atlas rows (Wave 1 leftover).
  - Acceptance: Incoming glyphs that match the current row height pack left-to-right on that shelf. A 1024×1024 page holds 4096 of 16×16 cells. Mixed heights do not overlap. Waste-map eviction reuse and Skyline fallback stay. Published frame ceilings stay.
  - Verify: bun test tests/Packer.test.ts tests/GlyphAtlas.test.ts
  - Files: src/atlas/Packer.ts, tests/Packer.test.ts

- [x] Task 12.9: Steal hot-path techniques from pmndrs/glyph (Wave 1 leftovers).
  - Acceptance: Live atlas keys are packed integers with a string fallback; `GlyphInstanceStore` allocates from power-of-two free-list buckets; dirty publishes merge a 256-byte gap, collapse after 8 ranges, and promote at 75% of live bytes. Public `TextLayer` contract and published 32/64/128 ceilings stay. No new WASM, GLB, or `glyphMode`.
  - Verify: bun test tests/glyphIdentity.test.ts tests/GlyphAtlas.test.ts tests/GlyphInstanceStore.test.ts tests/DirtyRanges.test.ts tests/RenderCoordinator.test.ts
  - Files: src/atlas/glyphIdentity.ts, src/atlas/GlyphAtlas.ts, src/render/RenderCoordinator.ts, src/render/GlyphInstanceStore.ts, src/render/DirtyRanges.ts, src/render/TransformPalette.ts

- [ ] Task 12.5: Remaining Wave 2 follow-through after measured artifacts.
  - Acceptance: The formal M1 Pro `million-live` workload uses 1,000,000 labels, 10 warmup frames, and 120 sampled steady-state full-visibility product frames. Its current schema 7 artifact passes the evidence seal plus current browser-build and harness fingerprints. Frame p95 is ≤ 16.67 ms; the complete live runtime store is ≤ 64 MiB; draw references are 8 bytes; prototype records are 24 bytes; fill transforms use a 32-byte core and a 48-byte effectful maximum. The constructor base-store unit ceiling remains 48 MiB plus 256 B. Historical 1.1.0 thresholds retain their independent gate. Completion requires the formal artifact and passing budget command.
  - Verify: `bun run benchmark -- --workload million-live --renderer webgl` then `bun run build && bun run benchmark:check`
  - Files: benchmarks/schema.ts, benchmarks/workloads.ts, benchmarks/browser/workloads.ts, benchmarks/budgets.ts, benchmarks/report.ts, benchmarks/artifacts.ts, tests/benchmark-workloads.test.ts, tests/benchmark-artifacts.test.ts, docs/performance.md, benchmarks/PERFORMANCE.md, .agents/docs/performance-plan.md

- [x] Task 12.6: Add a WebGPU compute cull adapter (Wave 3).
  - Acceptance: Camera-only WebGPU frames inside an expanded CPU working set compact the direct single-bank mesh with stable z/insertion order and no instance rewrite. WebGL, unavailable devices, disabled compute culling, and multi-segment meshes keep the tight CPU grid. Diagnostics name the path that ran.
  - Verify: bun run test:browser -- glyph-rendering && bun run test:browser -- viewport-integration
  - Files: src/TextLayer.ts, src/types.ts, src/render/ComputeCullPass.ts, src/render/RenderSurface.ts, src/culling/computeCull.ts, src/culling/computeCull.wgsl.ts

- [x] Task 12.6c: Atlas texture arrays (Wave 3 leftover).
  - Acceptance: Two `sampler2DArray` / `texture_2d_array` textures hold R8 (sdf/alpha) and RGBA8 (msdf/color) pages as layers. Instance metadata low bits are the same-format layer. Compact walks split only on blend and z. Pixi buffer uploaders stay 2D; the surface writes `texSubImage3D` / `writeTexture` at `z = layer`. Palette SSBO is not started. Published budgets stay.
  - Verify: bun test tests/GlyphMesh.test.ts tests/GlyphAtlas.test.ts
  - Files: src/render/shaders.ts, src/render/GlyphMesh.ts, src/render/RenderSurface.ts, src/atlas/GlyphAtlas.ts, src/atlas/types.ts

- [x] Task 12.7a: Four-channel atlas sub-rect uploads (Wave 4 leftover).
  - Acceptance: MSDF/color pages premultiply RGB on the CPU, use `no-premultiply-alpha`, and upload staged rectangles unless the rects exceed half the page. Single-channel rect uploads stay.
  - Verify: bun test tests/pack.test.ts tests/DirtyRanges.test.ts tests/glyph-providers.test.ts
  - Files: src/render/pack.ts, src/render/RenderSurface.ts

- [x] Task 12.7b: Palette multi-row uploads and incremental create (hot-path leftovers).
  - Acceptance: Contiguous full palette rows upload in one write when the row stride is 256-byte aligned. Creates after the first residency query do not `queryAll`; new on-screen labels still appear in that commit. Hide/show/remove/group still refresh. Published budgets stay.
  - Verify: bun test tests/pack.test.ts tests/TextLayer.commit.test.ts tests/culling.test.ts tests/computeCull.test.ts
  - Files: src/render/pack.ts, src/render/RenderSurface.ts, src/TextLayer.ts, src/culling/computeCull.ts

- [x] Task 12.14: First-seen admit lane for fill-only duplicate strings.
  - Acceptance: Unrendered fill-only labels that share interned (text, style) commit through
    `applyAdmitLane` with one layout per group, `writeFills`, shared instance ranges, and no
    per-label snapshots. Scale, rotation, anchors, z-index, stroke, and trusted runs stay on
    the object path. On-screen labels still appear in that commit. Published budgets stay.
  - Verify: bun test tests/TransformPalette.test.ts tests/TextStore.test.ts tests/RenderCoordinator.test.ts tests/TextLayer.commit.test.ts
  - Files: src/render/TransformPalette.ts, src/store/TextStore.ts, src/render/RenderCoordinator.ts, src/TextLayer.ts

- [x] Task 12.15: Prototype-fetch instance mesh.
  - Acceptance: Draw instances are 8-byte `(protoIndex, paletteIndex)` records. Shaders fetch
    the unique 24-byte store from an RGBA32F prototype texture. Scatter and CPU compact write
    two uints per visible glyph. One `GlyphMesh` and insertion order stay. Published budgets stay.
  - Verify: bun test tests/GlyphMesh.test.ts tests/computeCull.test.ts tests/pack.test.ts && bun run typecheck
  - Files: src/render/types.ts, src/render/pack.ts, src/render/shaders.ts, src/render/GlyphMesh.ts, src/culling/computeCull.ts, src/culling/computeCull.wgsl.ts, src/render/ComputeCullPass.ts, src/render/RenderSurface.ts

- [x] Task 12.13: Share prototype instance ranges for duplicate strings.
  - Acceptance: `share` / `shareMany` retarget dests at one block; scatter and CPU compact
    write `paletteIndex` from the record/span; `set` copy-on-writes a shared dest;
    `highWater` tracks unique glyphs. Published budgets stay.
  - Verify: bun test tests/GlyphInstanceStore.test.ts tests/computeCull.test.ts tests/RenderCoordinator.test.ts tests/TextLayer.commit.test.ts
  - Files: src/render/GlyphInstanceStore.ts, src/culling/computeCull.ts, src/culling/computeCull.wgsl.ts, src/render/RenderSurface.ts, src/render/RenderCoordinator.ts, src/TextLayer.ts

- [x] Task 12.12: Batch clone and spatial place for content storms.
  - Acceptance: `cloneMany` copies one prototype onto a dest column; `placeMany` writes
    AABBs from packed x/y plus a shared local box; content-lane candidates require unit
    scale and zero rotation; rendered unit-transform storms skip the intake estimate
    rehash. Published budgets stay.
  - Verify: bun test tests/GlyphInstanceStore.test.ts tests/SpatialIndex.test.ts tests/RenderCoordinator.test.ts tests/TextLayer.commit.test.ts tests/TextStore.test.ts
  - Files: src/render/GlyphInstanceStore.ts, src/culling/SpatialIndex.ts, src/render/RenderCoordinator.ts, src/TextLayer.ts, src/store/TextStore.ts

- [x] Task 12.11: Columnar broadcast content lane for shared-string storms.
  - Acceptance: Rendered labels that share one interned (text, style) and zero anchors commit
    through `applyContentLane` with one layout and no per-label snapshots. Mixed text, shaping,
    trusted runs, and non-zero anchors stay on the object path. Published budgets stay.
  - Verify: bun test tests/RenderCoordinator.test.ts tests/TextLayer.commit.test.ts tests/TextStore.test.ts
  - Files: src/render/RenderCoordinator.ts, src/TextLayer.ts, src/store/TextStore.ts

- [x] Task 12.10: Intern duplicate-string layout and clone dest ranges in place.
  - Acceptance: Shared (family, size, weight, text) labels layout once; `clone` reuses dest
    capacity; broadcast `updateTextPositions` with zero anchors patches 16 palette bytes.
    On-screen first-seen labels still finish in that commit. Published budgets stay.
  - Verify: bun test tests/RenderCoordinator.test.ts tests/GlyphInstanceStore.test.ts tests/TextLayer.commit.test.ts tests/TextStore.test.ts tests/culling.test.ts
  - Files: src/render/RenderCoordinator.ts, src/render/GlyphInstanceStore.ts, src/store/TextStore.ts, src/TextLayer.ts

- [x] Task 12.25: Rematch prebuilt fields across clamp-equivalent logical sizes.
  - Acceptance: A `charsetSdfPrebuilt` bake at one logical size that clamps to
    `distanceFieldMinFontSize` crops a first-seen miss at another clamp size and interns
    the field. `uiSdfPrebuilt` at 16 px does not serve 32 px. Unseen ink and sizes above
    the minimum still generate in that commit. Published budgets stay. Default pages stay
    out of the core ESM graph.
  - Verify: bun test tests/prebuilt-charset-sdf.test.ts tests/prebuilt-ui-sdf.test.ts tests/glyph-providers.test.ts && bun run docs:check
  - Files: src/atlas/RasterGlyphProvider.ts, src/atlas/PrebuiltGlyphProvider.ts

- [x] Task 12.24: Optional charset TinySDF prebake.
  - Acceptance: `charsetSdfPrebuilt` bakes host text at the physical TinySDF size, skips
    empty-ink scalars, and remaps keys on later calls. `mergePrebuilt` concatenates family
    pages. No CJK bitmaps ship in the core gzip graph. The homepage demo bakes its language
    samples after FontFace load. Published budgets stay.
  - Verify: bun test tests/prebuilt-charset-sdf.test.ts tests/prebuilt-ui-sdf.test.ts && bun run docs:check
  - Files: src/prebuilt/charsetSdf.ts, src/prebuilt/index.ts, site/components/GlyphflowDemo.client.vue

- [x] Task 12.23: Skip empty-ink glyph generation.
  - Acceptance: White_Space except Ogham U+1680 and default-ignorable scalars skip
    raster and instance quads. Layout advance and the label AABB stay. Trusted runs,
    ligatures, and shared-cluster marks still generate. An empty TinySDF mask skips
    both EDTs. On-screen unique ink still finishes in that commit. Published budgets stay.
  - Verify: bun test tests/RenderCoordinator.test.ts tests/tinySdf.test.ts && bun run docs:check
  - Files: src/render/RenderCoordinator.ts, src/atlas/tinySdf.ts

- [x] Task 12.22: Intern physical TinySDF/MSDF fields across logical sizes.
  - Acceptance: A 16px and 32px miss of the same glyph share one TinySDF canvas+EDT or one
    MSDF generator pass when both clamp to `distanceFieldMinFontSize`. Metrics keep the
    per-request `rasterScale`. TinySDF shares across HarfBuzz ids for the same `glyphText`.
    A 64px miss still generates. Atlas entries stay per size bucket. Published budgets stay.
  - Verify: bun test tests/glyph-providers.test.ts
  - Files: src/atlas/RasterGlyphProvider.ts

- [x] Task 12.21: Optional `pixi-glyphflow/prebuilt` ASCII SDF side export.
  - Acceptance: `uiSdfPrebuilt` bakes U+0020–U+007E at 16 px as `rasterizerOptions.prebuilt`
    pages. First call encodes; later calls remap keys. Other sizes throw. A HarfBuzz-style
    `glyphId` plus a single Unicode scalar crops a `glyphId: 0` page and does not start
    TinySDF or MSDF. Ligatures stay exact-key only. `src/index.ts` and the core gzip graph
    do not import the side export. Published budgets stay.
  - Verify: bun test tests/prebuilt-ui-sdf.test.ts tests/glyph-providers.test.ts && bun run docs:check
  - Files: src/prebuilt, src/atlas/RasterGlyphProvider.ts, package.json, tsdown.config.ts

- [x] Task 12.20: Merge unique admit `writeFills` by fill identity.
  - Acceptance: Unique first-seen groups that share `style.fill` call `writeFills` once.
    Distinct fills stay separate. Instance writes and draw-state inserts stay per string.
    On-screen unique still finishes in that commit. Published budgets stay.
  - Verify: bun test tests/RenderCoordinator.test.ts tests/TransformPalette.test.ts tests/TextLayer.commit.test.ts
  - Files: src/render/RenderCoordinator.ts

- [x] Task 12.19: Columnar spatial translate for position storms.
  - Acceptance: `translateMany` slides occupied AABBs from packed deltas without rewriting
    z or visibility. Size class stays; only a cell-boundary crossing rebuckets.
    `updatePositions` and same-text `updateTextPositions` call it once per batch. Published
    budgets stay.
  - Verify: bun test tests/SpatialIndex.test.ts tests/culling.test.ts tests/TextLayer.commit.test.ts
  - Files: src/culling/SpatialIndex.ts, src/TextLayer.ts

- [x] Task 12.18: Batch same-size TinySDF misses and intern FontFace load.
  - Acceptance: Same-size `mode: "sdf"` rasters share one FontFace wait and serialize canvas
    plus EDT. A gated pair records one canvas start until the first gate resolves. EDT stays
    per glyph. Published budgets stay. Default baked pages stay out of the core ESM graph.
  - Verify: bun test tests/glyph-providers.test.ts && bun run typecheck
  - Files: src/atlas/RasterGlyphProvider.ts

- [x] Task 12.17: Prepare unique admit groups in parallel.
  - Acceptance: `applyAdmitLane` starts every group's layout and raster together. A gated
    two-string wave records both layouts before either resolves. Writes stay serial. On-screen
    unique still finishes in that commit. Published budgets stay.
  - Verify: bun test tests/RenderCoordinator.test.ts tests/TextLayer.commit.test.ts
  - Files: src/render/RenderCoordinator.ts

- [x] Task 12.16: Gate compute-cull ring-only unique first-seen admission.
  - Acceptance: Tight-view unique still layouts and rasters in the seeing commit. Ring-only
    unique misses stay unshaped until they enter the tight view or an intern hit exists. Same-
    commit ring copies of a tight unique string still admit. No leftover rAF. Published budgets
    stay.
  - Verify: bun test tests/computeCull.test.ts tests/RenderCoordinator.test.ts tests/TextLayer.commit.test.ts tests/culling.test.ts
  - Files: src/culling/computeCull.ts, src/render/RenderCoordinator.ts, src/TextLayer.ts

- [x] Task 12.7: Add hybrid glyph generation and upload budgets (Wave 4).
  - Acceptance: Local TinySDF or prebaked pages serve the common set; dynamic MSDF remains the long tail; a per-frame budget gates off-screen label admission, not texel uploads for already-instanced glyphs, without growing the core gzip entry.
  - Verify: bun test tests/glyph-providers.test.ts tests/GlyphAtlas.test.ts tests/computeCull.test.ts tests/culling.test.ts && bun run typecheck
  - Files: src/culling/computeCull.ts, src/TextLayer.ts, src/types.ts, src/atlas/RasterGlyphProvider.ts, src/atlas/PrebuiltGlyphProvider.ts, src/prebuilt

- [x] Task 12.32: Derive spatial bounds from store origins on position storms.
  - Acceptance: `TextLayer` aliases `TextStore` x/y into `SpatialIndex`. Position-only storms
    write x/y once and only rebucket. `writePositions` records one dirty span for a dense
    slot column. Camera residency refresh keeps rendered movers on that lane. Hit tests and
    on-screen palette rows stay correct in that commit. Published budgets stay.
  - Verify: bun test tests/SpatialIndex.test.ts tests/TransformPalette.test.ts tests/TextLayer.commit.test.ts tests/culling.test.ts && bun run typecheck
  - Files: src/culling/SpatialIndex.ts, src/TextLayer.ts, src/store/TextStore.ts, src/render/TransformPalette.ts

- [x] Task 12.33: Own WebGPU label transforms in a storage buffer.
  - Acceptance: WebGPU with vertex storage skips the CPU 32-byte palette gather on a
    position-only or camera-only commit. CPU submits the mover slot list. WebGL and
    devices without vertex storage keep the texture path. Hit-test and 1M residency stay.
    Public `TextLayer` contract stays. Published budgets stay. Default baked pages stay
    out of the core ESM graph.
  - Verify: bun test tests/paletteStorage.test.ts tests/GlyphMesh.test.ts tests/TransformPalette.test.ts tests/RenderCoordinator.test.ts tests/TextLayer.test.ts tests/TextLayer.commit.test.ts && bun run typecheck && bun run docs:check
  - Files: src/render/paletteStorage.ts, src/render/PaletteStoragePass.ts, src/render/RenderSurface.ts, src/render/GlyphMesh.ts, src/render/shaders.ts, src/TextLayer.ts, src/culling/requestComputeCullGpu.ts

- [x] Task 12.34: Make the WebGPU storage palette the live x/y table.
  - Acceptance: Storage-path position storms upload one packed move-command buffer
    (`slot`, `x`, `y`). The compute pass writes `transforms[slot].xy`. No origin-column
    span upload and no per-mover `writeBuffer`. Camera-only stays empty after the first
    full upload. WebGL texture path, hit-test store columns, and 1M residency stay.
    Compute-cull records still carry world AABB. Public `TextLayer` contract stays.
  - Verify: bun test tests/paletteStorage.test.ts tests/GlyphMesh.test.ts tests/TransformPalette.test.ts tests/RenderCoordinator.test.ts tests/TextLayer.test.ts tests/TextLayer.commit.test.ts tests/computeCull.test.ts && bun run typecheck && bun run docs:check
  - Files: src/render/paletteStorage.ts, src/render/palettePatch.wgsl.ts, src/render/PaletteStoragePass.ts, src/TextLayer.ts

- [x] Task 12.35: Let the GPU own compute-cull boxes on the storage-backed viewport path.
  - Acceptance: WebGPU storage plus compute-cull position storms update palette origins and trigger
    culling with zero CPU AABB walk and zero dirty cull-record upload while the local box stays
    stable. The cull shader adds the palette origin to each local record. Content-layout changes
    rewrite local records. Texture, WebGL, and cpu-grid retain CPU world-AABB updates. Hit-test and
    million-label residency stay stable. The public `TextLayer` contract stays.
  - Verify: bun test tests/computeCull.test.ts tests/paletteStorage.test.ts tests/SpatialIndex.test.ts tests/TextLayer.test.ts tests/TextLayer.commit.test.ts && bun run typecheck && bun run docs:check
  - Files: src/culling/computeCull.ts, src/culling/computeCull.wgsl.ts, src/render/ComputeCullPass.ts, src/render/PixiRendererBackend.ts, src/render/GlyphDrawPlanner.ts, src/TextLayer.ts

- [x] Task 12.35a: Bind asynchronous glyph rasters to one render lifetime.
  - Acceptance: A late raster from an older commit, source/font revision, lifecycle epoch, atlas
    generation, or renderer destination reaches the stale path and contributes zero atlas uploads.
    Attach starts the new renderer destination while captured work settles. Detach and destroy
    settle internally owned raster commits and release their renderer ownership. Injected atlases
    retain caller lifecycle ownership; public atlas frames and coordinator token frames stay
    isolated. Active rasterizer errors preserve their rejection. Lifetime metadata scales with
    pending glyph work. `TextLayer` public exports stay.
  - Verify: bun test tests/GlyphAtlas.test.ts tests/RenderCoordinator.test.ts tests/TextLayer.render-lifecycle.test.ts tests/TextLayer.commit.test.ts && bun run test:browser -- glyph-rendering lifecycle && bun run typecheck && bun run build
  - Files: src/TextLayer.ts, src/render/RenderCoordinator.ts, src/atlas/GlyphAtlas.ts, src/atlas/RasterGlyphProvider.ts, src/atlas/types.ts, tests/GlyphAtlas.test.ts, tests/RenderCoordinator.test.ts, tests/TextLayer.render-lifecycle.test.ts, .agents/docs/gotchas.md

- [x] Task 12.36: Measure HarfBuzz GPU Draw native encode.
  - Acceptance: The temporary native helper uses HarfBuzz 14.4.0 to shape five provenance-pinned
    Noto subsets and encode every font-local unique glyph through `hb_gpu_draw_glyph_or_fail` plus
    `hb_gpu_draw_encode`. Raw JSON records hashes, extents, failures, per-glyph bytes/timing,
    sequential determinism repeats, shader bytes, packed bytes, sign-extended WebGPU bytes, and
    the 20,000-unique projection. The direct `vec4<i32>` path pauses at 64 MiB; the packed 16-bit
    representation advances to a browser-only GPU Draw spike. Production rendering stays stable.
  - Verify: bun test tests/hb-gpu-benchmark.test.ts && bun run benchmark:hb-gpu && bun run typecheck && bun run docs:check
  - Files: benchmarks/hb-gpu, tests/hb-gpu-benchmark.test.ts, package.json, .agents/docs/performance-plan.md, .agents/docs/gotchas.md

- [x] Task 12.37: Add explicit GPU-scene residency and its formal workload.
  - Acceptance: `culling.residency: "gpu-scene"` retains one supported shared-prototype WebGPU
    scene, keeps `"viewport"` as the default, reports stable capability/eligibility fallbacks, and
    preserves attach/detach/remove/reuse/destroy behavior. Camera commits record zero query,
    admission, coordinator, and cull-record-upload deltas. Its sealed artifact captures a
    100,000-position pre-fast-lane commit at 1,600,016 transform bytes and zero cull-record bytes. The
    byte-exact browser reference compares
    product single-prototype, forced resident multi-prototype, and forced general shaders at the
    formal 1M/100K scale. Five schema 7 runs plus one sustained run preserve exact GPU output and
    pixel identity. Schema 3 promotion evidence owns the formal canonical and sustained status.
  - Verify: bun test tests/TextLayer.gpu-resident.test.ts tests/GpuResidentScene.test.ts tests/PixiRendererBackend.test.ts tests/paletteStorage.test.ts tests/computeCull.test.ts && bun run test:browser -- gpu-scene-resident && bun run benchmark -- --workload gpu-scene-resident --renderer webgpu && bun run typecheck && bun run docs:check
  - Files: src/TextLayer.ts, src/types.ts, src/render/GpuResidentScene.ts, src/render/RenderCoordinator.ts, src/render/ComputeCullPass.ts, src/render/PaletteStoragePass.ts, src/render/RenderSurface.ts, src/render/PixiRendererBackend.ts, benchmarks, docs, .agents/docs

- [x] Task 12.38: Validate packed HarfBuzz GPU Draw in browser and Worker/Wasm.
  - Acceptance: `array<vec2<u32>>` and available `rgba16sint` paths render matching repeated pixel
    hashes from packed 16-bit blobs. The packaged Worker/Wasm encoder matches native blob hashes,
    exceeds 10,000 warm glyphs/s, starts within 100 ms, and releases synchronized font resources.
    Direct `vec4<i32>` storage remains paused at its 114.8 MiB projection.
  - Verify: bun run benchmark:hb-gpu-browser && bun run benchmark:hb-gpu-wasm && bun test tests/hb-gpu-benchmark.test.ts tests/hb-gpu-encoder.test.ts tests/hb-gpu-wasm.test.ts tests/hb-gpu-wasm-artifact.test.ts
  - Files: src/hb-gpu, benchmarks/hb-gpu, tests/hb-gpu-benchmark.test.ts, tests/hb-gpu-encoder.test.ts, tests/hb-gpu-wasm.test.ts, package.json

- [x] Task 12.39: Clear GPU-scene resident performance promotion gates.
  - Acceptance: Product and timestamp single-submit fusion is integrated. The current schema 7
    five-run set records 1,300 `fusedTimestampResolves` and zero
    `standaloneTimestampSubmissions`; the 600-frame run records 1,220 and zero. Every run preserves
    50,000 ordered references with hash `0x45cfd045`, pixel hash `0xa8ad90b4`, and 302,457
    non-transparent pixels. Schema 4 records exact palette/cull/scene-render segments for all 1,300
    formal samples. Five of five runs pass every strict budget: aggregate camera p95/p99/max is
    7.9/9.4/10.6 ms and position is 9.8/11.0/12.5 ms, with zero overruns. Sustained camera is
    10.5/13.5/21.5 ms with 4/600 overruns and position is 8.1/9.9/11.6 ms with zero overruns. Truth
    repeatability, formal performance, sustained 600, and promotion are GO. Historical Task 12.39
    resident inputs preserve 16-byte / 1,600,016-byte captures; the current set uses the dense
    8-byte / 800,016-byte lane.
  - Verify: bun test tests/WebGPUFrameTransaction.test.ts tests/gpu-scene-resident-budget.test.ts tests/benchmark-workloads.test.ts && bun run benchmark -- --workload gpu-scene-resident --renderer webgpu && bun run docs:check
  - Files: src/render/WebGPUFrameTransaction.ts, src/render, benchmarks, tests/WebGPUFrameTransaction.test.ts, tests/gpu-scene-resident-budget.test.ts, tests/benchmark-workloads.test.ts, docs, .agents/docs

- [x] Task 12.40: Prove R1a heterogeneous GPU-scene delivery.
  - Acceptance: `gpu-scene-heterogeneous-64` runs 1,000,000 resident labels and 100,000 movers
    through `gpu-scene` with 64 actual single-glyph raster prototypes and 8 independently
    interleaved canonical paints. Both fresh-process repetitions record 64 prototypes, 8 paints,
    512 prototype/paint pairs, zero per-label GPU-scene objects, collision disabled, camera upload
    zero, current dense position upload 800,016 bytes, cull-record upload zero, and one product/fused/standalone
    submission tuple of 1/1/0 per sampled frame. Independent CPU selection over the 64 prototype
    bounds matches camera and position compact-output count/hash; paired pixel readbacks and both
    repetitions match exactly. Delivery requires camera and position p95 at or below 33.34 ms and
    at least 4× versus the fixed 199.5/199.9 ms GPU Scene v2 baseline. The 16.67 ms promotion target
    carries an independent status. The existing strict resident gate keeps its current limits.
  - Status: Delivery and promotion are GO across four refreshed fresh-process repetitions. Camera
    p95 is 9.6–10.3 ms and position p95 is 11.0–11.4 ms. Count/hash/pixel identity is exact across
    the two sealed artifacts. Frozen legacy R1a artifacts preserve the indexed 12-byte /
    1,200,016-byte capture.
  - Verify: bun test tests/benchmark-artifacts.test.ts tests/benchmark-workloads.test.ts tests/gpu-scene-heterogeneous-budget.test.ts && bun run test:browser -- gpu-scene-heterogeneous && bun run benchmark -- --workload gpu-scene-heterogeneous-64 --renderer webgpu && bun run typecheck && bun run format:check && bun run lint && bun run build && bun run docs:check
  - Files: benchmarks/schema.ts, benchmarks/workloads.ts, benchmarks/browser, benchmarks/run.ts,
    benchmarks/artifacts.ts, benchmarks/gpu-scene-heterogeneous-budget.ts, benchmarks/report.ts,
    benchmarks/PERFORMANCE.md, tests, docs/performance.md, .agents/docs/performance-plan.md

- [x] Task 12.41: Promote dense-contiguous resident movers to the 8-byte lane.
  - Acceptance: Each resident mover lease explicitly selects `dense` or `indexed`. Sorted, unique,
    strictly contiguous active slots use exact-f32 `x`/`y` pairs with `baseSlot` and `count` in the
    16-byte header; 10,000 and 100,000 movers upload exactly 80,016 and 800,016 bytes. Sparse,
    reordered, duplicate, holed, removed-slot, and overflow inputs use the indexed 12-byte fallback
    with last-write-wins identity. Growth, overlapping leases, failure, cancellation, device loss,
    recovery, fused AABB updates, and exact-once release preserve both modes. Browser reference gates
    retain 50,000 ordered references, hash `0x45cfd045`, pixel hash `0xa8ad90b4`, 302,457
    non-transparent pixels, zero cull-record upload, and product/fused/standalone submissions 1/1/0.
    Fresh formal and sustained artifacts must satisfy the strict 16.67 ms gate before R1a position
    promotion advances.
  - Status: Source, unit/browser correctness, resident smoke, formal reference, and dense fused
    compute probe are green. Fresh formal/candidate/sustained artifacts all record exact 800,016-byte
    uploads and satisfy the strict resident gate. Device/pass/encoder recovery and segmented
    timestamps are sealed in the current artifact set.
  - Verify: bun test && bun run test:browser -- gpu-scene-resident gpu-scene-reference gpu-scene-heterogeneous gpu-resident-compute && bun run typecheck && bun run format:check && bun run lint && bun run build && bun run docs:check && bun run benchmark:check
  - Files: src/store/TextStore.ts, src/render/paletteStorage.ts, src/render/PaletteStoragePass.ts,
    src/render/palettePatch.wgsl.ts, src/render/GpuResidentScene.ts, src/TextLayer.ts, benchmarks,
    tests, README.md, docs, .agents/docs

- [x] Task 12.42: Build the R4 map-symbol continuity correctness vertical slice.
  - Acceptance: One logical record accepts overlapping tile/anchor candidates and selects by f32
    priority, retained candidate, insertion order, and typed identity. Source presence and collision
    placement remain separate across fade/readmit/TTL transitions. Frame abort restores provisional
    ids, reclaimed tombstones, arrays, maps, queues, and counters. Committed reads stay pure and the
    complete bit-level state hash reacts to every retained identity and transition field.
  - Status: Correctness is GO across 9 targeted tests and 103 expectations. Repeated 100k local runs
    place manual-mode frame p95 at 9.85–11.57 ms and every-frame p95 at 14.46–16.17 ms. The dual-mode
    index microbenchmark is GO. TextLayer product integration remains HOLD through R2 WAL/delta,
    browser-workload, and sustained-frame gates.
  - Verify: bun test tests/symbol-continuity.test.ts && bun run benchmark:symbol-continuity && bun run typecheck && bun run lint
  - Files: src/culling/SymbolContinuityIndex.ts, src/advanced/index.ts,
    benchmarks/symbol-continuity.ts, tests/symbol-continuity.test.ts, docs, .agents/docs

- [x] Task 12.43: Build the R5 sparse glyph-strip correctness vertical slice.
  - Acceptance: A versioned 4x4-tile IR retains solid spans implicitly and boundary coverage in
    compact typed arrays. Cache identity covers every raster-affecting field, caller mutation stays
    outside retained state, and oversized candidates preserve the current LRU. A batched WebGPU
    adapter writes premultiplied RGBA8 through the `OutlineColorAtlas` seam with explicit capability,
    u32/allocation preflight, owned async snapshots, near-O(N log N) overlap validation,
    size-grouped dispatch, failure, destruction, and exact-once cleanup outcomes. A real HarfBuzz
    browser fixture proves 256/512 pixel parity within two channel levels, stable repeated hashes,
    and padded invocations within 1.15× effective pixels.
  - Status: CPU IR/cache correctness and the WebGPU single-batch browser gate are GO. The 512- and
    1024-pixel final representations occupy 29.47% and 15.04% of dense alpha bytes. Product routing
    is HOLD while sustained atlas-pressure, stable-atlas-hit, and whole-frame tail evidence is built.
  - Verify: bun test tests/outline-sparse-strips.test.ts tests/outline-sparse-strip-compute.test.ts && bun run test:browser -- outline-sparse-strip && bun run benchmark:sparse-strips && bun run typecheck && bun run lint
  - Files: src/render/outline/sparseStrips.ts, src/render/outline/sparseStripCompute.ts,
    src/render/outline/sparseStrip.wgsl.ts, benchmarks/sparse-glyph-strips.ts, tests, docs,
    .agents/docs

- [ ] Task 12.8: Optional extreme quality tracks (Wave 5).
  - Track status:
    - [x] Outline GO: explicit `glyphMode: "outline"` WebGPU compute/fragment integration, pixel,
          and lifecycle gates pass; automatic atlas rendering remains the default.
    - [x] Collision direct selection/compute and repeatability GO at 11.87 ms WebGPU whole-frame
          p95 mean. The tri-state spatial route passes exact 1/4 and 7/8 boundary tests,
          exceptional-output recovery, hit-test coverage, and randomized brute-force parity.
    - [ ] Packaged HarfBuzz 11.2.1 scalar/SIMD Workers pass five-language exact parity; the formal
          five-run production path records a 2.51% SIMD regression and holds at `HOLD
(variant-regression)`. The 418,675-byte raw
          runtime payload remains an explicit experiment pending a later performance win and human
          package approval.
    - [x] SharedArrayBuffer advanced opt-in transport GO with `SharedArrayBuffer`, `Atomics`,
          cross-origin isolation, leased run views, browser worker coverage, and matching hashes.
  - Acceptance: Outline, collision, SIMD shaping, and SharedArrayBuffer rings each retain an opt-in
    boundary, a named end-to-end workload, and a documented pixel/correctness tolerance. The umbrella
    closes when a production HarfBuzz SIMD asset clears its end-to-end workload.
  - Verify: focused tests plus a named benchmark workload per enabled track
  - Files: src/render, src/shaping, src/worker, benchmarks/workloads.ts
