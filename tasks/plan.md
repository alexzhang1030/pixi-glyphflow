# Implementation plan: pixi-glyphflow

## Overview

Replace the 0.0.1 object-per-label reference backend with a dense, batch-oriented text system while keeping one small TextLayer interface. Delivery follows risk-first vertical slices: data and public behavior, font and layout correctness, instanced rendering, asynchronous shaping and atlases, browser evidence, documentation, then release.

## Architecture decisions

- TextLayer and FontRegistry are the external seams.
- TextStore uses generation-checked numeric identities, geometric capacity, dense typed data, and an explicit dirty journal.
- PixiJS BitmapFontManager provides the system-font and prebuilt-font fast path behind a compatibility adapter.
- Registered binary fonts activate harfbuzzjs lazily and shape in a worker.
- One logical GlyphRun and GlyphInstance contract feeds WebGL and WebGPU.
- Renderer integration uses PixiJS Geometry, Buffer, Mesh, Shader, Texture, and bitmap-font interfaces. Advanced code stays under src/pixi/compat.
- Runtime atlas modes include MSDF, SDF, alpha, and color. Complete generations swap at frame boundaries.
- Performance claims come from tagged raw benchmark artifacts under benchmarks/results.

## Dependency graph

    Product specification
      -> Public types and TextStore
        -> TextLayer CRUD and commit
          -> FontRegistry and layout
            -> Atlas and instance stores
              -> WebGL and WebGPU renderer adapters
                -> Culling, effects, accessibility
                  -> Browser correctness and benchmarks
                    -> English documentation and release

## Phase 0: Product contract and clean context

- Rewrite the durable product specification in English.
- Remove copied source-project records and identifiers.
- Establish the task graph, testing seams, performance budgets, and release evidence.

### Checkpoint

- Repository search returns zero source-project identifiers.
- Markdown, PCR routing, and task files are English.
- Existing package checks remain green.

## Phase 1: Core state and ergonomic interface

- Implement TextStore with stable generation-checked IDs, geometric capacity, free-list reuse, immutable snapshots, and dirty domains.
- Replace the POC mutation surface with the 1.0 CRUD, bulk operations, clear, compact, and commit semantics.
- Expand diagnostics for work counts, bytes, capacity, and timings.

### Checkpoint

- Public-seam tests cover CRUD, bulk behavior, stale identities, no-op commits, compact, and lifecycle.
- A 1,000,000-label CPU benchmark records creation, 100,000-mutation, commit, removal, and memory timings in isolated sample processes.
- Core source builds and package smoke passes.

## Phase 2: Fonts, shaping, and layout

- Add FontRegistry for system, prebuilt bitmap, and binary font sources.
- Implement immutable GlyphRun and PositionedRun contracts.
- Add browser bitmap shaping and layout through the PixiJS compatibility adapter.
- Add wrapping, alignment, line height, letter spacing, truncation, bidi metadata, and bounds.
- Add HarfBuzz worker shaping for registered binary fonts and trusted shaped runs.

### Checkpoint

- Latin, CJK, Arabic, Devanagari, emoji, bidi, fallback, and OpenType fixtures pass.
- Cache keys invalidate on every relevant font and layout revision.
- Stale worker results are rejected by behavior tests.

## Phase 3: Atlas and instanced renderer

- Add page packing, residency, pinning, byte ceilings, eviction, and complete generation swaps.
- Add prebuilt MSDF/SDF pages plus dynamic alpha and color raster pages.
- Add compact glyph instances, label transform storage, dirty range coalescing, and explicit compaction.
- Add one instanced Mesh path with paired GLSL and WGSL programs.
- Add WebGL partial uploads and WebGPU staging uploads behind renderer adapters.

### Checkpoint

- WebGL and WebGPU render equivalent fixtures within published tolerances.
- Static frames report zero text-system work after warm-up.
- Lifecycle tests cover sibling layers, sibling applications, detach, reattach, and destruction.
- Atlas pressure remains under the configured byte ceiling.

## Phase 4: Product behavior

- Add spatial culling, local/world bounds, and topmost hit testing.
- Add fill, stroke, shadow, blend, visibility, z order, anchor, scale, and rotation.
- Add optional accessibility mirroring for selected labels.
- Add explicit fallback diagnostics and capability policy.
- Add an optional pixi-viewport 6 binding with coalesced visible-bounds updates and complete listener teardown.

### Checkpoint

- Browser interaction and visual tests cover all appearance and transform combinations.
- Culling and hit-testing fixtures match known visible sets.
- Accessibility mirror updates are deterministic and incremental.
- Drag, deceleration, wheel zoom, pinch zoom, and camera rotation preserve label revisions and emit deterministic visible sets.

## Phase 5: Performance laboratory

- Build equal-content Text, BitmapText, HTMLText, and glyphflow fixtures.
- Record cold and warm frame timing, update timing, draw calls, upload bytes, memory, cache, atlas, and culling metrics.
- Add million-label full-visibility, million-label viewport, dynamic-counter, viewport-drag, viewport-zoom, position-storm, multilingual-stream, scale-scan, atlas-pressure, and static-HUD workloads.
- Compare repeated samples against run-to-run variance and retain only measured optimizations.
- Enforce core bundle and benchmark budgets in CI.

### Checkpoint

- Raw JSON and generated reports exist for every workload.
- Million-label and dynamic-counter p95 meet the 0.75 baseline ratio.
- Every supported workload meets the 1.00 baseline ratio.
- Reference-hardware update, memory, and steady-state budgets pass.
- pixi-viewport interaction and position-storm frame budgets pass.

## Phase 6: English product documentation

- Replace the POC README with 1.0 installation, quick start, recipes, support matrix, and diagnostics.
- Add getting-started, API, fonts, shaping, architecture, performance, accessibility, migration, and release guides.
- Add runnable examples and a browser playground.
- Add a pixi-viewport drag, pinch, wheel, deceleration, rotation, and moving-label stress playground.
- Generate API documentation from public TypeScript declarations.
- Update CONTRIBUTING, CHANGELOG, PCR records, and package metadata.

### Checkpoint

- Every documentation file is English.
- Repository search returns zero removed source-project terms.
- Every public export has reference documentation and a runnable example.

## Phase 7: Release 1.0.0

- Run the complete release gate from a clean install.
- Commit release metadata and obtain GitHub CI proof.
- Create and push the signed v1.0.0 tag.
- Publish with npm Trusted Publishing and provenance.
- Create the GitHub Release from the verified changelog.
- Install pixi-glyphflow@1.0.0 from the public registry in an independent consumer and rerun runtime, browser, and TypeScript smoke checks.

## Phase 8: Interactive documentation site

- Build one Nuxt SSR page with installation, viewport integration, performance evidence, architecture, API entry points, and guide routing.
- Run a client-only TextLayer demo with 1,000,000 resident labels, 100,000 packed position updates every 100 milliseconds, and a pixi-viewport camera.
- Register custom Noto subsets for CJKV, Arabic, Devanagari, Hebrew, and Thai, then exercise Vietnamese, Greek, Cyrillic, emoji, and system fallback.
- Bundle the dynamic MSDF worker and WebAssembly module through explicit Vite asset URLs.
- Let readers force WebGL 2 or WebGPU and rebuild the complete renderer, viewport, layer, binding, and stress workload in place.
- Preserve drag, deceleration, wheel, pinch, rotation, keyboard, reduced-motion, and complete renderer teardown behavior.
- Build the root package before every site development, type-check, generation, and production command.
- Verify Chrome behavior and horizontal fit at 320, 768, 1024, and 1440 pixels.

### Checkpoint

- `bun run site:typecheck`, `bun run site:build`, and `bun run site:test` pass from the workspace root.
- The live demo reports 1,000,000 resident labels, five custom fonts, the exact active renderer adapter, and a drained initial glyph queue without browser console errors.
- WebGPU-capable Chrome sessions run the position storm and camera controls on both adapters; other sessions expose the capability state.
- The site workspace stays outside the npm publication files and inside the frozen Bun install graph.

## Phase 9: Label groups and basic layout controls

- Add independently created, layer-local TextGroupId values and sparse label membership.
- Compose per-label and per-group visibility through one TextLayer commit seam.
- Add basic vertical-rl glyph flow while retaining PixiJS font weight and fill styling.
- Document the public interface, lifecycle rules, and runnable examples.

### Checkpoint

- Public-seam tests cover unique group identities, membership changes, group removal, and composed visibility.
- Layout tests cover upright top-to-bottom glyph placement and right-to-left newline columns.
- Style tests cover font-weight and fill updates through the existing style dirty domain.
- Focused tests, type checking, formatting, documentation checks, and the package build pass.

## Phase 10: Core startup bundle budget

- Move the default bitmap adapter, HarfBuzz worker shaper, and raster glyph provider behind shared
  first-use imports.
- Preserve constructor injection so custom backends retain their direct execution path.
- Measure each split against the generated core ESM gzip artifact.

### Checkpoint

- `bun run benchmark:check` keeps the core ESM entry below 40 KiB gzip.
- Root browser coverage, the custom-font site suite, and destruction paths pass with lazy defaults.

## Phase 11: Progressive examples and the 1.1.0 release

- Add site examples that begin with the required `text` field and progressively introduce groups,
  per-ID visibility, vertical layout, font weight, and fill.
- Promote post-1.0 work into a curated 1.1.0 changelog and align package and site versions.
- Land the release commit through GitHub CI, create the signed `v1.1.0` release tag, publish through
  npm Trusted Publishing, and verify an independent registry install.

### Checkpoint

- Site type checking and browser acceptance pass at 320, 768, 1024, and 1440 pixels.
- `bun run release:check` passes from the versioned commit.
- GitHub Release, tag, package metadata, npm provenance, and a clean external consumer agree on
  version 1.1.0.

## Phase 12: Extreme performance program

Research record: [`.agents/docs/performance-plan.md`](../.agents/docs/performance-plan.md).

The 1.1.0 suite already meets the formal million-label frame budgets. The next program attacks the unbudgeted atlas-pressure cliff, the dynamic-counter wall, linear culling, duplicated transform storage, and the synthetic 8M-glyph probe. Public budgets stay until a human accepts tighter numbers.

- Wave 0: `million-live` coordinator-mesh workload, split CPU/upload/GPU timers, and
  `TextLayer.stats` phase timers are in source. `atlas-pressure` frame p95 is measured, not failed,
  against the 1.1.0 artifact.
- Wave 1: Skyline atlas + O(1) LRU, typed instance writes, hierarchical hash grid, packed numeric fills.
- Wave 2: intern shared styles, position-only palette patches, `Float32` z-index, 32-byte
  fill-only GPU transforms, packed CPU store columns, and 24-byte live instances are in
  source. Published instance, transform, and store ceilings stay until new artifacts exist.
- Wave 3: stable WebGPU compute compaction and indirect draw are in source for the direct
  natural-order mesh. WebGL 2 and multi-segment meshes keep the CPU grid. Transform storage buffers
  and atlas texture arrays remain follow-up work.
- Wave 4: TinySDF / prebake / four-channel rect uploads, duplicate-string layout intern,
  shared prototype instance ranges, the first-seen admit lane, the broadcast content lane,
  spatial `placeMany`, the prototype-fetch instance mesh, compute-cull ring-only unique
  deferral, parallel admit-group prepare, and TinySDF same-size miss batch plus FontFace intern
  are in source. Tight-view unique raster (layout count per unseen string, EDT still per glyph)
  and a remaining upload budget stay open.
- Wave 5: optional Slug outline mode, collision, SIMD, SharedArrayBuffer ring.

### Checkpoint

- Atlas-pressure frame p95 enters the 16.67 ms gate after Wave 1.
- Dynamic-counter and camera workloads beat 1.1.0 by more than run-to-run variance.
- Core gzip is still measured; the 40 KiB CI fail is deferred.
- WebGL 2 remains inside current budgets when a WebGPU-only path is added.
- Raw artifacts and the generated report are overwritten from isolated Chrome runs.

## Risks and mitigations

| Risk                                     | Impact | Mitigation                                                                                       |
| ---------------------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| PixiJS advanced interface drift          | High   | Isolate compatibility code and test exact plus latest PixiJS 8.                                  |
| WebGPU device variance                   | High   | Keep one logical contract, WebGL coverage, capability diagnostics, and sequential probes.        |
| Complex-script shaping errors            | High   | Use HarfBuzz glyph and cluster fixtures plus visual goldens.                                     |
| Atlas fragmentation or stale generations | High   | Enforce byte ceilings, pin visible entries, and validate immutable generation identity.          |
| Large WebAssembly startup cost           | Medium | Lazy loading, worker initialization, prebuilt-font fast path, and separate bundle reporting.     |
| Benchmark noise                          | Medium | Fixed workloads, warm-up separation, repeated samples, raw artifacts, and variance thresholds.   |
| Package export or asset breakage         | High   | Packed and public-registry consumer smoke tests for core, worker, register, and shaping exports. |

## Release rollback

- Keep v0.0.1 and v1.0.0 installable.
- Publish 1.1.0 after all gates pass.
- Deprecate a defective release with a precise message and publish the corrected patch release.
- Preserve raw artifacts, tag evidence, and package integrity for diagnosis.
