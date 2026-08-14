import { FontRegistry, HarfBuzzShaper } from "../src";

const fontPath = await resolveFontPath();
const bytes = new Uint8Array(await Bun.file(fontPath).arrayBuffer());
const registry = new FontRegistry();
await registry.register({ family: "Smoke", source: bytes });
const devanagariFontPath = await resolveDevanagariFontPath();
const devanagariBytes = new Uint8Array(await Bun.file(devanagariFontPath).arrayBuffer());
await registry.register({ family: "DevanagariSmoke", source: devanagariBytes });
const shaper = new HarfBuzzShaper(registry);

const arabic = await shaper.shape({
  family: "Smoke",
  text: "سلام",
  fontSize: 32,
  direction: "rtl",
  language: "ar",
  script: "Arab",
  features: ["liga=1", "kern=1"],
});
const latin = await shaper.shape({
  family: "Smoke",
  text: "office",
  fontSize: 32,
  direction: "ltr",
  language: "en",
  script: "Latn",
  features: ["liga=1", "kern=1"],
});
const devanagari = await shaper.shape({
  family: "DevanagariSmoke",
  text: "नमस्ते",
  fontSize: 32,
  direction: "ltr",
  language: "hi",
  script: "Deva",
  features: ["liga=1", "kern=1"],
});
const bidi = await shaper.shape({
  family: "Smoke",
  text: "abc سلام 123",
  fontSize: 32,
  direction: "rtl",
  language: "ar",
  features: ["liga=1", "kern=1"],
});

assertRun("Arabic", arabic);
assertRun("Latin", latin);
assertRun("Devanagari", devanagari);
assertRun("Bidi", bidi);
const outline = await shaper.getGlyphPath("Smoke", arabic.glyphIds[0] ?? 0, 32);
if (outline.length === 0) {
  throw new Error("HarfBuzz glyph outline is empty");
}

console.log(
  JSON.stringify({
    fontPath,
    fontBytes: bytes.byteLength,
    devanagariFontPath,
    devanagariFontBytes: devanagariBytes.byteLength,
    runtimeLoads: shaper.stats.runtimeLoads,
    arabicGlyphs: arabic.glyphCount,
    arabicClusters: [...arabic.clusters],
    latinGlyphs: latin.glyphCount,
    devanagariGlyphs: devanagari.glyphCount,
    devanagariClusters: [...devanagari.clusters],
    bidiGlyphs: bidi.glyphCount,
    bidiClusters: [...bidi.clusters],
    outlineBytes: outline.length,
  }),
);

shaper.destroy();
registry.destroy();

async function resolveFontPath(): Promise<string> {
  const candidates = [
    Bun.env.GLYPHFLOW_TEST_FONT,
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined && (await Bun.file(candidate).exists())) {
      return candidate;
    }
  }

  throw new Error("Set GLYPHFLOW_TEST_FONT to a readable OpenType font file");
}

async function resolveDevanagariFontPath(): Promise<string> {
  const candidates = [
    Bun.env.GLYPHFLOW_TEST_DEVANAGARI_FONT,
    "/System/Library/Fonts/Supplemental/DevanagariMT.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf",
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined && (await Bun.file(candidate).exists())) {
      return candidate;
    }
  }

  throw new Error("Set GLYPHFLOW_TEST_DEVANAGARI_FONT to a readable Devanagari OpenType font file");
}

function assertRun(
  label: string,
  run: { readonly glyphCount: number; readonly glyphIds: Readonly<Uint32Array> },
): void {
  if (run.glyphCount === 0) {
    throw new Error(`${label} shaping returned zero glyphs`);
  }
  if ([...run.glyphIds].every((glyphId) => glyphId === 0)) {
    throw new Error(`${label} shaping returned only the missing-glyph ID`);
  }
}
