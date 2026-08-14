# 1.0 release POC

The release POC exercises the stable package entry points through a real PixiJS application and a
real pixi-viewport camera.

## Demonstrated path

1. Create one `TextLayer` with 1,000,000 resident labels.
2. Render the visible subset through shared glyph resources.
3. Drag with deceleration.
4. Zoom through wheel and pinch input.
5. Rotate the viewport camera.
6. Apply 100,000 packed position updates per storm tick.
7. Read layer and viewport diagnostics in the HTML overlay.
8. Release the binding, layer, viewport, and application.

## Run

```bash
bun install
bun run playground:dev
```

Open the local URL printed by Vite. Query parameters control the resident and moving sets:

```text
/?labels=1000000&moving=100000
```

The production bundle gate is:

```bash
bun run playground:build
```

## Acceptance evidence

- Browser integration tests exercise drag, deceleration, wheel, pinch, rotation, event coalescing,
  100,000 position updates, revision preservation, and listener teardown.
- Formal browser artifacts record one million resident labels for viewport drag and zoom.
- The eight-million-glyph fixture records actual instanced submission and non-transparent pixels.
- `bun run benchmark:check` enforces every published capacity and frame budget.
- `bun run release:check` validates source, dependencies, declarations, exports, and the packed
  consumer path.
