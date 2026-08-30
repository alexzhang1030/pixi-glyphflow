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
  natural-order mesh. WebGL 2 and multi-segment meshes keep the CPU grid. Atlas pages bind as
  two texture arrays. WebGPU transform storage owns live x/y. The explicit
  `culling.residency: "gpu-scene"` lane retains up to 64 prototypes × 8 paints across 512 bins,
  patches transform origins and absolute cull AABBs in one fused pass, and defers CPU spatial
  rebucketing until a CPU query.
- Wave 4: TinySDF / prebake / four-channel rect uploads, duplicate-string layout intern,
  shared prototype instance ranges, the first-seen admit lane, the broadcast content lane,
  spatial `placeMany`, the prototype-fetch instance mesh, compute-cull ring-only unique
  deferral, parallel admit-group prepare, and TinySDF same-size miss batch plus FontFace intern
  are in source. Position storms write store x/y once and rebucket a derived spatial origin.
  Unique admit groups that share a fill write one palette column. Optional
  `pixi-glyphflow/prebuilt` (`uiSdfPrebuilt`) bakes a coarse ASCII SDF outside the core
  graph. Physical TinySDF/MSDF fields intern at `distanceFieldMinFontSize` so clamped
  logical sizes share one generate. Tight-view unique raster still generates unseen ink
  in the seeing commit. The off-screen admit budget (`offscreenAdmitBudgetBytes`) gates
  ring intern hits and same-commit ring copies. Atlas texel uploads for already-instanced
  glyphs stay ungated.
- Wave 5 stays an open umbrella with explicit per-track decisions. HarfBuzz GPU packaged
  Worker/Wasm and packed browser storage are GO; the direct `vec4<i32>` route waits at its separate
  quality/performance gate. Outline compute/fragment integration and lifecycle are GO. Advanced SAB
  transport is GO with `SharedArrayBuffer`, `Atomics`, and cross-origin isolation. Collision direct
  selection/compute and whole-frame repeatability are GO at 11.87 ms mean WebGPU p95. Packaged
  HarfBuzz worker SIMD is HOLD after a 2.51% variant regression.
- Wave 5 native/browser checkpoint: HarfBuzz 14.4.0 shapes 151 glyphs and encodes 114 font-local
  unique blobs with zero draw/encode failures and stable repeated hashes. Packed 16-bit storage
  projects to 57,409,123 bytes and passes browser rendering plus the 64 MiB gate. The packaged
  Worker/Wasm encoder passes native parity, 10,000 glyph/s, and 100 ms cold-start gates. Direct
  WebGPU `vec4<i32>` storage projects to 114,818,246 bytes and stays PAUSE.
- R4 map-symbol continuity now has explicit logical/candidate identity, deterministic overlap
  selection, separated source/placement epochs, fade/readmit/TTL, staged abort, committed-read
  isolation, a bit-level state hash, u32 exhaustion, and a 1,048,576-record hard ceiling. Targeted
  correctness is GO. Repeated 100k local runs place manual-mode frame p95 at 9.85–11.57 ms and
  every-frame p95 at 14.46–16.17 ms. The dual-mode index microbenchmark is GO. TextLayer product
  integration remains HOLD through R2 WAL/delta, browser-workload, and sustained-frame gates.
- R5 sparse strips now have a versioned two-pass typed IR, byte-bounded defensive LRU, physical
  pixel buckets, checked u32/allocation preflight, owned pre-await snapshots, near-O(N log N)
  overlap validation, exact-size dispatch groups, and an independent WebGPU `OutlineColorAtlas`
  adapter. Real Chrome proves 256/512 HarfBuzz pixel parity within two channel levels, stable
  repeated hashes, and dispatch padding within 1.15× effective pixels. CPU representation is 29.47%
  of dense alpha bytes at 512 pixels and 15.04% at 1024 pixels. Product routing remains HOLD through
  the sustained atlas-pressure, stable-atlas-hit, and whole-frame tail gates.
- Correctness foundation for the next renderer generation: one internal render token now binds
  every asynchronous cold glyph request to its layer epoch, coordinator ticket, source/font
  revisions, atlas generation, and renderer destination. TextLayer lifecycle transitions retire
  captured render work while keeping the public TextLayer interface stable. Internally owned
  raster work settles through that stale path after attach, detach, or destroy. Injected atlases
  keep caller lifecycle ownership and isolate public frame commits from coordinator frame tokens.

### Checkpoint

- Atlas-pressure frame p95 enters the 16.67 ms gate after Wave 1.
- Dynamic-counter and camera workloads beat 1.1.0 by more than run-to-run variance.
- Core gzip is still measured; the 40 KiB CI fail is deferred.
- WebGL 2 remains inside current budgets when a WebGPU-only path is added.
- Raw artifacts and the generated report are overwritten from isolated Chrome runs.
- GPU-scene resident truth repeatability is GO across five schema 7 1M-label / 100K-mover runs.
  Each reads 50,000 compact references with hash `0x45cfd045`, pixel hash `0xa8ad90b4`, and 302,457
  non-transparent pixels. Formal telemetry is 1,300 readbacks / 1,300 fused timestamp resolves /
  zero standalone submissions. Aggregate camera p95/p99/max is 7.9/9.4/10.6 ms and position is
  9.8/11.0/12.5 ms, with zero overruns in both 600-frame formal sets. Five of five runs pass every formal
  budget. The independent sustained run records 1,220/1,220/0 telemetry, camera 10.5/13.5/21.5 ms
  with 4/600 overruns, and position 8.1/9.9/11.6 ms with zero overruns. All 1,300 formal segmented samples are
  exact. Sustained 600, formal performance, and overall promotion are GO.
- Current resident movers use a dense 8-byte exact-f32 fast path for sorted, unique, strictly
  contiguous active slots and an indexed 12-byte fallback for sparse, reordered, duplicate, and
  holed inputs. The 16-byte header carries `baseSlot` and `count`, so dense 10,000- and
  100,000-mover waves upload exactly 80,016 and 800,016 bytes. Fresh formal artifacts own the R1a
  position-promotion decision; current artifacts use 8-byte dense uploads, historical R1a preserves
  12-byte / 1,200,016-byte captures, and historical resident artifacts preserve 16-byte captures.
- Palette, compute, and frame-transaction resources follow the live `GPUDevice`, pass epoch, and
  encoder epoch. Loss blocks re-entry on
  that identity; replacement rebuilds pipelines, Pixi buffers and hooks, full cull records, and
  resident local bounds before recovery is acknowledged. Stale epoch callbacks release ownership
  while current callbacks alone publish sync and failure state.
- Late raster, font revision, destination, attach, detach, and destroy fixtures publish zero stale
  atlas uploads and expose rejected completions through coordinator telemetry. Active provider
  errors preserve their rejection, and token lifetime storage stays proportional to pending glyphs.
- `bun run benchmark:hb-gpu` compiles its native helper in a temporary directory, validates all
  five provenance hashes, records per-glyph extents/bytes/timing, and writes the pinned raw artifact.

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
