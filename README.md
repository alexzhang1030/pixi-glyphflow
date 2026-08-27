# pixi-glyphflow

A million-label text layer for PixiJS 8 with compact CPU storage, instanced WebGL/WebGPU rendering,
worker shaping, bounded glyph atlases, dense culling, and first-class pixi-viewport integration.

## Highlights

- One `TextLayer` retains 1,000,000 labels in 72 MiB of fixed-width CPU storage.
- One instanced draw submits 8,000,000 visible glyphs through a 32-byte glyph record.
- Eight-page texture banks preserve glyph order while merging mixed atlas pages into one draw.
- `updatePositions` applies 100,000 packed x/y changes in 3.40 ms p95 on the reference M1 Pro.
- `updateTextPositions` applies 100,000 text and x/y changes in 14.20 ms p95.
- `showAll()` and `hideAll()` update the complete resident visibility column with one commit.
- Independently created label groups apply reusable visibility masks without changing local label state.
- Basic vertical writing stacks upright glyphs in top-to-bottom, right-to-left columns.
- `bindViewport` coalesces drag, deceleration, wheel, pinch, zoom, and rotation camera work.
- HarfBuzz worker shaping covers CJKV, Arabic, Devanagari, Hebrew, Thai, bidi text, and OpenType features.
- Binary font registration, recursive fallback aliases, and sparse per-label shaping controls support product-owned typography.
- Optional accessibility, viewport, shaping, and advanced-rendering subpaths keep entry points focused.

## Install

```bash
bun add pixi-glyphflow pixi.js
```

Add `pixi-viewport` when the scene uses the viewport binding:

```bash
bun add pixi-viewport
```

The package ships ESM for PixiJS 8.19 and pixi-viewport 6.

### Vite worker output

HarfBuzzJS uses top-level `await` inside the module worker. Configure Vite to emit an ES module
worker and target ES2022:

```ts
import { defineConfig } from "vite";

export default defineConfig({
  build: { target: "es2022" },
  worker: { format: "es" },
});
```

## Create a text layer

```ts
import { Application } from "pixi.js";
import { TextLayer } from "pixi-glyphflow";

const app = new Application();
await app.init({
  resizeTo: window,
  preference: ["webgpu", "webgl"],
  webgl: { preferWebGLVersion: 2 },
});
document.body.append(app.canvas);

const labels = new TextLayer({
  renderer: app.renderer,
  initialCapacity: 1_000_000,
  culling: { bounds: { x: 0, y: 0, width: 1280, height: 720 } },
});
app.stage.addChild(labels);

const temperature = labels.create({
  text: "上海 24 C",
  x: 24,
  y: 32,
  style: { fontFamily: "Inter", fontSize: 18, fill: 0xffffff },
});

labels.update(temperature, { text: "上海 25 C" });
await labels.commit();
```

Mutations are synchronous. `commit()` publishes the accepted dirty set through one monotonic
revision and completes associated shaping, atlas, upload, and visibility work.

## Register multilingual fonts

Binary `Uint8Array` and `URL` sources activate HarfBuzz shaping and glyph-ID rasterization. A
fallback alias expands to an ordered product font stack:

```ts
await labels.fonts.register({
  family: "Product CJKV",
  source: new URL("/fonts/ProductCJKV-VF.ttf", location.href),
});
await labels.fonts.register({
  family: "Product Arabic",
  source: new Uint8Array(arabicFontBytes),
});
labels.fonts.registerFallback("Product multilingual", [
  "Product CJKV",
  "Product Arabic",
  "system-ui",
  "sans-serif",
]);

labels.create({
  text: "繁體中文 · 臺北",
  style: { fontFamily: "Product multilingual", fontSize: 20 },
  shaping: {
    language: "zh-TW",
    script: "Hant",
    features: ["kern", "liga"],
    variations: { wght: 560 },
  },
});
await labels.commit();
```

`shaping` also accepts `direction`, so one sparse label override can select RTL layout or a
language-specific CJK glyph form while the million-label fixed store remains compact. See
[Fonts and shaping](docs/fonts.md) for CJKV routing, fallback behavior, and explicit Vite MSDF
assets.

Dynamic MSDF/SDF glyphs use a 48px minimum source resolution by default, preserving intricate
small-size strokes across viewport zoom while retaining logical layout and effect dimensions.

## Bind pixi-viewport

```ts
import { Viewport } from "pixi-viewport";
import { bindViewport } from "pixi-glyphflow/viewport";

const viewport = new Viewport({
  screenWidth: app.screen.width,
  screenHeight: app.screen.height,
  events: app.renderer.events,
});
viewport.drag().decelerate().wheel().pinch();
app.stage.addChild(viewport);

const binding = bindViewport(labels, viewport, { addChild: true });
await binding.whenIdle();

binding.destroy();
labels.destroy();
viewport.destroy();
```

Camera frames preserve label revisions and shaping results. The binding converts rotated viewport
corners into layer-local bounds and schedules one culling commit per viewport frame.

## Stream 100,000 positions

```ts
const ids = new Float64Array(100_000);
const positions = new Float32Array(200_000);

// Fill ids from createMany() results and write packed x/y values.
labels.updatePositions(ids, positions);
await labels.commit();
```

Broadcast one counter string alongside the packed positions through one transactional columnar
pass:

```ts
labels.updateTextPositions(ids, "42.7 ms", positions);
await labels.commit();
```

Toggle the complete resident set through the allocation-stable columnar path:

```ts
labels.hideAll();
await labels.commit();

labels.showAll();
await labels.commit();
```

## Group visibility and basic layout

Every `createGroup()` call returns a fresh opaque `TextGroupId`. Labels keep their generated
`TextId` and may reference one group identity:

```ts
const stationLabels = labels.createGroup();

const platform = labels.create({
  text: "站台\n入口",
  x: 80,
  y: 40,
  group: stationLabels,
  layout: { writingMode: "vertical-rl" },
  style: {
    fontFamily: "system-ui",
    fontSize: 20,
    fontWeight: "700",
    fill: 0xffcc66,
  },
});

labels.setGroupVisible(stationLabels, false);
await labels.commit();

labels.setGroupVisible(stationLabels, true);
labels.update(platform, { visible: false });
await labels.commit();
```

Effective visibility is `label.visible && group.visible`. Restoring a group preserves each label's
local visibility. `removeGroup(group)` retains its labels and clears their membership. Basic
`vertical-rl` layout keeps glyphs upright, stacks them from top to bottom, and orders explicit lines
from right to left. PixiJS `TextStyleOptions` continues to provide `fontWeight`, `fill`, and the
remaining supported appearance controls.

## Package entry points

| Import                          | Purpose                                                          |
| ------------------------------- | ---------------------------------------------------------------- |
| `pixi-glyphflow`                | `TextLayer`, `FontRegistry`, and primary types                   |
| `pixi-glyphflow/viewport`       | pixi-viewport binding                                            |
| `pixi-glyphflow/accessibility`  | Sparse DOM accessibility mirror                                  |
| `pixi-glyphflow/shaping`        | HarfBuzz main-thread and worker shapers                          |
| `pixi-glyphflow/advanced`       | Atlas, mesh, layout, upload, and spatial primitives              |
| `pixi-glyphflow/prebuilt`       | Optional coarse ASCII SDF pages for `rasterizerOptions.prebuilt` |
| `pixi-glyphflow/text-worker.js` | Worker module used by the default complex-script pipeline        |

## Reference performance

The committed browser artifacts use Chrome, WebGL 2, an Apple M1 Pro, isolated processes, explicit
GPU completion, warmup frames, and p95 reporting.

| Workload                          |                           Scale | Frame p95 |
| --------------------------------- | ------------------------------: | --------: |
| Million-label viewport            |              1,000,000 resident |   5.40 ms |
| Dynamic counters                  | 100,000 text + position updates |  16.40 ms |
| pixi-viewport drag + deceleration |              1,000,000 resident |   5.80 ms |
| pixi-viewport wheel + pinch zoom  |              1,000,000 resident |   7.60 ms |
| Position storm                    |          100,000 packed updates |   9.50 ms |
| Multilingual stream               |  10,000 resident, 1,000 updates |   1.50 ms |

The [generated performance report](benchmarks/PERFORMANCE.md) links every raw artifact and records
memory, atlas, draw, fixture, and invariant evidence.

## Development

The repository pins Bun, TypeScript 7, tsdown, Oxlint, Oxfmt, Playwright, publint, and Are the Types
Wrong.

```bash
bun install
bun run check
bun run test:browser
bun run benchmark:check
bun run playground:build
bun run site:build
```

| Command                                         | Purpose                                                        |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `bun run benchmark`                             | Run every isolated browser workload and regenerate the report  |
| `bun run benchmark -- --workload viewport-drag` | Run one workload                                               |
| `bun run benchmark:check`                       | Enforce committed performance and capacity budgets             |
| `bun run docs:check`                            | Validate English documentation, links, and public API coverage |
| `bun run playground:dev`                        | Start the interactive million-label pixi-viewport stress demo  |
| `bun run site:dev`                              | Start the Nuxt documentation site                              |
| `bun run site:typecheck`                        | Check Nuxt and Vue through TypeScript 7-native Golar           |
| `bun run site:test`                             | Build and run responsive browser acceptance                    |
| `bun run release:check`                         | Run source, dependency, package, and tarball release gates     |

## Documentation

- [Interactive Nuxt site](site/README.md)
- [Getting started](docs/getting-started.md)
- [API reference](docs/api.md)
- [Fonts and shaping](docs/fonts.md)
- [Architecture](docs/architecture.md)
- [Performance](docs/performance.md)
- [Accessibility](docs/accessibility.md)
- [Migration from 0.0.1](docs/migration.md)

## License

The published package and repository currently use `UNLICENSED` terms.
