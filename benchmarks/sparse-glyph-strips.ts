import { prepareOutlineGlyph } from "../src/render/outline/prepare";
import { rasterizeOutlineCpu } from "../src/render/outline/reference";
import {
  SPARSE_STRIP_LAYOUT,
  colorizeSparseStripGlyph,
  decodeSparseStripCoverage,
  encodeSparseStripGlyph,
  sparseGlyphStripPixelBucket,
} from "../src/render/outline/sparseStrips";
import type { OutlineColor, PreparedOutlineGlyph } from "../src/render/outline/types";

const DEFAULT_PIXEL_HEIGHTS = Object.freeze([256, 512, 1_024] as const);
const DEFAULT_COLOR = Object.freeze([0.2, 0.65, 1, 0.8] as const);

export interface SparseGlyphStripBenchmarkOptions {
  readonly pixelHeights?: readonly number[];
  readonly padding?: number;
  readonly color?: OutlineColor;
  readonly warmupIterations?: number;
  readonly sampleIterations?: number;
}

export interface SparseGlyphStripBenchmarkTiming {
  readonly coldEncodeMs: number;
  readonly coldDecodeMs: number;
  readonly coldRehydrateMs: number;
  readonly warmDecodeP50Ms: number;
  readonly warmDecodeP95Ms: number;
  readonly warmRehydrateP50Ms: number;
  readonly warmRehydrateP95Ms: number;
}

export interface SparseGlyphStripBenchmarkMemory {
  readonly allocatedBytes: number;
  /** Temporary tile classification used by the two-pass encoder. */
  readonly encodingScratchBytes: number;
  readonly peakPayloadBytes: number;
  readonly denseEquivalentBytes: number;
  readonly ratio: number;
  readonly peakRatio: number;
}

export interface SparseGlyphStripBenchmarkBucket {
  readonly pixelHeight: number;
  readonly width: number;
  readonly height: number;
  readonly stripCount: number;
  readonly boundaryCoverageBytes: number;
  readonly timing: Readonly<SparseGlyphStripBenchmarkTiming>;
  readonly memory: Readonly<SparseGlyphStripBenchmarkMemory>;
  readonly coverageHash: string;
  readonly rehydratedHash: string;
}

export interface SparseGlyphStripBenchmarkResult {
  readonly schemaVersion: 1;
  readonly warmupIterations: number;
  readonly sampleIterations: number;
  readonly buckets: readonly Readonly<SparseGlyphStripBenchmarkBucket>[];
}

/** Measure sparse-strip encode, repeated decode, and RGBA rehydration without writing artifacts. */
export function measureSparseGlyphStrips(
  glyph: Readonly<PreparedOutlineGlyph>,
  options: Readonly<SparseGlyphStripBenchmarkOptions> = {},
): Readonly<SparseGlyphStripBenchmarkResult> {
  const pixelHeights = options.pixelHeights ?? DEFAULT_PIXEL_HEIGHTS;
  if (pixelHeights.length === 0) throw new TypeError("pixelHeights must contain a bucket");
  for (const pixelHeight of pixelHeights) assertPositiveInteger("pixelHeight", pixelHeight);
  const padding = options.padding ?? 1;
  assertNonNegativeInteger("padding", padding);
  const warmupIterations = options.warmupIterations ?? 5;
  const sampleIterations = options.sampleIterations ?? 20;
  assertNonNegativeInteger("warmupIterations", warmupIterations);
  assertPositiveInteger("sampleIterations", sampleIterations);
  const color = options.color ?? DEFAULT_COLOR;

  const physicalPixelHeights = [...new Set(pixelHeights.map(sparseGlyphStripPixelBucket))];
  const buckets = physicalPixelHeights.map((pixelHeight) =>
    measureBucket(glyph, pixelHeight, padding, color, warmupIterations, sampleIterations),
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    warmupIterations,
    sampleIterations,
    buckets: Object.freeze(buckets),
  });
}

function measureBucket(
  glyph: Readonly<PreparedOutlineGlyph>,
  pixelHeight: number,
  padding: number,
  color: OutlineColor,
  warmupIterations: number,
  sampleIterations: number,
): Readonly<SparseGlyphStripBenchmarkBucket> {
  const coverageBitmap = rasterizeOutlineCpu(glyph, {
    pixelHeight,
    padding,
    color: [1, 1, 1, 1],
  });
  const encodeStart = performance.now();
  const sparse = encodeSparseStripGlyph(coverageBitmap);
  const coldEncodeMs = performance.now() - encodeStart;

  const decodeStart = performance.now();
  const coldCoverage = decodeSparseStripCoverage(sparse);
  const coldDecodeMs = performance.now() - decodeStart;
  const rehydrateStart = performance.now();
  const coldRehydrated = colorizeSparseStripGlyph(sparse, color);
  const coldRehydrateMs = performance.now() - rehydrateStart;
  const coverageHash = hashBytes(coldCoverage);
  const rehydratedHash = hashBytes(coldRehydrated.pixels);

  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    decodeSparseStripCoverage(sparse);
    colorizeSparseStripGlyph(sparse, color);
  }

  const decodeSamples: number[] = [];
  const rehydrateSamples: number[] = [];
  for (let iteration = 0; iteration < sampleIterations; iteration += 1) {
    const warmDecodeStart = performance.now();
    const decoded = decodeSparseStripCoverage(sparse);
    decodeSamples.push(performance.now() - warmDecodeStart);
    const warmRehydrateStart = performance.now();
    const rehydrated = colorizeSparseStripGlyph(sparse, color);
    rehydrateSamples.push(performance.now() - warmRehydrateStart);
    if (hashBytes(decoded) !== coverageHash || hashBytes(rehydrated.pixels) !== rehydratedHash) {
      throw new Error("sparse strip benchmark output hash changed across warm samples");
    }
  }

  decodeSamples.sort((first, second) => first - second);
  rehydrateSamples.sort((first, second) => first - second);
  return Object.freeze({
    pixelHeight,
    width: sparse.width,
    height: sparse.height,
    stripCount: sparse.strips.length / SPARSE_STRIP_LAYOUT.recordWords,
    boundaryCoverageBytes: sparse.coverage.byteLength,
    timing: Object.freeze({
      coldEncodeMs,
      coldDecodeMs,
      coldRehydrateMs,
      warmDecodeP50Ms: percentile(decodeSamples, 0.5),
      warmDecodeP95Ms: percentile(decodeSamples, 0.95),
      warmRehydrateP50Ms: percentile(rehydrateSamples, 0.5),
      warmRehydrateP95Ms: percentile(rehydrateSamples, 0.95),
    }),
    memory: Object.freeze({
      allocatedBytes: sparse.allocatedBytes,
      encodingScratchBytes: sparse.tileColumns * sparse.tileRows,
      peakPayloadBytes: sparse.allocatedBytes + sparse.tileColumns * sparse.tileRows,
      denseEquivalentBytes: sparse.denseEquivalentBytes,
      ratio: sparse.allocatedBytes / sparse.denseEquivalentBytes,
      peakRatio:
        (sparse.allocatedBytes + sparse.tileColumns * sparse.tileRows) /
        sparse.denseEquivalentBytes,
    }),
    coverageHash,
    rehydratedHash,
  });
}

function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c_9dc5;
  for (const value of bytes) hash = Math.imul(hash ^ value, 0x0100_0193) >>> 0;
  return `0x${hash.toString(16).padStart(8, "0")}`;
}

function percentile(sorted: readonly number[], ratio: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  const value = sorted[index];
  if (value === undefined) throw new TypeError("benchmark timing samples are unavailable");
  return value;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

async function loadDefaultBenchmarkGlyph(): Promise<Readonly<PreparedOutlineGlyph>> {
  const artifact = (await Bun.file(
    new URL("./hb-gpu/results/hb-gpu-draw-native-14.4.0.json", import.meta.url),
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

if (import.meta.main) {
  console.log(JSON.stringify(measureSparseGlyphStrips(await loadDefaultBenchmarkGlyph()), null, 2));
}
