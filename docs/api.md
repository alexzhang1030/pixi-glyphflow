# API reference

## `pixi-glyphflow`

### `TextLayer`

`TextLayer` extends PixiJS `Container` and owns dense label state, culling, rendering coordination,
and diagnostics.

| Member                                       | Result                           | Contract                                          |
| -------------------------------------------- | -------------------------------- | ------------------------------------------------- |
| `create(spec)`                               | `TextId`                         | Create one label with layer-local identity        |
| `createMany(specs)`                          | `TextId[]`                       | Validate and create a batch in input order        |
| `get(id)`                                    | `TextLabelSnapshot \| undefined` | Read an immutable state snapshot                  |
| `has(id)`                                    | `boolean`                        | Check current identity ownership                  |
| `update(id, patch)`                          | `boolean`                        | Apply one partial mutation                        |
| `updateLabel(id, patch)`                     | `boolean`                        | Compatibility alias for `update`                  |
| `updateMany(entries)`                        | `number`                         | Apply validated partial-object updates            |
| `updatePositions(ids, positions)`            | `number`                         | Apply packed x/y columns                          |
| `updateTextPositions(ids, texts, positions)` | `number`                         | Apply text and packed x/y columns together        |
| `remove(id)`                                 | `boolean`                        | Retire one identity and its render state          |
| `removeMany(ids)`                            | `number`                         | Retire current identities                         |
| `clear()`                                    | `number`                         | Retire every label                                |
| `compact()`                                  | `TextCompactionResult`           | Shrink unused CPU capacity while preserving IDs   |
| `commit()`                                   | `Promise<TextRevision>`          | Publish dirty state and await render work         |
| `setViewportBounds(bounds)`                  | `void`                           | Set layer-local culling bounds                    |
| `getBoundsFor(id, output?, space?)`          | `BoundsData \| undefined`        | Read accepted local or world bounds               |
| `hitTest(point, space?)`                     | `TextId \| undefined`            | Return the topmost visible label                  |
| `attach(renderer)`                           | `void`                           | Associate a WebGL or WebGPU renderer              |
| `detach()`                                   | `void`                           | Release renderer resources and retain label state |
| `stats`                                      | `TextLayerStats`                 | Read an immutable diagnostics snapshot            |

`TextId` includes a layer namespace, slot, and generation. Stale and foreign identities fail bulk
validation before state publication.

### Label state

`TextLabelSpec` and `TextLabelPatch` cover text, x/y, scale, rotation, z index, PixiJS blend mode,
alpha, visibility, anchor, and `TextStyleOptions`. Style objects are captured by value at the store
boundary.

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
`RasterGlyphProvider`, `BitmapLayoutAdapter`, `LayoutEngine`, `GlyphInstanceStore`, `TransformPalette`,
`GlyphMesh`, `RenderCoordinator`, `WebGLAdapter`, and `WebGPUAdapter` with their public option and
diagnostic types.

These primitives support custom renderer pipelines that preserve the package storage and shader
contracts.
