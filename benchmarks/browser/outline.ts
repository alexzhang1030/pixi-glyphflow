import type {
  OutlineComputeRasterizer,
  OutlineComputeRasterRequest,
} from "../../src/render/outline";

export interface OutlineComputeBenchmarkOptions {
  readonly warmupIterations: number;
  readonly sampleIterations: number;
}

export interface OutlineComputeBenchmarkResult {
  readonly timings: Readonly<{
    coldMs: number;
    samplesMs: readonly number[];
    p50Ms: number;
    p95Ms: number;
  }>;
  readonly counters: Readonly<{
    entryCount: number;
    atlasPixels: number;
  }>;
}

interface RasterSample {
  readonly elapsedMs: number;
  readonly entryCount: number;
  readonly atlasPixels: number;
}

export async function measureOutlineComputeRasterizer(
  rasterizer: OutlineComputeRasterizer,
  requests: readonly Readonly<OutlineComputeRasterRequest>[],
  options: Readonly<OutlineComputeBenchmarkOptions>,
): Promise<Readonly<OutlineComputeBenchmarkResult>> {
  assertIterationCount(options.warmupIterations, "warmupIterations", true);
  assertIterationCount(options.sampleIterations, "sampleIterations", false);
  const cold = await sampleRaster(rasterizer, requests);
  for (let iteration = 0; iteration < options.warmupIterations; iteration += 1) {
    await sampleRaster(rasterizer, requests);
  }
  const samples: number[] = [];
  let counters = cold;
  for (let iteration = 0; iteration < options.sampleIterations; iteration += 1) {
    counters = await sampleRaster(rasterizer, requests);
    samples.push(counters.elapsedMs);
  }
  const sorted = [...samples].sort((first, second) => first - second);
  return Object.freeze({
    timings: Object.freeze({
      coldMs: cold.elapsedMs,
      samplesMs: Object.freeze(samples),
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
    }),
    counters: Object.freeze({
      entryCount: counters.entryCount,
      atlasPixels: counters.atlasPixels,
    }),
  });
}

async function sampleRaster(
  rasterizer: OutlineComputeRasterizer,
  requests: readonly Readonly<OutlineComputeRasterRequest>[],
): Promise<Readonly<RasterSample>> {
  const start = performance.now();
  const result = await rasterizer.rasterize(requests);
  const elapsedMs = performance.now() - start;
  if (result.status !== "ready") {
    throw new Error(`outline benchmark requires a ready result; received ${result.status}`);
  }
  const entryCount = result.atlas.entries.length;
  const atlasPixels = result.atlas.width * result.atlas.height;
  result.atlas.destroy();
  return Object.freeze({ elapsedMs, entryCount, atlasPixels });
}

function percentile(sorted: readonly number[], ratio: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
  const value = sorted[index];
  if (value === undefined) throw new TypeError("outline benchmark samples are unavailable");
  return value;
}

function assertIterationCount(value: number, name: string, allowZero: boolean): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer at least ${String(minimum)}`);
  }
}
