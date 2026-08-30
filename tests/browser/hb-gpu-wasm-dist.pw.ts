import { expect, test } from "@playwright/test";

interface EncoderStats {
  readonly workerStarts: number;
  readonly requests: number;
  readonly encodedGlyphs: number;
  readonly syncedFonts: number;
}

interface BrowserEncoder {
  readonly stats: EncoderStats;
  encode(request: {
    readonly fontKey: string;
    readonly fontBytes?: Uint8Array<ArrayBuffer>;
    readonly glyphId: number;
  }): Promise<{
    readonly packedCurveBlob: Uint8Array;
    readonly extents: {
      readonly xBearing: number;
      readonly yBearing: number;
      readonly width: number;
      readonly height: number;
    };
    readonly upem: number;
  }>;
  releaseFont(fontKey: string): Promise<boolean>;
  destroy(): Promise<void>;
}

interface NativeArtifact {
  readonly corpora: readonly {
    readonly id: string;
    readonly fontFile: string;
    readonly glyphs: readonly {
      readonly glyphId: number;
      readonly blobHex: string;
      readonly extents: {
        readonly xBearing: number;
        readonly yBearing: number;
        readonly width: number;
        readonly height: number;
      };
    }[];
  }[];
}

test("loads the packaged optional entry with its default Worker and Wasm URLs", async ({
  page,
}) => {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));

  await page.goto("/benchmarks/hb-gpu/dist-browser.html");
  const result = await page.evaluate(async () => {
    const entryUrl = "/dist/hb-gpu/index.js";
    const hbGpu = (await import(entryUrl)) as {
      readonly HbGpuDrawWorkerEncoder: new () => BrowserEncoder;
    };
    const nativeArtifact = (await fetch(
      "/benchmarks/hb-gpu/results/hb-gpu-draw-native-14.4.0.json",
    ).then((response) => response.json())) as NativeArtifact;
    const corpus = nativeArtifact.corpora.find((candidate) => candidate.id === "cjkv");
    if (corpus === undefined) throw new Error("CJKV corpus is unavailable");
    const expected = corpus.glyphs.find((glyph) => glyph.glyphId === 130);
    if (expected === undefined) throw new Error("CJKV glyph 130 is unavailable");
    const fontResponse = await fetch(`/${corpus.fontFile}`);
    if (!fontResponse.ok) throw new Error(`Font fetch failed with ${String(fontResponse.status)}`);

    const encoder = new hbGpu.HbGpuDrawWorkerEncoder();
    try {
      const encoded = await encoder.encode({
        fontKey: "cjkv\u00001",
        fontBytes: new Uint8Array(await fontResponse.arrayBuffer()),
        glyphId: 130,
      });
      const statsBeforeRelease = encoder.stats;
      const released = await encoder.releaseFont("cjkv\u00001");

      return {
        actualBlobHex: Array.from(encoded.packedCurveBlob, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
        expectedBlobHex: expected.blobHex,
        actualExtents: encoded.extents,
        expectedExtents: expected.extents,
        upem: encoded.upem,
        released,
        statsBeforeRelease,
        statsAfterRelease: encoder.stats,
      };
    } finally {
      await encoder.destroy();
    }
  });

  expect(result.actualBlobHex).toBe(result.expectedBlobHex);
  expect(result.actualExtents).toEqual(result.expectedExtents);
  expect(result.upem).toBe(1_000);
  expect(result.released).toBe(true);
  expect(result.statsBeforeRelease).toMatchObject({
    workerStarts: 1,
    encodedGlyphs: 1,
    syncedFonts: 1,
  });
  expect(result.statsAfterRelease.syncedFonts).toBe(0);
  const unexpectedMessages = messages.filter((message) => !message.startsWith("debug: [vite]"));
  expect(unexpectedMessages, messages.join("\n")).toEqual([]);
});
