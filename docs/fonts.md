# Fonts and shaping

## Coverage model

Registered binary fonts shape through HarfBuzz and rasterize the exact resulting glyph IDs. The
pipeline covers Latin, CJKV, Arabic, Devanagari, Hebrew, Thai, Greek, Cyrillic, Vietnamese, emoji
fallback, bidirectional runs, OpenType features, and variable-font coordinates.

CJKV typography uses language-specific glyph selection. Pass both a BCP 47 language and an ISO
15924 script when a shared Pan-CJK font contains `locl` forms:

| Locale              | Language | Script |
| ------------------- | -------- | ------ |
| Simplified Chinese  | `zh-CN`  | `Hans` |
| Traditional Chinese | `zh-TW`  | `Hant` |
| Japanese            | `ja`     | `Jpan` |
| Korean              | `ko`     | `Kore` |

The live documentation registers a static Medium instance derived from Noto Sans CJK SC Variable
and exercises all four routes. The static instance gives runtime MSDF generation a deterministic
weight because the upstream variable font defaults to Thin. The
[Noto CJK distribution guide](https://github.com/notofonts/noto-cjk/blob/main/Sans/README.md)
documents full regional coverage and language-tagged localized forms; the demo assets retain those
layout tables under the [SIL Open Font License 1.1](https://github.com/notofonts/noto-cjk/blob/main/Sans/LICENSE).

## Font sources

`FontRegistry.register` accepts system, binary, URL, and PixiJS bitmap sources:

```ts
await layer.fonts.register({ family: "Product UI" });

await layer.fonts.register({
  family: "Product CJKV",
  source: new Uint8Array(cjkvFontBytes),
});

await layer.fonts.register({
  family: "Product Arabic",
  source: new URL("/fonts/ProductArabic.woff2", location.href),
});

await layer.fonts.register({
  family: "HUD Bitmap",
  source: { type: "bitmap", font: bitmapFont, owned: true },
});
```

System registrations use PixiJS bitmap layout. Binary registrations provide HarfBuzz with font
tables and the dynamic rasterizer with outlines. Each successful registration advances a monotonic
font revision and invalidates dependent fallback layouts.

## Fallback chains

```ts
layer.fonts.registerFallback("Product multilingual", [
  "Product CJKV",
  "Product Arabic",
  "Product Devanagari",
  "Product Hebrew",
  "Product Thai",
  "system-ui",
  "sans-serif",
]);
```

Set `fontFamily: "Product multilingual"` in label styles. Fallback aliases may reference other
aliases; expansion preserves order, removes duplicates, and guards cycles. A binary candidate wins
when every shaped glyph ID is present. Layout proceeds through the chain until it finds complete
label coverage, then uses the remaining system-family stack for browser rasterization when needed.

## Per-label shaping

`TextLabelSpec.shaping` and `TextLabelPatch.shaping` expose the inputs that affect glyph selection:

```ts
const title = layer.create({
  text: "繁體中文 · 臺北字型",
  style: {
    fontFamily: "Product multilingual",
    fontSize: 24,
    fill: 0xffffff,
  },
  shaping: {
    direction: "ltr",
    language: "zh-TW",
    script: "Hant",
    features: ["kern", "liga"],
    variations: { wght: 560 },
  },
});

layer.update(title, {
  text: "العربية · مرحبا",
  shaping: { direction: "rtl", language: "ar", script: "Arab" },
});
await layer.commit();
```

Omitted fields use HarfBuzz detection and font defaults. `shaping: null` clears an existing
override. The layer stores overrides in a sparse `TextId` map, preserving the dense store's fixed
reference-slot budget for million-label scenes.

## Worker shaping

The default `LayoutEngine` creates `HarfBuzzWorkerShaper`. Its worker URL resolves from the package
`text-worker.js` export. Font bytes transfer once per registration revision, and source revisions
discard superseded responses.

Worker bundles use ESM because HarfBuzzJS initializes through top-level `await`. For Vite, set
`worker.format` to `"es"` and `build.target` to `"es2022"` as shown in the
[getting-started bundler configuration](getting-started.md#bundler-configuration).

Direct shaping remains available through the shaping subpath:

```ts
import { HarfBuzzShaper } from "pixi-glyphflow/shaping";

const shaper = new HarfBuzzShaper(layer.fonts);
const run = await shaper.shape({
  text: "مرحبا",
  family: "Product Arabic",
  fontSize: 24,
  direction: "rtl",
  language: "ar",
  script: "Arab",
});
```

## Explicit Vite MSDF assets

Vite applications can bundle the generator worker and WebAssembly module explicitly. This gives
production builds stable hashed URLs and keeps the worker's `comlink` dependency inside its chunk:

```ts
import { MSDF } from "@zappar/msdf-generator";
import msdfWasmUrl from "@zappar/msdf-generator/msdfgen_wasm.wasm?url";
import msdfWorkerUrl from "@zappar/msdf-generator/worker.js?worker&url";
import { TextLayer } from "pixi-glyphflow";

const layer = new TextLayer({
  renderer: app.renderer,
  rendering: {
    rasterizerOptions: {
      generatorConcurrency: 4,
      distanceFieldMinFontSize: 48,
      createMsdfGenerator: () =>
        Promise.resolve(new MSDF({ workerUrl: msdfWorkerUrl, wasmUrl: msdfWasmUrl })),
    },
  },
});
```

Add `@zappar/msdf-generator@1.2.4` as a direct application dependency when the app imports these
asset entry points. The provider initializes workers lazily, runs separate workers in parallel, and
serializes font loading plus atlas generation inside each worker.

`tinySdf: true` builds HarfBuzz glyphs with a local SDF from the canvas mask. Binary fonts are
installed as `FontFace` for that path. MSDF generation stays on `@zappar/msdf-generator` unless
this flag is set. `distanceFieldMinFontSize` defaults to `48`. Smaller layout sizes generate a higher-resolution
distance field and store its physical-to-logical raster scale with the atlas entry. Glyph geometry,
stroke, and shadow effects remain in layout units while CJK strokes retain enough source detail for
zooming. Raise the value for unusually intricate display fonts; the trade-off is atlas memory and
generation time.

The dynamic generator consumes the outline encoded by the supplied font bytes. For a precise
variable-font weight, register a static instance at that axis location. `shaping.variations`
continues to control HarfBuzz glyph selection and positioning.

## Glyph-ID rasterization

MSDF generators accept Unicode characters while HarfBuzz returns glyph IDs. Direct cmap matches
reuse the registered font bytes. Contextual forms, ligatures, and CJK `locl` alternates receive a
temporary cmap mapping in a cloned font buffer, so raster output matches the exact shaped glyph.
The registered source bytes remain immutable.

Prebuilt MSDF/SDF pages provide deterministic startup and stable cache contents. Pass them through
`rasterizerOptions.prebuilt` so `RasterGlyphProvider` crops those glyphs before TinySDF or MSDF.
Keys are `prebuiltGlyphKey` identities and omit font revision. Dynamic providers cover the long
tail: alpha and color glyphs plus binary-font outlines that are not on a page. `GlyphAtlas`
publishes staged entries at frame boundaries, pins visible entries, evicts least-recently-used
unpinned entries, and keeps allocation within its configured byte ceiling.

## Operational guidance

- Register binary fonts before the first multilingual commit.
- Match fallback order to the product typography system.
- Set `language` and `script` for CJKV regional forms and product-critical complex text.
- Reuse text, style, and shaping values to maximize cross-label shape-cache hits.
- Package production fonts with explicit redistribution rights.
- Use prebuilt distance fields for large, stable icon or CJK sets.
