# API reference

## `pixi-glyphflow`

### `TextLayer`

`TextLayer` extends PixiJS `Container` and owns dense label state, culling, rendering coordination,
and diagnostics.

| Member                                        | Result                           | Contract                                           |
| --------------------------------------------- | -------------------------------- | -------------------------------------------------- |
| `create(spec)`                                | `TextId`                         | Create one label with layer-local identity         |
| `createMany(specs)`                           | `TextId[]`                       | Validate and create a batch in input order         |
| `get(id)`                                     | `TextLabelSnapshot \| undefined` | Read an immutable state snapshot                   |
| `has(id)`                                     | `boolean`                        | Check current identity ownership                   |
| `update(id, patch)`                           | `boolean`                        | Apply one partial mutation                         |
| `updateLabel(id, patch)`                      | `boolean`                        | Compatibility alias for `update`                   |
| `updateMany(entries)`                         | `number`                         | Apply validated partial-object updates             |
| `updatePositions(ids, positions)`             | `number`                         | Apply packed x/y columns                           |
| `updateTransforms(ids, positions, rotations)` | `number`                         | Apply packed x/y and per-label radians             |
| `updateTextPositions(ids, texts, positions)`  | `number`                         | Apply text and packed x/y columns together         |
| `createGroup()`                               | `TextGroupId`                    | Create one unique layer-local group identity       |
| `hasGroup(group)`                             | `boolean`                        | Check current group identity ownership             |
| `setGroupVisible(group, visible)`             | `number`                         | Apply a group mask and return affected label count |
| `removeGroup(group)`                          | `boolean`                        | Retire a group and detach its retained labels      |
| `showAll()`                                   | `number`                         | Show every current label in one columnar pass      |
| `hideAll()`                                   | `number`                         | Hide every current label in one columnar pass      |
| `remove(id)`                                  | `boolean`                        | Retire one identity and its render state           |
| `removeMany(ids)`                             | `number`                         | Retire current identities                          |
| `clear()`                                     | `number`                         | Retire every label                                 |
| `compact()`                                   | `TextCompactionResult`           | Shrink unused CPU capacity while preserving IDs    |
| `commit()`                                    | `Promise<TextRevision>`          | Publish dirty state and await render work          |
| `setViewportBounds(bounds)`                   | `void`                           | Set layer-local culling bounds                     |
| `getBoundsFor(id, output?, space?)`           | `BoundsData \| undefined`        | Read accepted local or world bounds                |
| `hitTest(point, space?)`                      | `TextId \| undefined`            | Return the topmost visible label                   |
| `attach(renderer)`                            | `void`                           | Associate a WebGL or WebGPU renderer               |
| `detach()`                                    | `void`                           | Release renderer resources and retain label state  |
| `whenRendererReleased()`                      | `Promise<void>`                  | Observe the latest actual renderer graph release   |
| `destroy(options?)`                           | `void`                           | Start best-effort owned-resource teardown          |
| `whenDestroyed()`                             | `Promise<void>`                  | Observe completion and the first teardown failure  |
| `stats`                                       | `TextLayerStats`                 | Read an immutable diagnostics snapshot             |

`TextId` includes a layer namespace, slot, and generation. Stale and foreign identities fail bulk
validation before state publication.

`updateTransforms` accepts `Float32Array` or `Float64Array` positions and rotations. Positions
contain two values per ID; rotations contain one angle in radians per ID. The complete batch is
validated before mutation. Coordinates must fit finite f32 values and angles must fit finite
binary16 values, matching the label store. Duplicate IDs apply in input order. Scale, anchors,
paint, and text retain their current values.

`destroy()` retains PixiJS's synchronous `void` signature, runs every best-effort cleanup step,
and throws the first synchronous teardown failure after the remaining steps run. `whenDestroyed()`
returns one stable tracked promise. It settles after internally owned asynchronous provider release
and rejects with the first teardown failure. Await it when resource-release completion belongs to
the caller's lifecycle boundary.

`attach()` and `detach()` retain synchronous `void` signatures. Each actual renderer graph release
publishes a tracked promise through `whenRendererReleased()`, including asynchronous provider
teardown and first-error rejection. A repeated empty `detach()` returns the same stable, internally
handled promise for the most recent release.

The constructor's `renderer` option and `attach()` prepare a coordinator, surface, and residency
capability as a local activation transaction, then publish the complete renderer graph atomically.
An activation failure leaves the layer detached, releases the local graph best-effort, preserves
the activation error, and permits a same-renderer retry. `whenRendererReleased()` includes any
asynchronous activation rollback.

`TextLayerCullingOptions.computeCull` accepts `true`, `false`, or `"auto"`. The default is `"auto"`.
Automatic mode uses compute compaction when the attached WebGPU device is ready and the live
glyphs fit one atlas bank. WebGL, unavailable devices, multi-segment meshes, and `false` use the
CPU grid. `lod: true` drops labels whose projected font height is below one pixel. That changes
pixels and stays off by default.

`TextLayerCullingOptions.residency` accepts `"viewport"` or `"gpu-scene"`. The default is
`"viewport"`. `"gpu-scene"` is an explicit WebGPU opt-in that retains the complete supported
scene as GPU cull records and shared prototype data. Activation requires all of these conditions:

- culling is enabled and collision is disabled;
- the renderer is WebGPU with compute culling and a storage transform palette;
- device storage limits fit the complete cull-record, compact-draw, transform, and local-bounds
  buffers;
- every effective-visible label belongs to a bounded set of up to 64 rendered prototypes and 8
  canonical fill paints, forming at most 512 prototype/paint columns; all labels use fill-only
  styling, alpha 1, unit scale, per-label rotation, zero anchors, z index 0, and normal blend;
- initial slots and insertion orders are dense and increasing.

The layer evaluates capability and eligibility in deterministic order. A requested GPU scene that
uses viewport residency exposes one stable `TextLayerResidencyFallbackReason`:

| Reason                        | Meaning                                                      |
| ----------------------------- | ------------------------------------------------------------ |
| `collision-enabled`           | Screen-space collision owns the current visibility selection |
| `renderer-unavailable`        | The layer has no supported attached renderer                 |
| `webgpu-required`             | The attached renderer is WebGL                               |
| `compute-cull-unavailable`    | The WebGPU compute pass is unavailable                       |
| `storage-palette-unavailable` | Vertex-stage transform storage is unavailable                |
| `device-limit`                | A required GPU buffer exceeds the live device limit          |
| `unsupported-scene`           | Label state or mutation leaves the supported uniform lane    |
| `setup-failed`                | Resident coordinator or GPU setup could not complete         |

An active resident camera commit refreshes the compute viewport uniform and records zero CPU
spatial queries, admission, coordinator work, and cull-record uploads. Sorted, unique, strictly
contiguous active position commits use one 8-byte `x`/`y` command per moved label; the 16-byte
header carries `baseSlot` and `count`. A 100,000-label dense move uploads 800,016 transform bytes
and zero CPU cull-record bytes. Sparse, reordered, duplicate, and holed commits use the indexed
12-byte `slot`/`x`/`y` fallback with last-write-wins identity. The fused WebGPU pass patches
transform origins and absolute cull AABBs before cull dispatch. Spatial rebucketing stays deferred
until `getBoundsFor`, `hitTest`, a CPU query, or a viewport fallback needs the grid.

Rigid-transform commits use dense 12-byte `x`/`y`/packed-sin-cos commands or indexed 16-byte
`slot`/`x`/`y`/packed-sin-cos commands, plus the same 16-byte header. Vertex transforms, GPU culling,
and CPU hit bounds share the packed binary16 sin/cos. Moving an already-rotated label through
`updatePositions` retains the 8/12-byte position ABI. `updateTransforms`, ordinary angle patches,
and mixed position/angle batches all select this resident path when the scene remains eligible.

Monotonic appends that remain within the 64-prototype / 8-paint matrix extend the scene. Removes
write tombstones. Text changes, `wordWrapWidth`, explicit newlines, and `layout.writingMode`
rebind affected labels to immutable shared prototypes. Repeated layouts reuse their geometry;
changed palette and cull rows upload through dirty ranges. Each resident epoch retains up to 64
text/style/layout candidates, 64 exact rendered prototypes, and 8 paints, including earlier
variants. Exceeding those bounds selects viewport residency. Slot reuse, visibility/effect
changes, non-unit scale, nonzero anchors/z, and shaping overrides also select `unsupported-scene`
and rebuild through viewport residency. `detach()` selects
`renderer-unavailable`; a later `attach()` evaluates the requested residency again. `destroy()`
releases the resident records, local-bounds storage, palette binding, and deferred spatial journal.

WebGPU resources belong to one live `GPUDevice`, pass epoch, and Pixi encoder epoch. Device
replacement rebuilds palette and cull pipelines, indirect draw storage, resident local bounds, and
renderer hooks. Encoder replacement moves pending work to the fresh epoch; late callbacks from the
retired epoch only release their owned resources.

`offscreenAdmitBudgetBytes` caps compute-cull first-seen admission for labels that sit only
in the 0.25-viewport prepare ring. Each intern-hit ring label charges 32 bytes, one fill-only
palette row. Tight-view labels always finish in that commit and do not consume the cap. Atlas
texel uploads for already-instanced glyphs stay ungated. The default is 65536 (2048 off-screen
labels). `0` admits the tight view only. The CPU grid ignores the cap because its visible set
is already the tight view.

PixiJS creates WebGPU devices with the 128 MiB core `maxStorageBufferBindingSize` and zero
vertex-stage storage bindings. Compute cull binds record storage and an 8-byte-per-visible-glyph
compact draw buffer. The WebGPU palette path binds the 32-byte transform table as a storage
buffer. `requestComputeCullGpu()` requests the adapter's storage, buffer, and vertex-storage
limits and returns `{ adapter, device }` for `Application.init({ gpu })`. If a live compute-cull
buffer still exceeds the device limit, the layer uses `cpu-grid`. If the live device still
reports `maxStorageBuffersInVertexStage` 0, `TextLayerStats.palettePath` stays `"texture"`.

`showAll()` and `hideAll()` return the number of labels whose `visible` state changed. Repeated calls
return `0` and preserve revision state. One following `commit()` publishes the complete visibility
change through culling, hit testing, accessibility, and the active WebGL or WebGPU renderer.

`TextGroupId` is an opaque identity created by `createGroup()`. Every call produces a distinct
identity owned by its `TextLayer`. A label references one group through `TextLabelSpec.group` or a
patch. `group: null` clears membership. Effective visibility is the conjunction of label-local and
group visibility. `setGroupVisible()` preserves every member's local `visible` value.
`clear()` retires labels and retains independently created groups with their current masks.

### Label state

`TextLabelSpec` and `TextLabelPatch` cover text, x/y, scale, rotation, z index, PixiJS blend mode,
alpha, visibility, group membership, anchor, `TextStyleOptions`, and optional sparse `layout` and
`shaping` objects. These objects are captured by value at the store boundary.

`TextLabelSnapshot.visible` reports label-local visibility. `effectiveVisible` includes the current
group mask.

`TextLayoutOptions.writingMode` accepts `horizontal-tb` and `vertical-rl`. The vertical mode keeps
glyphs upright, stacks each line from top to bottom, and orders explicit lines from right to left.
`TextLabelPatch.layout: null` clears a previous override. Font weight and fill color use
`TextStyleOptions.fontWeight` and `TextStyleOptions.fill`. System fonts apply `fontWeight` during
canvas glyph rasterization; registered binary fonts carry the weight of their selected font face.

`TextShapingOptions` contains:

| Field        | Contract                                                                    |
| ------------ | --------------------------------------------------------------------------- |
| `direction`  | `ltr` or `rtl`; HarfBuzz detects direction when the field is omitted        |
| `language`   | BCP 47 language tag used by language-sensitive OpenType substitutions       |
| `script`     | Four-letter ISO 15924 tag such as `Hans`, `Hant`, `Jpan`, `Kore`, or `Arab` |
| `features`   | Immutable HarfBuzz/OpenType feature strings such as `kern=0` or `liga`      |
| `variations` | Finite variable-font axis coordinates keyed by four-letter OpenType tag     |

`TextLabelPatch.shaping: null` clears a previous override. A shaping-only update advances the label
source revision and preserves the fixed-width reference slot used by the dense million-label store.

### Trusted runs

`createTrustedRun(id, input)` stamps caller-owned typed arrays with layer, label, and font revision
ownership. `adoptRun(id, run)` accepts a structurally valid current run by reference.

### `FontRegistry`

| Member                             | Contract                                              |
| ---------------------------------- | ----------------------------------------------------- |
| `register({ family, source })`     | Register a system, binary, URL, or PixiJS bitmap font |
| `registerFallback(name, families)` | Publish a revisioned fallback chain                   |
| `get(family)` / `has(family)`      | Read current registration state                       |
| `getFallback(name)`                | Read one immutable fallback chain                     |
| `unregister(family)` / `clear()`   | Release registrations and owned bitmap resources      |
| `stats`                            | Report revisions, counts, bytes, and pending loads    |

## `pixi-glyphflow/viewport`

`bindViewport(layer, viewport, options?)` returns a `ViewportBinding`.

| Member       | Contract                                                      |
| ------------ | ------------------------------------------------------------- |
| `flush()`    | Publish the pending camera bounds conversion                  |
| `whenIdle()` | Await the current coalesced visibility commit                 |
| `stats`      | Read event, coalescing, commit, duration, and bounds counters |
| `destroy()`  | Remove every installed viewport listener                      |

`addChild`, `immediate`, `removeOnDestroy`, and `onError` control scene ownership and error
observation.

## `pixi-glyphflow/accessibility`

`AccessibilityAdapter` mirrors a selected subset of labels into an owned DOM overlay.

| Member                 | Contract                                       |
| ---------------------- | ---------------------------------------------- |
| `select(id, options?)` | Create or update one sparse ARIA mirror        |
| `deselect(id)`         | Remove one mirror                              |
| `clear()`              | Remove every selected mirror                   |
| `sync()`               | Refresh text, metadata, visibility, and bounds |
| `stats`                | Read immutable mirror diagnostics              |
| `destroy()`            | Remove the overlay and commit listener         |

## `pixi-glyphflow/shaping`

- `HarfBuzzShaper` provides direct complex-script shaping.
- `HarfBuzzWorkerShaper` moves shaping and font transfer to a worker boundary.
- `StaleShapeResultError` identifies superseded worker responses.

## `pixi-glyphflow/outline`

`createOutlineRendering(options)` creates a caller-owned WebGPU plugin for projected huge glyphs.
Pass it through `rendering: { glyphMode: "outline", outline }`. Eligible HarfBuzz glyphs load one
packed curve blob, rasterize through compute into an RGBA8 color-atlas entry, and join the existing
renderer color array. `projectedSizeThresholdPx` defaults to 128. Capability, source, resource, and
device failures return an explicit plugin fallback so the existing atlas provider can serve the
glyph. The default `glyphMode: "auto"` keeps the atlas route.

The caller owns the plugin lifetime and calls `outline.destroy()` after the layer releases it. The
side entry also exports preparation, route, CPU reference, compute-capability, WGSL, and diagnostic
types for browser tests and custom integrations.

The side entry also exposes the opt-in sparse-strip laboratory. `encodeSparseStripGlyph()` converts
an RGBA coverage bitmap into versioned 4x4 tile strips, `SparseGlyphStripCache` retains immutable
CPU copies under a byte ceiling, and `createSparseStripComputeRasterizer()` batch-rehydrates those
strips into an `OutlineColorAtlas`-compatible `rgba8unorm` texture. Cache identity includes schema,
font family and revision, glyph and variation identity, the power-of-two physical pixel bucket,
padding, and AA mode. `packSparseStripComputeBatch()` and `SPARSE_STRIP_COMPUTE_WGSL` expose the
storage contract for diagnostics and custom adapters. `preflightSparseStripComputePacking()`
checks u32 metadata and typed-allocation boundaries, while packed dispatch statistics expose
overlap-validation operations, padded invocations, and effective pixels. The production outline
router keeps its current path while sustained atlas-pressure promotion evidence is collected.

## `pixi-glyphflow/hb-gpu`

`HbGpuDrawWorkerEncoder` owns the packaged HarfBuzz 14.4 Worker/Wasm encoder. `encode()` accepts a
font key, glyph id, and font bytes for the first request of that font; later requests reuse the
worker-side font. `releaseFont()` and `destroy()` release synchronized resources.
`HbGpuWasmRuntime` exposes the lower-level Wasm lifecycle. The entry exports ABI/version constants,
request/result types, and worker protocol types. Packed outline blobs use the 16-bit representation
validated by the browser GPU Draw workload.

## `pixi-glyphflow/advanced`

The advanced entry exposes `SpatialIndex`, `GlyphAtlas`, `PrebuiltGlyphProvider`,
`prebuiltGlyphKey`, `RasterGlyphProvider`, `BitmapLayoutAdapter`, `LayoutEngine`,
`GlyphInstanceStore`, `TransformPalette`, `GlyphMesh`, `RenderCoordinator`, `WebGLAdapter`,
`WebGPUAdapter`, `SymbolContinuityIndex`, `SabShapeTransport`, and
`detectSabShapeTransportCapability` with their public option and diagnostic types.

`SymbolContinuityIndex` is the opt-in Map Symbol Continuity laboratory. Call `reserve()` before a
large admission, then bracket each monotonic scene/camera/zoom revision with `beginFrame()` and
`endFrame()`. `resolve()` accepts one logical key plus an explicit tile/anchor candidate; repeated
logical keys select by f32 priority, retained candidate, insertion order, and deterministic typed
identity. Call `place()` after collision admission, or use the idempotent `resolveAndPlace()` fast
path. `abortFrame()` rolls provisional ids, reclaimed tombstones, map edits, and counters back.
`read()` exposes committed phase, opacity, retained candidate, anchor, revisions, and source-retire
deadline. `stateHashMode` defaults to `"manual"`; call `computeStateHash()` at an inactive WAL
checkpoint. `"every-frame"` returns the same complete hash from `endFrame()` through the single
commit scan. The 100k dual-mode microbenchmark clears 16.67 ms p95 locally; TextLayer/WAL product
integration keeps its independent sustained gate.

`SabShapeTransport` is an advanced single-producer/single-consumer ring for leased zero-copy
positioned-run views. Supply it as `HarfBuzzWorkerShaperOptions.shapeTransport`. Browser support
requires `SharedArrayBuffer`, `Atomics`, and cross-origin isolation. The shaper owns the supplied
transport lifecycle.

These primitives support custom renderer pipelines that preserve the package storage and shader
contracts. `GLYPH_TEXTURE_BANK_SIZE` is `2` (R8 and RGBA8 arrays). `GLYPH_ATLAS_ARRAY_LAYERS` is
`256`. `GlyphMeshOptions.textures` accepts `[atlasR, atlasRGBA]` beginning with `texture`, and
`setTextures()` updates those arrays while retaining the primary texture used by PixiJS blend-state
selection. Draw instances use `GLYPH_DRAW_STRIDE` (8 bytes); `prototypeTexture` holds the unique
24-byte store records. Instance metadata low bits are the same-format atlas layer, not a page-bank
slot. `GlyphAtlas` keys are `string | number`; the live
coordinator path packs numeric identities and still accepts diagnostic strings. `AtlasEntry.layer`
is the array layer among sdf/alpha or msdf/color pages.

`TextLayerOptions.rendering.rasterizerOptions` configures the default `RasterGlyphProvider`.
`generatorConcurrency` controls the lazy MSDF worker pool. `distanceFieldMinFontSize` controls the
minimum source resolution for dynamic MSDF/SDF glyphs and defaults to `48`. Logical sizes that
clamp to that minimum intern one physical field and keep a per-request raster scale. Empty-ink
scalars skip raster and instance quads; layout advance stays. `tinySdf: true` builds
those HarfBuzz glyphs as a local SDF from the canvas mask and skips `@zappar/msdf-generator`. That
changes pixels. `prebuilt` serves packed pages before TinySDF or MSDF. Record keys come from
`prebuiltGlyphKey` and omit font revision so a re-registered family keeps the same page. The
[`pixi-glyphflow/prebuilt`](#pixi-glyphflowprebuilt) section defines its wire-format migration
boundary. A miss with a non-zero glyph id retries `glyphId: 0` when `glyphText` is a single Unicode
scalar, so a family page can ignore HarfBuzz ids. Ligatures stay on the exact key. A miss whose physical
size (`max(fontSize, distanceFieldMinFontSize)`) matches a baked field's
`fontSize * (rasterScale ?? 1)` crops that field and interns it, so a 14px bake serves a 13px
or 32px first sight without starting TinySDF or MSDF. Sizes above the minimum still generate.
The renderer stores the physical-to-logical raster scale so layout, stroke, and shadow
dimensions remain stable.
`createMsdfGenerator` supplies explicit worker and WebAssembly URLs for production bundlers. Each
worker serializes font loading and atlas generation; separate workers execute in parallel.

`TextLayerStats.cullPath` is either `"compute-cull"` or `"cpu-grid"` and names the path used by the
latest draw preparation. `TextLayerStats.palettePath` is either `"storage"` or `"texture"` and
names the transform table used by that draw. WebGPU storage skips a CPU gather of the full
palette on a position-only or camera-only commit. A position-only storm uploads packed
move commands so the GPU can write live x/y. Storage-backed viewport compute culling stores local
boxes and adds those live origins in the cull shader, which keeps mover cull-record uploads at zero.
GPU-scene residency uses its fused transform and absolute-AABB patch path. WebGL stays on
`"texture"`. The root entry
exports the `CullPath`, `PalettePath`, `TextLayerResidency`, and
`TextLayerResidencyFallbackReason` types plus `requestComputeCullGpu`. Compute shader and pass
internals stay on advanced/internal entry points.

GPU-scene diagnostics add these fields to `TextLayerStats`:

| Field                                   | Contract                                                             |
| --------------------------------------- | -------------------------------------------------------------------- |
| `residencyRequested`                    | Configured `"viewport"` or `"gpu-scene"` policy                      |
| `residencyActive`                       | Residency policy used by the current scene                           |
| `residencyFallbackReason`               | Stable fallback reason, or `undefined` for the requested active path |
| `gpuResidentLabels`                     | Active labels represented by GPU-scene records                       |
| `gpuScenePrototypeCount`                | Shared prototype count in the current resident generation            |
| `gpuScenePaintCount`                    | Canonical fill-paint count in the current resident generation        |
| `gpuScenePerLabelObjectCount`           | Live per-label object count owned by the active GPU-resident scene   |
| `deferredSpatialLabels`                 | Position changes waiting for CPU-grid rebucketing                    |
| `cullRecordUploadBytes`                 | Cumulative CPU-to-GPU cull-record upload bytes                       |
| `lastSceneSetupMs`                      | Duration of the latest successful resident setup                     |
| `frameTransactionSubmissions`           | Cumulative fused plus standalone WebGPU transaction submissions      |
| `frameTransactionFusedSubmissions`      | Transactions encoded into Pixi's frame command buffer                |
| `frameTransactionStandaloneSubmissions` | Explicit capacity, recovery, or retirement flushes                   |

Viewport residency and resident fallbacks report zero GPU-resident labels, prototypes, and
per-label scene objects.
`lastSceneSetupMs` retains the latest successful setup value across later commits.
Steady resident camera and position frames each advance the total and fused counters by one while
the standalone counter stays unchanged.

## `pixi-glyphflow/prebuilt`

`prebuiltGlyphKey` returns an opaque key in the stable `pixi-glyphflow/prebuilt/v2:` wire format.
UTF-16 length-prefixed fields preserve tuple boundaries. `PrebuiltGlyphProvider` canonicalizes
valid legacy six-field NUL-delimited keys during page ingestion and lookup, so pages passed through
the provider retain their aliases. External persisted maps keyed directly by an earlier exported
string require a cache rebuild or a v2-first, legacy-alias lookup during migration.

`uiSdfPrebuilt({ family, fontSize?, fontWeight? })` returns `rasterizerOptions.prebuilt` pages for
printable ASCII (U+0020–U+007E). The bitmaps are a public-domain VGA 8×8 set scaled to 16 px ink
and encoded with the same TinySDF radius the dynamic path uses. This is a coarse UI alphabet, not
production typography. `fontSize` must be `16` (`UI_SDF_FONT_SIZE`); other sizes throw. The first
call encodes; later calls remap keys only.

`charsetSdfPrebuilt({ family, charset, fontSize, fontWeight?, distanceFieldMinFontSize?, rasterize? })`
bakes host text with the same TinySDF path. It skips empty-ink scalars, encodes at
`max(fontSize, distanceFieldMinFontSize)`, and stores `rasterScale` on each glyph. The first bake
for a family + physical size + weight + charset paints; later calls remap keys. It does not ship
CJK bitmaps. Generated page ids use the stable `pixi-glyphflow/charset-sdf/v2:` prefix with
length-prefixed family, physical-size, and page-index fields. Persisted generated pages should be
rebaked once for v2; self-contained legacy payloads remain readable through their stored
glyph-to-page references. `mergePrebuilt` concatenates family pages. `uniqueInkCharset` is the scalar filter.
The pages are not in the core ESM graph — import `pixi-glyphflow/prebuilt` and pass the result
into `rasterizerOptions.prebuilt` with `tinySdf: true` when the host wants known ink to be a crop.

```ts
import { TextLayer } from "pixi-glyphflow";
import { charsetSdfPrebuilt, mergePrebuilt, uiSdfPrebuilt } from "pixi-glyphflow/prebuilt";

const layer = new TextLayer({
  rendering: {
    rasterizerOptions: {
      tinySdf: true,
      prebuilt: mergePrebuilt(
        uiSdfPrebuilt({ family: "Inter" }),
        await charsetSdfPrebuilt({
          family: "Noto Sans CJK",
          charset: "上海字流",
          fontSize: 14,
        }),
      ),
    },
  },
});
```
