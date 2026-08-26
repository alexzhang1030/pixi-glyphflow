# API reference

## `pixi-glyphflow`

### `TextLayer`

`TextLayer` extends PixiJS `Container` and owns dense label state, culling, rendering coordination,
and diagnostics.

| Member                                       | Result                           | Contract                                           |
| -------------------------------------------- | -------------------------------- | -------------------------------------------------- |
| `create(spec)`                               | `TextId`                         | Create one label with layer-local identity         |
| `createMany(specs)`                          | `TextId[]`                       | Validate and create a batch in input order         |
| `get(id)`                                    | `TextLabelSnapshot \| undefined` | Read an immutable state snapshot                   |
| `has(id)`                                    | `boolean`                        | Check current identity ownership                   |
| `update(id, patch)`                          | `boolean`                        | Apply one partial mutation                         |
| `updateLabel(id, patch)`                     | `boolean`                        | Compatibility alias for `update`                   |
| `updateMany(entries)`                        | `number`                         | Apply validated partial-object updates             |
| `updatePositions(ids, positions)`            | `number`                         | Apply packed x/y columns                           |
| `updateTextPositions(ids, texts, positions)` | `number`                         | Apply text and packed x/y columns together         |
| `createGroup()`                              | `TextGroupId`                    | Create one unique layer-local group identity       |
| `hasGroup(group)`                            | `boolean`                        | Check current group identity ownership             |
| `setGroupVisible(group, visible)`            | `number`                         | Apply a group mask and return affected label count |
| `removeGroup(group)`                         | `boolean`                        | Retire a group and detach its retained labels      |
| `showAll()`                                  | `number`                         | Show every current label in one columnar pass      |
| `hideAll()`                                  | `number`                         | Hide every current label in one columnar pass      |
| `remove(id)`                                 | `boolean`                        | Retire one identity and its render state           |
| `removeMany(ids)`                            | `number`                         | Retire current identities                          |
| `clear()`                                    | `number`                         | Retire every label                                 |
| `compact()`                                  | `TextCompactionResult`           | Shrink unused CPU capacity while preserving IDs    |
| `commit()`                                   | `Promise<TextRevision>`          | Publish dirty state and await render work          |
| `setViewportBounds(bounds)`                  | `void`                           | Set layer-local culling bounds                     |
| `getBoundsFor(id, output?, space?)`          | `BoundsData \| undefined`        | Read accepted local or world bounds                |
| `hitTest(point, space?)`                     | `TextId \| undefined`            | Return the topmost visible label                   |
| `attach(renderer)`                           | `void`                           | Associate a WebGL or WebGPU renderer               |
| `detach()`                                   | `void`                           | Release renderer resources and retain label state  |
| `stats`                                      | `TextLayerStats`                 | Read an immutable diagnostics snapshot             |

`TextId` includes a layer namespace, slot, and generation. Stale and foreign identities fail bulk
validation before state publication.

`TextLayerCullingOptions.computeCull` accepts `true`, `false`, or `"auto"`. The default is `"auto"`.
Automatic mode uses compute compaction when the attached WebGPU device is ready and the live
glyphs fit one atlas bank. WebGL, unavailable devices, multi-segment meshes, and `false` use the
CPU grid. `lod: true` drops labels whose projected font height is below one pixel. That changes
pixels and stays off by default.

PixiJS creates WebGPU devices with the 128 MiB core `maxStorageBufferBindingSize`. Compute cull
binds record storage and an 8-byte-per-visible-glyph compact draw buffer. `requestComputeCullGpu()`
requests the adapter's storage and buffer limits and returns `{ adapter, device }` for
`Application.init({ gpu })`. If a live buffer still exceeds the device limit, the layer uses
`cpu-grid`.

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

## `pixi-glyphflow/advanced`

The advanced entry exposes `SpatialIndex`, `GlyphAtlas`, `PrebuiltGlyphProvider`,
`prebuiltGlyphKey`, `RasterGlyphProvider`, `BitmapLayoutAdapter`, `LayoutEngine`, `GlyphInstanceStore`, `TransformPalette`,
`GlyphMesh`, `RenderCoordinator`, `WebGLAdapter`, and `WebGPUAdapter` with their public option and
diagnostic types.

These primitives support custom renderer pipelines that preserve the package storage and shader
contracts. `GLYPH_TEXTURE_BANK_SIZE` is `8`; `GlyphMeshOptions.textures` accepts consecutive atlas
pages beginning with `texture`, and `setTextures()` updates that bank while retaining the primary
texture used by PixiJS blend-state selection. Draw instances use `GLYPH_DRAW_STRIDE` (8 bytes);
`prototypeTexture` holds the unique 24-byte store records. `GlyphAtlas` keys are `string | number`; the live
coordinator path packs numeric identities and still accepts diagnostic strings.

`TextLayerOptions.rendering.rasterizerOptions` configures the default `RasterGlyphProvider`.
`generatorConcurrency` controls the lazy MSDF worker pool. `distanceFieldMinFontSize` controls the
minimum source resolution for dynamic MSDF/SDF glyphs and defaults to `48`. `tinySdf: true` builds
those HarfBuzz glyphs as a local SDF from the canvas mask and skips `@zappar/msdf-generator`. That
changes pixels. `prebuilt` serves packed pages before TinySDF or MSDF. Record keys come from
`prebuiltGlyphKey` and omit font revision so a re-registered family keeps the same page. The
renderer stores the
physical-to-logical raster scale so layout, stroke, and shadow dimensions remain stable.
`createMsdfGenerator` supplies explicit worker and WebAssembly URLs for production bundlers. Each
worker serializes font loading and atlas generation; separate workers execute in parallel.

`TextLayerStats.cullPath` is either `"compute-cull"` or `"cpu-grid"` and names the path used by the
latest draw preparation. The root entry exports the `CullPath` type and `requestComputeCullGpu`.
Compute shader and pass internals are not root exports.
