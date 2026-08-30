import { requestComputeCullGpu } from "../../src";
import { prepareOutlineGlyph } from "../../src/render/outline/prepare";
import { rasterizeOutlineCpu } from "../../src/render/outline/reference";
import {
  createSparseStripComputeRasterizer,
  packSparseStripComputeBatch,
  type SparseStripComputeBatch,
  type SparseStripComputeRequest,
} from "../../src/render/outline/sparseStripCompute";
import {
  colorizeSparseStripGlyph,
  encodeSparseStripGlyph,
  sparseGlyphStripPixelBucket,
} from "../../src/render/outline/sparseStrips";
import type {
  OutlineColor,
  OutlineCpuBitmap,
  PreparedOutlineGlyph,
} from "../../src/render/outline/types";
import { readRgba8Texture } from "../fixtures/outlineFixtures";

interface SparseStripBrowserResult {
  readonly capability: "supported" | "unsupported";
  readonly status: "ready" | "unsupported";
  readonly entryCount: number;
  readonly atlasWidth: number;
  readonly atlasHeight: number;
  readonly pixelHeights: readonly number[];
  readonly visiblePixelsByBucket: readonly number[];
  readonly mismatchedChannels: number;
  readonly maxChannelDelta: number;
  readonly firstHash: string;
  readonly repeatedHash: string;
  readonly stableHash: boolean;
  readonly maxRecordsPerTileRow: number;
  readonly dispatchGroupCount: number;
  readonly dispatchInvocationCount: number;
  readonly effectivePixelCount: number;
  readonly dispatchToEffectiveRatio: number;
  readonly allocatedBytes: number;
  readonly denseEquivalentBytes: number;
}

interface SparseStripBrowserState {
  done: boolean;
  error?: string;
  result?: Readonly<SparseStripBrowserResult>;
}

interface HbGpuArtifact {
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
}

declare global {
  interface Window {
    __glyphflowSparseStrip: SparseStripBrowserState;
  }
}

window.__glyphflowSparseStrip = { done: false };

void run().catch((error: unknown) => {
  window.__glyphflowSparseStrip = {
    done: true,
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  };
});

async function run(): Promise<void> {
  const gpu = await requestComputeCullGpu();
  const device = gpu?.device;
  const rasterizer = createSparseStripComputeRasterizer(device);
  if (rasterizer.capability.status === "unsupported") {
    window.__glyphflowSparseStrip = {
      done: true,
      result: unsupportedResult(),
    };
    return;
  }
  if (device === undefined) throw new Error("supported sparse strip compute requires a GPU device");

  const artifact = (await fetch("/benchmarks/hb-gpu/results/hb-gpu-draw-native-14.4.0.json").then(
    (response) => response.json(),
  )) as HbGpuArtifact;
  const glyphRecord = artifact.corpora
    .find((corpus) => corpus.id === "arabic")
    ?.glyphs.find((glyph) => glyph.glyphId === 4);
  if (glyphRecord === undefined) throw new Error("Arabic glyph 4 is absent from the HB artifact");
  const prepared = requirePrepared(
    prepareOutlineGlyph({
      extents: glyphRecord.extents,
      packedCurveBlob: decodeHex(glyphRecord.blobHex),
    }),
  );
  const pixelHeights = [
    sparseGlyphStripPixelBucket(200),
    sparseGlyphStripPixelBucket(300),
  ] as const;
  const colors = [
    [0.18, 0.62, 1, 0.78],
    [1, 0.34, 0.58, 0.91],
  ] as const satisfies readonly OutlineColor[];
  const padding = 2;
  const cpuBitmaps: Readonly<OutlineCpuBitmap>[] = [];
  const requests: SparseStripComputeRequest[] = [];
  let atlasX = 0;
  let atlasHeight = 0;
  let allocatedBytes = 0;
  let denseEquivalentBytes = 0;
  pixelHeights.forEach((pixelHeight, index) => {
    const coverageBitmap = rasterizeOutlineCpu(prepared, {
      pixelHeight,
      padding,
      color: [1, 1, 1, 1],
    });
    const sparse = encodeSparseStripGlyph(coverageBitmap);
    const color = colors[index];
    if (color === undefined) throw new Error("sparse strip browser color is unavailable");
    cpuBitmaps.push(colorizeSparseStripGlyph(sparse, color));
    requests.push(
      Object.freeze({
        glyph: sparse,
        color,
        placement: Object.freeze({
          x: atlasX,
          y: 0,
          padding,
          contentWidth: sparse.width - padding * 2,
          contentHeight: sparse.height - padding * 2,
          scale: pixelHeight / prepared.quad.height,
          quad: prepared.quad,
        }),
      }),
    );
    atlasX += sparse.width;
    atlasHeight = Math.max(atlasHeight, sparse.height);
    allocatedBytes += sparse.allocatedBytes;
    denseEquivalentBytes += sparse.denseEquivalentBytes;
  });
  const batch: Readonly<SparseStripComputeBatch> = Object.freeze({
    width: atlasX,
    height: atlasHeight,
    requests: Object.freeze(requests),
  });
  const packed = packSparseStripComputeBatch(batch);
  const maxRecordsPerTileRow = maximumRowSpan(packed.rows, requests);

  const first = await rasterizer.rasterize(batch);
  if (first.status !== "ready")
    throw new Error(`first sparse strip raster returned ${first.status}`);
  const firstPixels = await readRgba8Texture(
    device,
    first.atlas.texture,
    first.atlas.width,
    first.atlas.height,
  );
  const firstHash = hashTightPixels(firstPixels, first.atlas.width, first.atlas.height);
  const comparison = compareEntries(firstPixels, first.atlas.entries, cpuBitmaps);
  first.atlas.destroy();

  const repeated = await rasterizer.rasterize(batch);
  if (repeated.status !== "ready") {
    throw new Error(`repeated sparse strip raster returned ${repeated.status}`);
  }
  const repeatedPixels = await readRgba8Texture(
    device,
    repeated.atlas.texture,
    repeated.atlas.width,
    repeated.atlas.height,
  );
  const repeatedHash = hashTightPixels(repeatedPixels, repeated.atlas.width, repeated.atlas.height);
  repeated.atlas.destroy();
  rasterizer.destroy();

  window.__glyphflowSparseStrip = {
    done: true,
    result: {
      capability: "supported",
      status: "ready",
      entryCount: first.atlas.entries.length,
      atlasWidth: batch.width,
      atlasHeight: batch.height,
      pixelHeights,
      visiblePixelsByBucket: comparison.visiblePixelsByBucket,
      mismatchedChannels: comparison.mismatchedChannels,
      maxChannelDelta: comparison.maxChannelDelta,
      firstHash,
      repeatedHash,
      stableHash: firstHash === repeatedHash,
      maxRecordsPerTileRow,
      dispatchGroupCount: packed.dispatches.length,
      dispatchInvocationCount: packed.stats.dispatchInvocationCount,
      effectivePixelCount: packed.stats.effectivePixelCount,
      dispatchToEffectiveRatio:
        packed.stats.dispatchInvocationCount / packed.stats.effectivePixelCount,
      allocatedBytes,
      denseEquivalentBytes,
    },
  };
}

function unsupportedResult(): Readonly<SparseStripBrowserResult> {
  return Object.freeze({
    capability: "unsupported",
    status: "unsupported",
    entryCount: 0,
    atlasWidth: 0,
    atlasHeight: 0,
    pixelHeights: Object.freeze([]),
    visiblePixelsByBucket: Object.freeze([]),
    mismatchedChannels: 0,
    maxChannelDelta: 0,
    firstHash: "",
    repeatedHash: "",
    stableHash: true,
    maxRecordsPerTileRow: 0,
    dispatchGroupCount: 0,
    dispatchInvocationCount: 0,
    effectivePixelCount: 0,
    dispatchToEffectiveRatio: 0,
    allocatedBytes: 0,
    denseEquivalentBytes: 0,
  });
}

function maximumRowSpan(
  rows: Uint32Array,
  requests: readonly Readonly<SparseStripComputeRequest>[],
): number {
  let maximum = 0;
  let rowOffset = 0;
  for (const request of requests) {
    for (let tileY = 0; tileY < request.glyph.tileRows; tileY += 1) {
      maximum = Math.max(
        maximum,
        (rows[rowOffset + tileY + 1] ?? 0) - (rows[rowOffset + tileY] ?? 0),
      );
    }
    rowOffset += request.glyph.tileRows + 1;
  }
  return maximum;
}

function compareEntries(
  gpu: Readonly<{ pixels: Uint8Array; bytesPerRow: number }>,
  entries: readonly Readonly<{ x: number; y: number; width: number; height: number }>[],
  cpuBitmaps: readonly Readonly<OutlineCpuBitmap>[],
): Readonly<{
  visiblePixelsByBucket: readonly number[];
  mismatchedChannels: number;
  maxChannelDelta: number;
}> {
  const visiblePixelsByBucket: number[] = [];
  let mismatchedChannels = 0;
  let maxChannelDelta = 0;
  entries.forEach((entry, index) => {
    const cpu = cpuBitmaps[index];
    if (cpu === undefined || cpu.width !== entry.width || cpu.height !== entry.height) {
      throw new Error("sparse strip CPU and GPU entry geometry differ");
    }
    let visiblePixels = 0;
    for (let y = 0; y < entry.height; y += 1) {
      for (let x = 0; x < entry.width; x += 1) {
        const cpuOffset = y * cpu.bytesPerRow + x * 4;
        const gpuOffset = (entry.y + y) * gpu.bytesPerRow + (entry.x + x) * 4;
        if ((cpu.pixels[cpuOffset + 3] ?? 0) > 0) visiblePixels += 1;
        for (let channel = 0; channel < 4; channel += 1) {
          const delta = Math.abs(
            (cpu.pixels[cpuOffset + channel] ?? 0) - (gpu.pixels[gpuOffset + channel] ?? 0),
          );
          maxChannelDelta = Math.max(maxChannelDelta, delta);
          if (delta > 2) mismatchedChannels += 1;
        }
      }
    }
    visiblePixelsByBucket.push(visiblePixels);
  });
  return Object.freeze({
    visiblePixelsByBucket: Object.freeze(visiblePixelsByBucket),
    mismatchedChannels,
    maxChannelDelta,
  });
}

function hashTightPixels(
  image: Readonly<{ pixels: Uint8Array; bytesPerRow: number }>,
  width: number,
  height: number,
): string {
  let hash = 0x811c_9dc5;
  for (let y = 0; y < height; y += 1) {
    for (let byte = 0; byte < width * 4; byte += 1) {
      hash = Math.imul(hash ^ (image.pixels[y * image.bytesPerRow + byte] ?? 0), 0x0100_0193) >>> 0;
    }
  }
  return `0x${hash.toString(16).padStart(8, "0")}`;
}

function requirePrepared(
  result: ReturnType<typeof prepareOutlineGlyph>,
): Readonly<PreparedOutlineGlyph> {
  if (result.status !== "ready") throw new Error(`unexpected ${result.status} outline`);
  return result.glyph;
}

function decodeHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new TypeError("hex must contain whole bytes");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
