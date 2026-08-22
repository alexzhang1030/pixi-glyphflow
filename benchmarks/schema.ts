export interface BenchmarkDistribution {
  readonly unit: "bytes" | "count" | "fps" | "ms" | "ratio";
  readonly samples: readonly number[];
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export const BENCHMARK_SCHEMA_VERSION = 4;

export type BrowserBenchmarkFixture = "bitmap-text" | "glyphflow" | "html-text" | "text";

export type BrowserBenchmarkWorkload =
  | "atlas-pressure"
  | "camera-live"
  | "dynamic-counters"
  | "first-seen"
  | "million-full"
  | "million-live"
  | "million-viewport"
  | "multilingual-stream"
  | "position-storm"
  | "scale-scan"
  | "static-hud"
  | "viewport-drag"
  | "viewport-zoom";

export interface BrowserBenchmarkConfiguration {
  readonly fixture: BrowserBenchmarkFixture;
  readonly workload: BrowserBenchmarkWorkload;
  readonly renderer: "webgl" | "webgpu";
  readonly labelCount: number;
  readonly mutationCount: number;
  readonly warmupFrames: number;
  readonly sampleFrames: number;
  readonly width: number;
  readonly height: number;
}

export interface BrowserBenchmarkTimings {
  readonly setupMs: number;
  readonly frameMs: readonly number[];
  readonly cpuMs?: readonly number[];
  readonly gpuMs?: readonly number[];
  readonly uploadBytes?: readonly number[];
  readonly mutationMs?: readonly number[];
  readonly commitMs?: readonly number[];
  readonly cullingMs?: readonly number[];
}

export interface BrowserBenchmarkCounters {
  readonly residentLabels: number;
  readonly submittedLabels: number;
  readonly minimumSubmittedLabels?: number;
  readonly maximumSubmittedLabels?: number;
  readonly visibleGlyphs: number;
  readonly drawCalls: number;
  readonly allocatedStoreBytes?: number;
  readonly instanceBytes?: number;
  readonly transformBytes?: number;
  readonly heapBytes?: number;
  readonly labelRevision?: number;
  readonly shapedLabels?: number;
  readonly transformOnlyLabels?: number;
  readonly atlasBytes?: number;
  readonly atlasEntries?: number;
  readonly atlasEvictions?: number;
  readonly cullingQueries?: number;
  readonly coalescedEvents?: number;
  readonly observedDrawCalls?: number;
  readonly maximumInstanceCount?: number;
  readonly nonTransparentPixels?: number;
  readonly lastLayoutMs?: number;
  readonly lastInstanceWriteMs?: number;
  readonly lastPaletteWriteMs?: number;
  readonly lastSpatialUpdateMs?: number;
  readonly lastUploadMs?: number;
}

export interface BrowserBenchmarkSample {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  readonly kind: "pixi-glyphflow-browser-sample";
  readonly capturedAt: string;
  readonly userAgent: string;
  readonly configuration: Readonly<BrowserBenchmarkConfiguration>;
  readonly timings: Readonly<BrowserBenchmarkTimings>;
  readonly counters: Readonly<BrowserBenchmarkCounters>;
  readonly invariants: Readonly<Record<string, boolean | number | string>>;
}

export interface BrowserBenchmarkPageState {
  readonly done: boolean;
  readonly result?: Readonly<BrowserBenchmarkSample>;
  readonly error?: string;
}

export interface BrowserBenchmarkFailure {
  readonly fixture: BrowserBenchmarkFixture;
  readonly status: "capacity-limit";
  readonly detail: string;
}

export interface BrowserBenchmarkArtifact {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  readonly benchmark: "browser-workloads";
  readonly packageVersion: string;
  readonly capturedAt: string;
  readonly runtime: Readonly<BenchmarkRuntime>;
  readonly workload: BrowserBenchmarkWorkload;
  readonly status: "capacity-limit" | "complete";
  /** Scale overrides mark the artifact exploratory; it never replaces the formal file. */
  readonly exploratory?: boolean;
  readonly samples: readonly Readonly<BrowserBenchmarkSample>[];
  readonly failures: readonly Readonly<BrowserBenchmarkFailure>[];
  readonly summaries: Readonly<
    Record<
      string,
      Readonly<{
        setup: Readonly<BenchmarkDistribution>;
        frame: Readonly<BenchmarkDistribution>;
      }>
    >
  >;
}

export interface BenchmarkRuntime {
  readonly bun: string;
  readonly cpu: string;
  readonly platform: string;
  readonly release: string;
  readonly architecture: string;
}

export function summarize(
  samples: readonly number[],
  unit: BenchmarkDistribution["unit"],
): BenchmarkDistribution {
  if (samples.length === 0) {
    throw new RangeError("At least one benchmark sample is required");
  }

  const sorted = [...samples].sort((left, right) => left - right);

  return Object.freeze({
    unit,
    samples: Object.freeze([...samples]),
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
  });
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);

  return sorted[index] ?? 0;
}
