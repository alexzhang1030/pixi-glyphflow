# Getting started

## Requirements

- A modern browser with WebGL 2 or WebGPU
- PixiJS 8.19 or a compatible 8.x release
- pixi-viewport 6 for camera interaction
- An ESM build pipeline

## Installation

```bash
bun add pixi-glyphflow pixi.js pixi-viewport
```

## Bundler configuration

The HarfBuzz module worker uses top-level `await`. Vite applications emit the worker as ESM:

```ts
// vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2022" },
  worker: { format: "es" },
});
```

Equivalent bundler configurations use an ES module worker and an ES2022-or-newer target. The
package exports the worker at `pixi-glyphflow/text-worker.js`.

## Renderer lifecycle

Create the PixiJS application, associate its renderer with `TextLayer`, add the layer to the scene,
then publish the first label revision.

```ts
import { Application } from "pixi.js";
import { TextLayer } from "pixi-glyphflow";

const app = new Application();
await app.init({
  resizeTo: window,
  preference: ["webgpu", "webgl"],
  webgl: { preferWebGLVersion: 2 },
});

const layer = new TextLayer({ renderer: app.renderer });
app.stage.addChild(layer);
layer.create({ text: "Ready", x: 20, y: 20 });
await layer.commit();
```

`attach(renderer)` supports a later renderer association. `detach()` releases renderer-owned atlas,
mesh, and upload resources while preserving accepted label state. A later `attach()` rebuilds the
render surface from that state.

## Bulk creation

Reserve the final order of magnitude through `initialCapacity`, then create labels in application-
sized chunks. Geometric storage growth preserves every current `TextId`.

```ts
const layer = new TextLayer({
  renderer: app.renderer,
  initialCapacity: 1_000_000,
  culling: { bounds: { x: 0, y: 0, width: 1280, height: 800 } },
});

for (let start = 0; start < 1_000_000; start += 8192) {
  const count = Math.min(8192, 1_000_000 - start);
  layer.createMany(
    Array.from({ length: count }, (_, offset) => {
      const index = start + offset;
      return {
        text: `Node ${index}`,
        x: (index % 1000) * 18,
        y: Math.floor(index / 1000) * 18,
        style: { fontFamily: "Inter", fontSize: 12, fill: 0xdde7ff },
      };
    }),
  );
}
await layer.commit();
```

## High-frequency updates

`updateMany` accepts ergonomic partial objects. `updatePositions` accepts packed x/y columns.
`updateTextPositions` combines broadcast or per-label text with packed x/y columns.

```ts
const ids = new Float64Array(selectedIds);
const positions = new Float32Array(ids.length * 2);

layer.updatePositions(ids, positions);
await layer.commit();
```

Each bulk call validates the complete input before publishing changes. Reusing typed arrays keeps
the hot path allocation-stable.

## pixi-viewport interaction

```ts
import { Viewport } from "pixi-viewport";
import { bindViewport } from "pixi-glyphflow/viewport";

const viewport = new Viewport({
  screenWidth: app.screen.width,
  screenHeight: app.screen.height,
  worldWidth: 18_000,
  worldHeight: 18_000,
  events: app.renderer.events,
});
viewport.drag().decelerate().wheel().pinch();
app.stage.addChild(viewport);

const binding = bindViewport(layer, viewport, {
  addChild: true,
  immediate: true,
  onError: console.error,
});
```

The binding listens to `moved`, `zoomed`, and `frame-end`, transforms the visible camera polygon,
coalesces input bursts, and commits one visibility refresh. Rotation is included in the bounds
conversion.

## Teardown

```ts
binding.destroy();
layer.destroy();
viewport.destroy({ children: true });
await app.destroy(true);
```

Each owned GPU, worker, atlas, DOM, and listener resource has one teardown path.
