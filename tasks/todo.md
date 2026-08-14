# pixi-glyphflow 1.0 task ledger

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

- [ ] Task 7.2: Publish and verify 1.0.0.
  - Acceptance: CI, signed tag, npm provenance, GitHub Release, and public-registry consumer checks all succeed.
  - Verify: npm view plus independent runtime, browser, and TypeScript consumer probes.
  - Files: .github/workflows/release.yml, scripts/package-smoke.ts
