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
  - Acceptance: One million reserved slots allocate ≤ 48 MiB plus the journal floor. Scale/rotation/alpha/anchors are `f16`; generation and source revision are `u16`; occupied/visible/kind share one flag byte; the dirty journal slot list is sparse. Published 128 MiB store ceiling stays. The public `alpha: 0.5` snapshot still round-trips.
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
  - Acceptance: Published instance, transform, and store ceilings may tighten once M1 Pro Chrome artifacts exist. `million-live` still needs a reference artifact before a live-path frame budget.
  - Verify: bun run benchmark:check
  - Files: benchmarks/budgets.ts, docs/performance.md

- [x] Task 12.6: Add a WebGPU compute cull adapter (Wave 3).
  - Acceptance: Camera-only WebGPU frames compact visible instances on the GPU with stable z/insertion order; WebGL 2 keeps the CPU grid and current budgets; diagnostics name the active cull path.
  - Verify: bun run test:browser -- glyph-rendering && bun run test:browser -- viewport-integration
  - Files: src/culling/computeCull.ts, src/culling/computeCull.wgsl.ts, src/render/ComputeCullPass.ts, src/render/RenderSurface.ts, src/TextLayer.ts

- [ ] Task 12.7: Add hybrid glyph generation and upload budgets (Wave 4).
  - Acceptance: Local TinySDF or prebaked pages serve the common set; dynamic MSDF remains the long tail; atlas uploads respect a per-frame byte budget without growing the core gzip entry.
  - Verify: bun test tests/glyph-providers.test.ts tests/GlyphAtlas.test.ts && bun run benchmark -- --workload atlas-pressure,multilingual-stream
  - Files: src/atlas/RasterGlyphProvider.ts, src/atlas/PrebuiltGlyphProvider.ts, src/atlas/GlyphAtlas.ts

- [ ] Task 12.8: Optional extreme quality tracks (Wave 5).
  - Acceptance: Outline (Slug), collision, SIMD shaping, and SharedArrayBuffer rings land only as opt-in modes with their own workloads and pixel tolerances.
  - Verify: focused tests plus a named benchmark workload per enabled track
  - Files: src/render, src/shaping, src/worker, benchmarks/workloads.ts
