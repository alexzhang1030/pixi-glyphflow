# pixi-glyphflow 1.0 product specification

Status: unstamped project specification dated 2026-08-15.

## Assumptions

1. Version 1.0 targets PixiJS 8.19 and later compatible PixiJS 8 releases.
2. The primary users render dense labels, dashboards, maps, games, and data visualizations in modern browsers.
3. The public interface stays small while shaping, layout, atlas management, culling, upload scheduling, and renderer selection remain internal.
4. WebGL2 is the compatibility baseline. WebGPU uses the same logical glyph-instance contract and activates through capability detection.
5. The release keeps the current UNLICENSED legal state until a human selects a license.
6. Performance claims require raw benchmark artifacts from the tagged source and a real browser renderer.
7. The optional pixi-viewport integration targets pixi-viewport 6 on PixiJS 8 and remains isolated from the core entry.

## Objective

pixi-glyphflow is a high-throughput text layer for PixiJS v8. One scene object owns many labels, shares font and atlas resources, performs incremental work, and submits compact glyph batches through WebGL or WebGPU.

Version 1.0 succeeds when applications can:

- retain and render 1,000,000 labels through one TextLayer, including a full-visibility stress fixture with 8,000,000 representative glyphs;
- update dynamic strings and transforms through stable label identities and one commit boundary;
- sustain viewport drag, deceleration, wheel zoom, pinch zoom, camera rotation, and 100,000 real position mutations per commit;
- use Latin, CJKV regional forms, Arabic, Devanagari, Hebrew, Thai, emoji, bidirectional text, OpenType features, and font fallback;
- choose prebuilt bitmap fonts, dynamic browser rasterization, or registered binary fonts;
- observe renderer, shaping, cache, atlas, culling, draw, upload, and fallback behavior;
- install the public package with PixiJS as its only required peer dependency.

## Scope boundary

Version 1.0 covers rendered text labels, layout, effects, visibility, hit bounds, optional accessibility mirroring, and font resources. Editable text input, HTML/CSS layout, DOM-first rendering, and document-editor semantics live outside this package.

## Public interface

TextLayer is the primary deep module. Callers learn label mutation, commit, font registration, renderer attachment, diagnostics, and lifecycle. Internal modules retain shaping, packing, batching, and upload policy.

### Example

    import { Application } from "pixi.js";
    import { TextLayer } from "pixi-glyphflow";

    const app = new Application();
    await app.init({ resizeTo: window });

    const layer = new TextLayer({
      renderer: app.renderer,
      glyphMode: "auto",
      atlas: { maxBytes: 64 * 1024 * 1024 },
      culling: { enabled: true, padding: 32 },
    });

    await layer.fonts.register({
      family: "Inter",
      source: new URL("./Inter.woff2", import.meta.url),
    });

    app.stage.addChild(layer);

    const fps = layer.create({
      text: "上海 120 FPS",
      x: 24,
      y: 24,
      style: {
        fontFamily: ["Inter", "sans-serif"],
        fontSize: 18,
        fill: 0xffffff,
      },
    });

    layer.update(fps, { text: "上海 121 FPS" });
    await layer.commit();

### TextLayer operations

| Operation | Contract |
| --- | --- |
| constructor(options) | Creates an empty scene object. Renderer attachment may occur here or through attach. |
| create(spec) | Adds one label and returns a stable layer-local TextId. |
| createMany(specs) | Adds a batch with one validation pass and returns IDs in input order. |
| get(id) | Returns an immutable label snapshot or undefined. |
| has(id) | Checks current identity validity. |
| update(id, patch) | Applies a partial mutation and records the minimal dirty domain. |
| updateMany(entries) | Applies a batch with one journal publication. |
| createGroup() | Creates one layer-local group identity. |
| hasGroup(group) | Checks current group identity validity. |
| setGroupVisible(group, visible) | Applies one group visibility mask and returns the effective label change count. |
| removeGroup(group) | Retires one group identity, retains its labels, and clears their membership. |
| showAll() | Sets every current label visible through one columnar pass and returns the change count. |
| hideAll() | Sets every current label hidden through one columnar pass and returns the change count. |
| remove(id) | Removes one label and returns whether it existed. |
| removeMany(ids) | Removes a batch and returns the removal count. |
| clear() | Removes every label and retires unreferenced resources. |
| commit() | Publishes accepted mutations as one monotonic TextRevision after required async work. |
| compact() | Rebuilds sparse CPU and GPU storage during an explicit maintenance point. |
| updatePositions(ids, positions) | Applies packed x/y coordinates to an identity batch with one validation and journal publication. |
| attach(renderer) | Creates or reuses renderer-owned resources and selects an adapter. |
| detach() | Releases renderer-owned resources while retaining accepted label state. |
| destroy(options) | Releases labels, workers, atlases, buffers, meshes, and renderer associations. |
| stats | Returns an immutable diagnostics snapshot. |

Repeated commit calls without accepted mutations return the current revision and schedule zero shaping, layout, atlas, or instance work.

Each label source revision advances for text or style changes. Transform-only updates preserve the source revision, allowing high-frequency position, rotation, scale, alpha, and visibility changes to reuse shaped runs and atlas entries.

### FontRegistry operations

| Operation | Contract |
| --- | --- |
| register(options) | Loads a binary font, prebuilt PixiJS bitmap font, or explicit glyph provider. |
| registerFallback(name, families) | Defines a stable fallback chain and increments its revision. |
| unregister(family) | Retires the font after committed labels release their references. |
| has(family) | Checks current font availability. |
| clear() | Retires every registry-owned font and shaping resource. |
| stats | Reports registered fonts, bytes, cache entries, and worker state. |

Binary font registration loads HarfBuzz on demand. A system-font path uses PixiJS bitmap-font layout and browser rasterization. A prebuilt font path reuses supplied SDF, MSDF, alpha, or color pages.

Fallback aliases expand recursively and preserve their declared order. Binary candidates must cover every glyph in a shaped label. Language, script, direction, feature, and variation overrides live in a sparse TextId side table so the million-label fixed store keeps its reference-slot budget.

### Trusted run operation

High-frequency producers may submit an immutable TrustedGlyphRun containing glyph IDs, positioned advances, cluster boundaries, exact bounds, font revision, and atlas identity. The caller owns validation before submission. The layer adopts the typed arrays in constant time until their label changes or disappears.

## Label model

`TextLabelSpec.text` is the required creation field. Geometry uses origin and unit defaults,
visibility defaults to true, and group, layout, style, and shaping fields remain optional. Updates
may introduce or clear those optional fields through the stable `TextId`.

### Geometry and visibility

- x and y
- scaleX and scaleY
- rotation in radians
- anchorX and anchorY
- alpha and visible
- zIndex
- an optional layer-local TextGroupId created by TextLayer.createGroup

Label visibility and group visibility compose as `labelVisible && groupVisible`. Group visibility
changes preserve each member label's local `visible` value. Group identities are opaque values
generated by their owning TextLayer. Removing a group retains its labels and clears their group
membership.

### Text and layout

- text
- font family fallback list
- font size, weight, style, stretch, and variation axes
- language, script, direction, and OpenType features
- letter spacing and line height
- wrap width and word-break policy
- alignment
- maximum lines and ellipsis policy
- horizontal-tb or basic vertical-rl writing mode

The basic vertical mode stacks upright glyphs from top to bottom. Explicit line breaks create
columns ordered from right to left. Font weight and fill color continue to use PixiJS
`TextStyleOptions` so style updates share the established style dirty domain.

### Appearance

- fill color
- optional stroke color and width
- optional shadow color, alpha, offset, and blur class
- per-label blend mode
- glyph mode selection: auto, msdf, sdf, alpha, or color

Every numeric input must be finite. Sizes and capacities must be positive and bounded. Unknown or stale identities return documented results or throw documented errors consistently.

## Architecture

| Module | Interface responsibility | Implementation responsibility |
| --- | --- | --- |
| TextLayer | Label mutation, commit, scene transform, lifecycle, and diagnostics | Coordinates complete revisions and owns internal modules. |
| TextStore | Stable identities and accepted label snapshots | Dense slots, generation checks, geometric growth, free-list reuse, and dirty journal. |
| FontRegistry | Font and fallback registration | Binary bytes, hashes, variation defaults, reference counts, and lazy adapters. |
| Shaper | Text plus font context to GlyphRun | HarfBuzz worker, script runs, bidi ordering, clusters, positions, and cache. |
| LayoutEngine | GlyphRun plus layout options to PositionedRun | Wrapping, alignment, baselines, truncation, bounds, and immutable cache. |
| GlyphAtlas | GlyphKey to resident AtlasEntry | Pages, packing, raster or distance field work, pinning, eviction, and generations. |
| GlyphInstanceStore | PositionedRun to renderer-ready ranges | Compact instances, stable capacity, dirty coalescing, replacement, and compaction. |
| SpatialIndex | Label bounds to visibility set | Incremental bounds updates and viewport culling. |
| RendererAdapter | Shared upload and draw contract | WebGL buffer updates or WebGPU staging and copy scheduling. |
| AccessibilityAdapter | Selected label snapshots to semantic mirror | DOM nodes, roles, bounds, focus order, and incremental updates. |

The external seam sits at TextLayer and FontRegistry. Renderer adapters form an internal seam because WebGL and WebGPU are both concrete implementations.

### Current GPU-scene contract

`culling.residency: "gpu-scene"` is the explicit bounded-scene WebGPU lane. It requires compute
culling, storage-palette support, collision disabled, dense monotonic slots, fill-only styling,
unit transforms, zero anchors and z, alpha 1, and normal blending. `GpuSceneCompiler` retains up to
64 exact rendered prototypes and 8 canonical paints, partitions the scene into at most 512
prototype/paint columns, and extends that generation through compatible monotonic appends.

Sorted, unique, strictly contiguous active movers use the dense 8-byte exact-f32 ABI plus a
16-byte `baseSlot`/`count` header, producing 800,016 bytes for 100,000 movers. Sparse, reordered,
duplicate, and holed inputs use the indexed 12-byte fallback with last-write-wins identity. One
fused product command encoder orders palette/AABB moves, compute culling, segmented timestamp
queries, and Pixi rendering. GPU resources and callbacks belong to explicit device, pass, and
encoder epochs; replacement rebuilds current resources and retires stale work within its captured
epoch.

## Shaping and layout

The shaping cache key contains:

    text + font revision + size + variation axes + features
    + language + script + direction + fallback revision

The layout cache key additionally contains:

    wrap width + line height + alignment + letter spacing
    + word break + maximum lines + ellipsis policy

HarfBuzz runs in a worker for registered binary fonts and returns transferable typed arrays. The browser bitmap path serves system fonts and color grapheme clusters. Prebuilt bitmap fonts serve the lowest-startup-cost path. Dynamic MSDF rasterization uses exact HarfBuzz glyph IDs, remaps contextual or localized alternates in temporary font clones, serializes mutable font state inside each worker, and oversamples small glyphs at a 48px minimum while retaining logical geometry through packed raster scales.

Every async request carries label generation, label revision, font revision, shaping key, layout key, atlas generation, and destination identity. A complete previous generation remains visible until the replacement commits at a frame boundary.

## Atlas and glyph modes

| Mode | Primary workload | Page format |
| --- | --- | --- |
| MSDF | Scalable UI and wide zoom ranges | RGB or RGBA distance field |
| SDF | Compact monochrome sets | Single-channel distance field |
| Alpha | Native-size CJK and outline-rasterized glyphs | Single-channel coverage |
| Color | Emoji and color fonts | Premultiplied RGBA |

Atlas behavior:

- fixed power-of-two page sizes;
- configurable total byte ceiling;
- visible and pending glyph pinning;
- least-recently-used eviction among unpinned entries;
- fragmentation telemetry and bounded repack generations;
- frame-boundary generation swaps;
- rectangular texture uploads with a per-frame byte budget;
- deterministic failure and fallback counters.

## Instance and transform storage

Glyph instances target at most 32 bytes each, excluding shared atlas pages and the label transform palette. Label position, scale, rotation, alpha, visibility, and z order live in dense per-label storage. Layer camera motion stays in the PixiJS scene transform.

Storage rules:

- capacities grow geometrically;
- normal commits preserve buffer identity;
- dirty ranges coalesce before upload;
- explicit compact rebuilds fragmented ranges;
- a fourfold live-size reduction permits shrinkage;
- one spare chunk may remain;
- steady-state frames submit zero buffer updates.

## Rendering

One instanced quad geometry serves every glyph. Stable segments group glyphs by blend mode, mask, and effect state while preserving application order. Atlas pages are layers in two texture arrays (R8 and RGBA8), so page changes stay in the same instanced draw.

The WebGL adapter uses offset-aware buffer updates and instanced indexed draws. The WebGPU adapter uses a bounded mapped staging ring and copy submissions before rendering. Both consume identical logical instance data and shader semantics.

Fill text uses one pass. Stroke, shadow, and glow use explicit shader branches or bounded additional passes. Stats attribute every batch break and effect pass.

Advanced PixiJS integration lives under src/pixi/compat. Startup checks and an exact-plus-latest PixiJS CI matrix constrain interface drift.

## Culling and hit bounds

TextLayer computes accepted local bounds after layout. A spatial index supports viewport queries and incremental updates. Culling adds configurable padding and reports submitted, visible, and culled labels.

getBoundsFor(id) returns local or world bounds without allocating on the hot path when a caller supplies an output rectangle. hitTest(point) returns the topmost visible label identity according to z order.

## pixi-viewport integration

The optional `pixi-glyphflow/viewport` entry binds one TextLayer to a pixi-viewport 6 Viewport. The layer remains a Viewport child so drag, deceleration, wheel zoom, pinch zoom, and camera rotation use one inherited world transform. The binding reads `getVisibleBounds()` after `moved`, `zoomed`, and `frame-end` events, converts the bounds into layer-local coordinates, and schedules one coalesced culling query per rendered frame.

Camera-only interaction updates the layer transform and visible set while preserving every label revision. Applications that move labels independently use `updatePositions(ids, positions)` with Float64 identity storage and packed Float32 coordinates. The binding exposes frame diagnostics and releases every listener through one idempotent destroy path.

## Diagnostics

TextLayerStats includes:

- revision, label count, visible label count, glyph count, pending admissions, and pending mutations;
- renderer name and adapter;
- shape, layout, atlas, instance, and transform work counts;
- cache hit, miss, entry, and byte counts;
- atlas pages, bytes, uploads, evictions, repacks, and generation swaps;
- draw calls, batch breaks, effect passes, submitted glyphs, and culled labels;
- CPU store bytes, GPU instance bytes, staging high-water mark, and upload bytes;
- worker queue depth, stale results, fallbacks, and last commit timings;
- last layout, instance-write, palette-write, spatial-update, and upload milliseconds.
- requested/active residency, fallback reason, GPU-resident labels, prototype count, paint count,
  per-label GPU-scene object count, deferred spatial labels, and frame-transaction submissions.

Diagnostics snapshots are immutable and allocation occurs only when the stats getter is read.

## Workloads

| Workload | Fixture | Primary pressure |
| --- | --- | --- |
| Million-label full visibility | 1,000,000 labels and 8,000,000 representative visible glyphs | Instance capacity, draw submission, memory, GPU throughput |
| Million-label live visibility | Same scale through the live `TextLayer` coordinator mesh | Layout, atlas, instance build, upload, and GPU completion |
| Million-label viewport | 1,000,000 resident labels with a deterministic visible subset | Spatial indexing, culling, steady-state traversal |
| Dynamic counters | 1,000,000 resident labels with 100,000 text and transform mutations per commit | Bulk mutation intake, shape cache, dirty compaction, partial upload |
| Viewport drag | 1,000,000 resident labels, 50,000 visible labels, continuous drag and deceleration | Camera transforms, visible-set queries, allocation stability |
| Viewport zoom | 1,000,000 resident labels, scale sweep from 0.05 to 32 through wheel and pinch | Level-of-detail policy, culling churn, atlas stability |
| Position storm | 1,000,000 resident labels with 100,000 packed x/y updates per commit during viewport motion | Identity validation, spatial-index maintenance, transform uploads |
| Multilingual stream | Latin, CJK, Arabic, Devanagari, emoji, 1,000 mutations per second | Shaping, fallback, atlas misses, async continuity |
| Scale scan | Camera scale from 0.25 to 16 with rotation | Distance-field quality and cache stability |
| Atlas pressure | 20,000 unique CJK and emoji graphemes under a fixed byte ceiling | Packing, eviction, generation safety, upload bandwidth |
| Static HUD | 1,000 stable labels with effects | Steady-state CPU, draw count, retained memory |
| GPU-scene resident | 1,000,000 labels, 50,000 submitted, and 100,000 movers | Dense mover ABI, fused submission, segmented GPU timing, and exact output identity |
| GPU-scene heterogeneous | 64 prototypes × 8 paints across 1,000,000 labels | 512-bin compilation, bounded residency, output parity, and delivery/promotion separation |
| Collision repeatability | Three sealed WebGL plus three sealed WebGPU runs | Selection identity, sorted-candidate/run-cache path, CPU/collision budgets, and whole-frame tail |

## Performance budgets

1. The equal-content static glyphflow fixture must reach at most the PixiJS BitmapText frame p95.
2. Million-label full visibility, viewport culling, dynamic counters, drag, zoom, and position storms must stay within 16.67 milliseconds frame p95 on the reference browser fixture.
3. Accepting 100,000 dynamic-counter mutations through the bulk interface must stay below 16.67 milliseconds p95 on the reference Apple M1 Pro fixture; shaping and upload timings are reported separately.
4. A warmed static workload must record zero shaping, layout, atlas, instance upload, and JavaScript allocation work.
5. Atlas bytes, including a temporary repack generation, must stay within the configured ceiling.
6. Fixed-width CPU label storage must stay within 128 MiB per 1,000,000-label allocated capacity, excluding caller text and style payloads.
7. Glyph instance storage must stay at or below 32 bytes per glyph, yielding a 256 MiB ceiling for the 8,000,000-glyph stress fixture.
8. The core ESM entry must stay below 40 KiB gzip, excluding optional WebAssembly assets and source maps.
9. Every million-label sample runs in an isolated process so memory is released between repetitions.
10. Repeated benchmark samples must exceed measured run-to-run variance before an optimization remains in the codebase.
11. Viewport drag and zoom with 1,000,000 resident labels and 50,000 visible labels must stay within 16.67 milliseconds frame p95 on the reference browser fixture.
12. Viewport interaction must produce zero label mutations, zero shaping work, and bounded culling allocations during camera-only frames.
13. GPU-scene resident promotion requires five sealed formal runs, zero camera and position frames
    above 16.67 ms, exact 800,016-byte dense uploads, stable GPU/pixel identity, and complete
    palette/cull/scene-render segmented timestamps.
14. Heterogeneous GPU-scene delivery requires both phase p95 values at or below 33.34 ms and at
    least 4× speedup versus the fixed GPU Scene v2 RED control. Its 16.67 ms promotion remains an
    independent decision.
15. Collision repeatability requires three sealed runs per renderer with stable selection identity;
    the WebGPU whole-frame gate remains 16.67 ms.

The 2026-08-15 startup split moved the default bitmap adapter, HarfBuzz worker shaper, and dynamic
raster provider behind their first-use async seams. `bun run benchmark:check` measured the core ESM
entry at 47,995 bytes gzip before the split and 39,996 bytes after it, within the 40 KiB budget.

The 40 KiB core gzip CI fail is deferred while Wave 1 is in tree. The check still measures the
graph and does not fail that size. Item 8 stays the last accepted 1.1.0 measurement, not a current
fail condition.

The 1.1.0 artifacts meet the remaining budgets on the reference fixture. The unstamped extreme
program in [performance-plan.md](performance-plan.md) proposes tighter atlas, mutation, and storage
targets after measured waves. Those proposals do not change this specification until a human
accepts them.

## Correctness budgets

1. WebGL and WebGPU pixel output must stay within published per-mode tolerances.
2. Complex-script fixtures must match reference glyph IDs, cluster boundaries, advances, line breaks, and visual goldens.
3. Removing or mutating one label must preserve every sibling label.
4. Destroying one layer or application must preserve resources owned by surviving layers and applications.
5. Renderer detach and reattach must preserve accepted label state and produce an equivalent frame.
6. Atlas eviction and repack must preserve currently visible glyphs and reject stale async results.
7. Every public mutation and error path must have behavior-level coverage through the public interface.

## Commands

| Purpose | Command |
| --- | --- |
| Install | bun install |
| Format | bun run format |
| Lint | bun run lint |
| Type check | bun run typecheck |
| Unit and integration tests | bun test |
| Coverage | bun run test:coverage |
| Library build | bun run build |
| Browser correctness | bun run test:browser |
| Benchmarks | bun run benchmark |
| Package verification | bun run package:smoke |
| Full local release gate | bun run release:check |

Commands enter package.json in the same slice that introduces their implementation.

## Project structure

    src/
      TextLayer.ts
      FontRegistry.ts
      types.ts
      store/
      shaping/
      layout/
      atlas/
      culling/
      render/
      pixi/compat/
      accessibility/
      worker/
    tests/
    benchmarks/
    playground/
    scripts/
    docs/
    tasks/

## Code style

Public functions use explicit return types and behavior-oriented names. Internal classes remain unexported unless two concrete callers establish a real seam.

    const id = layer.create({ text: "Ready", x: 12, y: 24 });
    layer.update(id, { text: "Running", style: { fill: 0x38bdf8 } });
    const revision = await layer.commit();

    console.log(Number(revision), layer.stats.drawCalls);

## Testing strategy

Tests observe behavior through four agreed seams:

1. TextLayer public operations and rendered results.
2. FontRegistry registration, fallback, and lifetime.
3. Worker request and response protocol.
4. Packed npm exports in a clean consumer.

Unit tests cover deterministic algorithms through their owning module interface. Browser tests cover WebGL and WebGPU pixels, lifecycle, culling, and interaction. Benchmarks compare equal fixtures against PixiJS Text, BitmapText, and HTMLText where feature overlap exists. GPU-heavy probes run sequentially.

Every new behavior follows one failing public-seam test, one implementation, and one passing verification cycle.

## Boundaries

Always:

- validate public inputs;
- keep root imports side-effect free;
- update affected English documentation and PCR records with interface changes;
- measure before and after every retained optimization;
- run focused tests before each atomic commit;
- preserve renderer and resource ownership in lifecycle tests.

Ask first:

- select or change the legal license;
- publish a release candidate or stable version;
- expand the peer dependency range beyond PixiJS 8;
- introduce a required runtime dependency larger than the current optional shaping assets.

Never:

- commit credentials, user data, private project names, or copied proprietary context;
- publish an unmeasured performance claim;
- expose PixiJS internal objects through the public interface;
- destroy shared shader programs or resources owned by another layer;
- accept stale worker or atlas results.

## Release criteria

Version 1.0.0 requires:

- every functional requirement implemented and documented;
- all unit, integration, browser, visual, lifecycle, and package tests passing;
- raw benchmark artifacts for every published performance claim;
- performance budgets passing on the reference hardware;
- a clean npm tarball with verified ESM and TypeScript consumers;
- zero high or critical dependency advisories;
- English README, getting-started guide, API reference, architecture guide, performance guide, examples, changelog, and migration guide;
- GitHub CI success on the release commit;
- package version, signed tag, npm metadata, provenance, and GitHub Release alignment;
- an independent installation from the public registry.

## Open constraints

- The current legal state remains UNLICENSED.
- Reference results from additional iOS and discrete-GPU hardware require access to those devices. The release report labels every measured hardware and browser combination explicitly.
- The extreme performance program in [performance-plan.md](performance-plan.md) is unstamped research. It does not reopen the 1.0 budgets by itself.
