import { FontRegistry, HarfBuzzWorkerShaper } from "../dist/index.js";

const fontPath = await resolveFontPath();
const bytes = new Uint8Array(await Bun.file(fontPath).arrayBuffer());
const registry = new FontRegistry();
await registry.register({ family: "WorkerSmoke", source: bytes });
const shaper = new HarfBuzzWorkerShaper(registry);

try {
  const run = await shaper.shape(1, 1, {
    family: "WorkerSmoke",
    text: "سلام office",
    fontSize: 32,
    direction: "rtl",
    language: "ar",
    features: ["liga=1", "kern=1"],
  });
  if (run.glyphCount === 0) {
    throw new Error("Worker shaping returned zero glyphs");
  }
  if ([...run.glyphIds].every((glyphId) => glyphId === 0)) {
    throw new Error("Worker shaping returned only the missing-glyph ID");
  }

  console.log(
    JSON.stringify({
      fontPath,
      fontBytes: bytes.byteLength,
      glyphs: run.glyphCount,
      clusters: [...run.clusters],
      workerStarts: shaper.stats.workerStarts,
      syncedFonts: shaper.stats.syncedFonts,
      queueDepth: shaper.stats.queueDepth,
    }),
  );
} finally {
  shaper.destroy();
  registry.destroy();
}

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
