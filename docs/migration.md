# Migration from 0.0.1

Version 1.0 keeps the stable label identity and commit model introduced by the contract POC. The
implementation now uses compact columns, shared glyph resources, instanced meshes, worker shaping,
and dense culling.

## Package changes

| 0.0.1 surface                 | 1.0 surface                                                     |
| ----------------------------- | --------------------------------------------------------------- |
| `TextLayer` root export       | `TextLayer` and `FontRegistry` root exports                     |
| `updateLabel(id, patch)`      | `update(id, patch)` plus the retained `updateLabel` alias       |
| Per-label PixiJS Text backend | Shared atlas, instance, palette, and mesh backend               |
| Basic lifecycle stats         | CPU, culling, shaping, upload, draw, and atlas diagnostics      |
| Root-only package             | Focused viewport, accessibility, shaping, and advanced subpaths |

## Construction

Pass the renderer during construction or call `attach` before the first rendered commit:

```ts
const layer = new TextLayer({
  renderer: app.renderer,
  initialCapacity: expectedLabels,
  culling: { bounds: initialViewportBounds },
});
```

## Mutation calls

Existing `updateLabel` calls continue to work. New code can use `update` for individual patches,
`updateMany` for object batches, `updatePositions` for packed movement, and `updateTextPositions`
for counter streams.

## Commit behavior

`commit()` remains the publication boundary. The returned promise now includes async layout, worker,
atlas, upload, and render-surface work associated with that accepted revision. Await it before
reading rendered results or tearing down the renderer.

## Styling

Version 1.0 covers fill, stroke, shadow, blend mode, anchor, scale, rotation, alpha, visibility, and
z order through compact shaders. Font registration and fallback chains make multilingual behavior
explicit.

## Diagnostics

Use `stats.backend === "glyphflow-core"`. Capacity and memory fields support operational alerts.
`visibleLabelCount`, `cullingQueries`, `cullPath`, `drawCalls`, `submittedGlyphs`, and upload byte
fields support camera and rendering telemetry. `cullPath` is `compute-cull` on WebGPU when compute
compact is active and `cpu-grid` on WebGL 2.

## Viewport scenes

Move camera ownership to `pixi-glyphflow/viewport` and await the initial binding:

```ts
const binding = bindViewport(layer, viewport, { addChild: true });
await binding.whenIdle();
```

Destroy the binding before its layer and viewport.
