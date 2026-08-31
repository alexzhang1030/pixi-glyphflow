# pixi-glyphflow

A million-label text layer for PixiJS 8 with compact CPU storage, instanced WebGL/WebGPU rendering,
worker shaping, bounded glyph atlases, dense culling, and first-class pixi-viewport integration.

## Highlights

- One `TextLayer` retains 1,000,000 labels in 72 MiB of fixed-width CPU storage.
- One instanced draw submits 8,000,000 visible glyphs through a 32-byte glyph record.
- Two atlas texture arrays (R8 and RGBA8) bind every page as a layer, so mixed modes stay one draw.
- Explicit WebGPU GPU-scene residency keeps one million label records, up to 64 prototypes, and up
  to 8 canonical paints on the GPU while camera commits refresh one compute viewport uniform.
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

### Opt into GPU-scene residency

Viewport residency remains the default. A uniform WebGPU scene can explicitly retain its full
label record set on the GPU:

```ts
import { Application } from "pixi.js";
import { requestComputeCullGpu, TextLayer } from "pixi-glyphflow";

const gpu = await requestComputeCullGpu();
const residentApp = new Application();
await residentApp.init({ gpu, preference: ["webgpu", "webgl"] });

const labels = new TextLayer({
  renderer: residentApp.renderer,
  initialCapacity: 1_000_000,
  culling: {
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    residency: "gpu-scene",
  },
});
residentApp.stage.addChild(labels);

const residentStyle = { fontFamily: "Inter", fontSize: 18, fill: 0xffffff };
labels.createMany([
  { text: "GPU resident", x: 48, y: 64, style: residentStyle },
  { text: "GPU resident", x: 192, y: 64, style: residentStyle },
  { text: "GPU resident", x: 336, y: 64, style: residentStyle },
]);

await labels.commit();
console.log(labels.stats.residencyActive, labels.stats.residencyFallbackReason);
```

A capable WebGPU renderer prints `"gpu-scene"` and `undefined`. Other capability outcomes print
`"viewport"` plus the stable fallback reason.

Activation requires WebGPU compute culling, the storage palette, sufficient device limits,
collision disabled, and up to 64 visible fill-only prototypes across 8 canonical paints with unit
transforms, zero anchors/z, and normal blending. Unsupported devices and scene mutations continue
through viewport residency and expose a stable `residencyFallbackReason`. Camera-only commits skip
CPU spatial queries and admission. Sorted, unique, strictly contiguous active slots use the dense
exact-f32 lane: 8 bytes per mover plus a 16-byte
`baseSlot`/`count` header, or 800,016 bytes for 100,000 movers. Sparse, reordered, and duplicate
inputs use the indexed 12-byte ABI with last-write-wins identity. Both lanes keep
`cullRecordUploadBytes` unchanged. WebGPU stages palette patch, cull,
and Pixi render work into one product command buffer; the frame-transaction total, fused, and
standalone counters expose that submission truth.

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

Stream positions and per-label rotation together:

```ts
const rotations = new Float32Array(ids.length); // Radians, one value per label.
rotations.fill(Math.PI / 6);
labels.updateTransforms(ids, positions, rotations);
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

| Import                          | Purpose                                                             |
| ------------------------------- | ------------------------------------------------------------------- |
| `pixi-glyphflow`                | `TextLayer`, `FontRegistry`, and primary types                      |
| `pixi-glyphflow/viewport`       | pixi-viewport binding                                               |
| `pixi-glyphflow/accessibility`  | Sparse DOM accessibility mirror                                     |
| `pixi-glyphflow/shaping`        | HarfBuzz main-thread and worker shapers                             |
| `pixi-glyphflow/advanced`       | Atlas, mesh, layout, spatial, and symbol-continuity primitives      |
| `pixi-glyphflow/prebuilt`       | Optional ASCII / charset SDF pages for `rasterizerOptions.prebuilt` |
| `pixi-glyphflow/outline`        | Huge-glyph compute plugin and opt-in sparse-strip cache laboratory  |
| `pixi-glyphflow/hb-gpu`         | Packed HarfBuzz GPU Draw Worker/Wasm encoder                        |
| `pixi-glyphflow/text-worker.js` | Worker module used by the default complex-script pipeline           |

## Reference performance

The committed browser artifacts use Chrome on an Apple M1 Pro, isolated processes, explicit GPU
completion, warmup frames, and p95 reporting. The 1.1.0 rows are the published WebGL baseline. The
GPU-resident rows come from the current WebGPU 1.2.0 schema 7 raw runs and schema 4 promotion
aggregate with 1,000,000 labels and 100,000 movers.

| Workload                          |                           Scale | Frame p95 |
| --------------------------------- | ------------------------------: | --------: |
| Million-label viewport            |              1,000,000 resident |   5.40 ms |
| Dynamic counters                  | 100,000 text + position updates |  16.40 ms |
| pixi-viewport drag + deceleration |              1,000,000 resident |   5.80 ms |
| pixi-viewport wheel + pinch zoom  |              1,000,000 resident |   7.60 ms |
| Position storm                    |          100,000 packed updates |   9.50 ms |
| Multilingual stream               |  10,000 resident, 1,000 updates |   1.50 ms |
| GPU-resident camera, five-run set |    1,000,000 / 50,000 submitted |  11.30 ms |
| GPU-resident position, five runs  |          100,000 packed updates |  14.00 ms |
| GPU-resident position, 600 frames |          100,000 packed updates |  13.80 ms |

The [current promotion aggregate](benchmarks/results/browser-gpu-scene-resident-webgpu-promotion-repeatability-1.2.0.json)
joins five independent 120-camera / 120-position runs and one independent 600-camera /
600-position run from one production build, harness, and runtime fingerprint. Every run reads
50,000 ordered GPU references with hash `0x45cfd045`, pixel hash `0xa8ad90b4`, and 302,457
non-transparent pixels. Product/timestamp fusion records 1,300/1,300/0
readback/fused/standalone submissions across the five formal runs and 1,220/1,220/0 in the
sustained run.

Truth repeatability and formal performance are GO. All five formal runs pass every budget: camera
p95/p99/max is 7.9/9.4/10.6 ms and position is 9.8/11.0/12.5 ms, with 0/600 frames above
16.67 ms in each phase. The sustained run records camera p95/p99/max 10.5/13.5/21.5 ms with
4/600 overruns and position 8.1/9.9/11.6 ms with zero overruns. All 1,300 formal segmented samples
resolve palette, cull, and scene-render timestamps with zero fallback; segment p95 is
0.13/0.59/5.44 ms.
The current dense mover lane uploads exactly 800,016 bytes for 100,000 movers. The
[generated performance report](benchmarks/PERFORMANCE.md) links the current source artifacts,
evidence hashes, provenance fingerprints, historical checkpoints, and all gate outcomes.

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
