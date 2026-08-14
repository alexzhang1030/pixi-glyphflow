# Fonts and shaping

## Font sources

`FontRegistry.register` accepts system, binary, URL, and PixiJS bitmap sources:

```ts
await layer.fonts.register({ family: "Inter" });

await layer.fonts.register({
  family: "Noto Sans Arabic",
  source: new Uint8Array(fontBytes),
});

await layer.fonts.register({
  family: "Noto Sans Devanagari",
  source: new URL("/fonts/NotoSansDevanagari.woff2", location.href),
});

await layer.fonts.register({
  family: "HUD Bitmap",
  source: { type: "bitmap", font: bitmapFont, owned: true },
});
```

System registrations use PixiJS bitmap layout. Binary registrations use HarfBuzz shaping and
provide glyph outlines to dynamic raster providers. Each registration advances a monotonic font
revision.

## Fallback chains

```ts
layer.fonts.registerFallback("ui", [
  "Inter",
  "Noto Sans CJK SC",
  "Noto Sans Arabic",
  "Noto Sans Devanagari",
  "Noto Color Emoji",
]);
```

Set `fontFamily: "ui"` in label styles. Layout resolves the chain in order and keys cached work by
font revision and style.

## Worker shaping

The default `LayoutEngine` creates `HarfBuzzWorkerShaper`. Its worker URL resolves from the package
`text-worker.js` export. Font bytes transfer once per registration revision. Superseded responses
are discarded through label source revisions.

Direct shaping remains available through the shaping subpath:

```ts
import { HarfBuzzShaper } from "pixi-glyphflow/shaping";

const shaper = new HarfBuzzShaper(layer.fonts);
const run = await shaper.shape({
  text: "مرحبا",
  family: "Noto Sans Arabic",
  fontSize: 24,
  direction: "rtl",
});
```

## Prebuilt and dynamic glyphs

Prebuilt MSDF/SDF pages provide deterministic startup and stable cache contents. Dynamic raster
providers cover alpha and color glyphs plus binary-font outlines. `GlyphAtlas` publishes staged
entries at frame boundaries, pins visible entries, evicts least-recently-used unpinned entries, and
keeps allocation within its configured byte ceiling.

## Operational guidance

- Register binary fonts before the first multilingual commit.
- Use a fallback chain whose order matches product typography.
- Reuse style objects across labels to maximize layout cache hits.
- Package production fonts with explicit redistribution rights.
- Use prebuilt distance fields for large, stable icon or CJK sets.
