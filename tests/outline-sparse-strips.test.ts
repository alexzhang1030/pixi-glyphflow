import { describe, expect, test } from "bun:test";

import { measureSparseGlyphStrips } from "../benchmarks/sparse-glyph-strips";
import { prepareOutlineGlyph } from "../src/render/outline/prepare";
import { rasterizeOutlineCpu } from "../src/render/outline/reference";
import {
  SPARSE_STRIP_LAYOUT,
  SPARSE_STRIP_SCHEMA_VERSION,
  SparseGlyphStripCache,
  colorizeSparseStripGlyph,
  createSparseGlyphStripKey,
  decodeSparseStripCoverage,
  encodeSparseStripGlyph,
  sparseGlyphStripPixelBucket,
  validateSparseStripGlyph,
} from "../src/render/outline/sparseStrips";
import type { OutlineCpuBitmap, PreparedOutlineGlyph } from "../src/render/outline/types";
import { packedRectangle } from "./fixtures/outlineFixtures";

describe("sparse glyph strips", () => {
  test("encodes a versioned 4x4 GPU storage layout with implicit solid coverage", () => {
    const bitmap = rgbaBitmap(9, 6, (x, y) => {
      if (x < 4 && y < 4) return 255;
      if (x === 8 && y === 5) return 127;
      return 0;
    });
    const glyph = encodeSparseStripGlyph(bitmap);

    expect(glyph).toMatchObject({
      schemaVersion: SPARSE_STRIP_SCHEMA_VERSION,
      tileSize: 4,
      width: 9,
      height: 6,
      tileColumns: 3,
      tileRows: 2,
      denseEquivalentBytes: 54,
    });
    expect(Array.from(glyph.header)).toEqual([0x5353_4731, 1, 4, 9, 6, 3, 2, 2, 4, 16, 54, 0]);
    expect(Array.from(glyph.strips)).toEqual([
      0,
      0,
      1,
      SPARSE_STRIP_LAYOUT.solidCoverageSentinel,
      1,
      2,
      3,
      0,
    ]);
    expect(glyph.coverage).toHaveLength(16);
    expect(glyph.coverage[4]).toBe(127);
    expect(glyph.allocatedBytes).toBe(
      glyph.header.byteLength + glyph.strips.byteLength + glyph.coverage.byteLength,
    );
    expect(decodeSparseStripCoverage(glyph)).toEqual(alphaBytes(bitmap));
    validateSparseStripGlyph(glyph);
  });

  test("matches a real HarfBuzz outline raster within two premultiplied channel levels", async () => {
    const prepared = await realPreparedGlyph();
    const color = [0.31, 0.68, 0.92, 0.73] as const;
    const bitmap = rasterizeOutlineCpu(prepared, {
      pixelHeight: 256,
      padding: 2,
      color,
    });
    const sparse = encodeSparseStripGlyph(bitmap, { sourceAlpha: color[3] });
    const rehydrated = colorizeSparseStripGlyph(sparse, color);

    let maximumDelta = 0;
    let inkPixels = 0;
    for (let index = 0; index < bitmap.pixels.length; index += 4) {
      const originalAlpha = bitmap.pixels[index + 3] ?? 0;
      const decodedAlpha = rehydrated.pixels[index + 3] ?? 0;
      if (originalAlpha > 0) inkPixels += 1;
      if (originalAlpha === 0) {
        expect(Array.from(rehydrated.pixels.slice(index, index + 4))).toEqual([0, 0, 0, 0]);
      }
      for (let channel = 0; channel < 4; channel += 1) {
        maximumDelta = Math.max(
          maximumDelta,
          Math.abs(
            (bitmap.pixels[index + channel] ?? 0) - (rehydrated.pixels[index + channel] ?? 0),
          ),
        );
      }
      expect(Math.abs(originalAlpha - decodedAlpha)).toBeLessThanOrEqual(1);
    }

    expect(inkPixels).toBeGreaterThan(0);
    expect(maximumDelta).toBeLessThanOrEqual(2);
    expect(sparse.strips.length).toBeGreaterThan(0);
  });

  test("compresses a prepared solid outline below its dense alpha footprint", () => {
    const prepared = rectanglePreparedGlyph();
    const bitmap = rasterizeOutlineCpu(prepared, {
      pixelHeight: 512,
      padding: 2,
      color: [1, 1, 1, 1],
    });
    const sparse = encodeSparseStripGlyph(bitmap);

    expect(sparse.allocatedBytes / sparse.denseEquivalentBytes).toBeLessThan(0.55);
    expect(sparse.coverage.byteLength).toBeLessThan(sparse.denseEquivalentBytes / 10);
    expect(colorizeSparseStripGlyph(sparse, [1, 1, 1, 1]).pixels).toEqual(bitmap.pixels);
  });

  test("buckets continuous zoom and keys every outline identity field", () => {
    expect([
      sparseGlyphStripPixelBucket(256),
      sparseGlyphStripPixelBucket(256.1),
      sparseGlyphStripPixelBucket(511.9),
      sparseGlyphStripPixelBucket(512.1),
    ]).toEqual([256, 512, 512, 1_024]);
    const base = {
      family: "Fixture\0Family",
      fontRevision: 7,
      glyphId: 42,
      variationKey: "wght=650",
      pixelHeight: 257,
      padding: 2,
      aaMode: "grayscale" as const,
    };
    const first = createSparseGlyphStripKey(base);

    expect(createSparseGlyphStripKey({ ...base, pixelHeight: 511 })).toBe(first);
    expect(createSparseGlyphStripKey({ ...base, pixelHeight: 513 })).not.toBe(first);
    expect(
      createSparseGlyphStripKey({ ...base, family: "Fixture", variationKey: "Family\0wght=650" }),
    ).not.toBe(first);
    expect(createSparseGlyphStripKey({ ...base, fontRevision: 8 })).not.toBe(first);
    expect(createSparseGlyphStripKey({ ...base, glyphId: 43 })).not.toBe(first);
    expect(createSparseGlyphStripKey({ ...base, variationKey: "wght=651" })).not.toBe(first);
    expect(createSparseGlyphStripKey({ ...base, padding: 3 })).not.toBe(first);
    expect(createSparseGlyphStripKey({ ...base, aaMode: "binary" })).not.toBe(first);
  });

  test("applies binary AA at the normalized half-coverage boundary", () => {
    const bitmap = rgbaBitmap(4, 4, (x) => (x < 2 ? 127 : 128));
    const sparse = encodeSparseStripGlyph(bitmap, { aaMode: "binary" });
    const decoded = decodeSparseStripCoverage(sparse);

    expect(Array.from(decoded.slice(0, 4))).toEqual([0, 0, 255, 255]);
    expect(new Set(decoded)).toEqual(new Set([0, 255]));
  });

  test("evicts by bytes, keeps LRU hits, and protects deterministic key payloads", () => {
    const first = encodeSparseStripGlyph(rgbaBitmap(8, 8, () => 255));
    const second = encodeSparseStripGlyph(rgbaBitmap(8, 8, () => 192));
    const third = encodeSparseStripGlyph(rgbaBitmap(8, 8, () => 128));
    const cache = new SparseGlyphStripCache({
      maxBytes: first.allocatedBytes + second.allocatedBytes,
    });

    expect(cache.set("first", first)).toBe(true);
    expect(cache.set("second", second)).toBe(true);
    expect(cache.get("first")).toEqual(first);
    expect(cache.set("third", third)).toBe(true);

    expect(cache.get("second")).toBeUndefined();
    expect(cache.get("first")).toEqual(first);
    expect(cache.get("third")).toEqual(third);
    expect(cache.stats).toMatchObject({
      entries: 2,
      bytes: first.allocatedBytes + third.allocatedBytes,
      evictions: 1,
    });
    expect(() => cache.set("first", third)).toThrow("different glyph payload");
    expect(cache.set("first-copy", encodeSparseStripGlyph(rgbaBitmap(8, 8, () => 255)))).toBe(true);
    expect(cache.clear()).toBe(2);
    expect(cache.stats.entries).toBe(0);
  });

  test("keeps cached payloads isolated and preserves entries around an oversized glyph", () => {
    const first = encodeSparseStripGlyph(rgbaBitmap(4, 4, () => 255));
    const second = encodeSparseStripGlyph(rgbaBitmap(4, 4, () => 128));
    const oversized = encodeSparseStripGlyph(rgbaBitmap(8, 8, () => 128));
    const cache = new SparseGlyphStripCache({
      maxBytes: first.allocatedBytes + second.allocatedBytes,
    });

    expect(cache.set("first", first)).toBe(true);
    expect(cache.set("second", second)).toBe(true);
    const borrowed = cache.get("first");
    if (borrowed === undefined) throw new Error("cached glyph is unavailable");
    borrowed.header[SPARSE_STRIP_LAYOUT.header.width] = 999;
    expect(cache.get("first")?.width).toBe(4);
    expect(cache.get("first")?.header[SPARSE_STRIP_LAYOUT.header.width]).toBe(4);

    expect(cache.set("oversized", oversized)).toBe(false);
    expect(cache.stats.entries).toBe(2);
    expect(cache.get("second")).toEqual(second);
  });

  test("keeps throwing factories outside cache state and interns successful creation", () => {
    const glyph = encodeSparseStripGlyph(rgbaBitmap(4, 4, () => 255));
    const cache = new SparseGlyphStripCache({ maxBytes: glyph.allocatedBytes * 2 });
    let calls = 0;

    expect(() =>
      cache.getOrCreate("fixture", () => {
        calls += 1;
        throw new Error("factory failed");
      }),
    ).toThrow("factory failed");
    expect(cache.stats.entries).toBe(0);
    expect(
      cache.getOrCreate("fixture", () => {
        calls += 1;
        return glyph;
      }),
    ).toEqual(glyph);
    expect(
      cache.getOrCreate("fixture", () => {
        calls += 1;
        return glyph;
      }),
    ).toEqual(glyph);
    expect(calls).toBe(2);
  });

  test("validates bitmap input and the complete storage contract", () => {
    expect(() =>
      encodeSparseStripGlyph({
        width: 4,
        height: 4,
        bytesPerRow: 12,
        pixels: new Uint8Array(64),
      }),
    ).toThrow("bytesPerRow");
    expect(() => sparseGlyphStripPixelBucket(0)).toThrow("finite and positive");
    expect(() =>
      createSparseGlyphStripKey({
        family: "",
        fontRevision: 0,
        glyphId: 0,
        pixelHeight: 16,
        padding: 1,
        aaMode: "grayscale",
      }),
    ).toThrow("family");

    const valid = encodeSparseStripGlyph(rgbaBitmap(5, 5, () => 255));
    const changedHeader = valid.header.slice();
    changedHeader[SPARSE_STRIP_LAYOUT.header.width] = 6;
    expect(() => validateSparseStripGlyph({ ...valid, header: changedHeader })).toThrow(
      "header word 3 mismatch",
    );
    const changedRecords = valid.strips.slice();
    changedRecords[5] = 0;
    expect(() => validateSparseStripGlyph({ ...valid, strips: changedRecords })).toThrow(
      "disjoint and row-major",
    );
    const partialSolid = valid.strips.slice();
    partialSolid[SPARSE_STRIP_LAYOUT.record.tileX1] = 2;
    expect(() => validateSparseStripGlyph({ ...valid, strips: partialSolid })).toThrow(
      "complete 4x4 tiles",
    );
  });

  test("benchmarks configurable buckets with stable decode and rehydrate hashes", () => {
    const result = measureSparseGlyphStrips(rectanglePreparedGlyph(), {
      pixelHeights: [64, 65, 127, 129],
      warmupIterations: 1,
      sampleIterations: 2,
    });

    expect(result).toMatchObject({ schemaVersion: 1, warmupIterations: 1, sampleIterations: 2 });
    expect(result.buckets.map((bucket) => bucket.pixelHeight)).toEqual([64, 128, 256]);
    for (const bucket of result.buckets) {
      expect(bucket.stripCount).toBeGreaterThan(0);
      expect(bucket.memory.ratio).toBeLessThan(1);
      expect(bucket.coverageHash).toMatch(/^0x[0-9a-f]{8}$/);
      expect(bucket.rehydratedHash).toMatch(/^0x[0-9a-f]{8}$/);
      expect(bucket.timing.warmDecodeP95Ms).toBeGreaterThanOrEqual(0);
      expect(bucket.timing.warmRehydrateP95Ms).toBeGreaterThanOrEqual(0);
    }
  });
});

function rgbaBitmap(
  width: number,
  height: number,
  alphaAt: (x: number, y: number) => number,
): Readonly<OutlineCpuBitmap> {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = alphaAt(x, y);
      const offset = (y * width + x) * 4;
      pixels[offset] = alpha;
      pixels[offset + 1] = alpha;
      pixels[offset + 2] = alpha;
      pixels[offset + 3] = alpha;
    }
  }
  return Object.freeze({ width, height, bytesPerRow: width * 4, pixels });
}

function alphaBytes(bitmap: Readonly<OutlineCpuBitmap>): Uint8Array {
  const alpha = new Uint8Array(bitmap.width * bitmap.height);
  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      alpha[y * bitmap.width + x] = bitmap.pixels[y * bitmap.bytesPerRow + x * 4 + 3] ?? 0;
    }
  }
  return alpha;
}

function rectanglePreparedGlyph(): Readonly<PreparedOutlineGlyph> {
  const prepared = prepareOutlineGlyph({
    extents: { xBearing: 0, yBearing: 4, width: 4, height: -4 },
    packedCurveBlob: packedRectangle(),
  });
  if (prepared.status !== "ready") throw new Error(`unexpected ${prepared.status} result`);
  return prepared.glyph;
}

async function realPreparedGlyph(): Promise<Readonly<PreparedOutlineGlyph>> {
  const artifact = (await Bun.file(
    new URL("../benchmarks/hb-gpu/results/hb-gpu-draw-native-14.4.0.json", import.meta.url),
  ).json()) as {
    readonly corpora: readonly {
      readonly id: string;
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
  };
  const fixture = artifact.corpora
    .find((corpus) => corpus.id === "arabic")
    ?.glyphs.find((glyph) => glyph.glyphId === 4);
  if (fixture === undefined) throw new Error("Arabic glyph 4 is absent from the packed artifact");
  const prepared = prepareOutlineGlyph({
    extents: fixture.extents,
    packedCurveBlob: decodeHex(fixture.blobHex),
  });
  if (prepared.status !== "ready") throw new Error(`unexpected ${prepared.status} result`);
  return prepared.glyph;
}

function decodeHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new TypeError("hex must contain whole bytes");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
