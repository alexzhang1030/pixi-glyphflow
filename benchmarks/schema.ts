export interface BenchmarkDistribution {
  readonly unit: "bytes" | "count" | "fps" | "ms" | "ratio";
  readonly samples: readonly number[];
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export const BENCHMARK_SCHEMA_VERSION = 7;
export const HISTORICAL_BENCHMARK_SCHEMA_VERSION = 6;
export const GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET = 2_048;

export type BrowserBenchmarkRenderer = "webgl" | "webgpu";
export type BrowserBenchmarkArtifactRole = "baseline" | "candidate";

export interface BrowserGpuAdapterLimits {
  readonly maxStorageBufferBindingSize: number;
  readonly maxBufferSize: number;
  readonly maxStorageBuffersPerShaderStage: number;
  readonly maxStorageBuffersInVertexStage: number;
  readonly maxComputeWorkgroupStorageSize: number;
  readonly maxComputeInvocationsPerWorkgroup: number;
  readonly maxComputeWorkgroupSizeX: number;
  readonly maxComputeWorkgroupSizeY: number;
  readonly maxComputeWorkgroupSizeZ: number;
  readonly maxComputeWorkgroupsPerDimension: number;
}

export interface BrowserGpuAdapterIdentity {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly timestampQuery: boolean;
  readonly limits: Readonly<BrowserGpuAdapterLimits>;
}

const GPU_ADAPTER_LIMIT_KEYS: readonly (keyof BrowserGpuAdapterLimits)[] = [
  "maxStorageBufferBindingSize",
  "maxBufferSize",
  "maxStorageBuffersPerShaderStage",
  "maxStorageBuffersInVertexStage",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupSizeY",
  "maxComputeWorkgroupSizeZ",
  "maxComputeWorkgroupsPerDimension",
];

export function isCompleteBrowserGpuAdapterIdentity(
  value: unknown,
): value is Readonly<BrowserGpuAdapterIdentity> {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Readonly<Record<string, unknown>>;
  if (
    typeof identity.vendor !== "string" ||
    typeof identity.architecture !== "string" ||
    typeof identity.device !== "string" ||
    typeof identity.description !== "string" ||
    typeof identity.timestampQuery !== "boolean" ||
    typeof identity.limits !== "object" ||
    identity.limits === null
  ) {
    return false;
  }
  const limits = identity.limits as Readonly<Record<string, unknown>>;
  const typedLimits = identity.limits as Readonly<BrowserGpuAdapterLimits>;
  const identityPresent = [
    identity.vendor,
    identity.architecture,
    identity.device,
    identity.description,
  ].some((field) => field.trim().length > 0);
  const limitsComplete = GPU_ADAPTER_LIMIT_KEYS.every((key) => {
    const value = limits[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  });
  return (
    identityPresent &&
    limitsComplete &&
    typedLimits.maxStorageBufferBindingSize > 0 &&
    typedLimits.maxBufferSize > 0 &&
    typedLimits.maxStorageBuffersPerShaderStage > 0 &&
    typedLimits.maxComputeWorkgroupStorageSize > 0 &&
    typedLimits.maxComputeInvocationsPerWorkgroup > 0 &&
    typedLimits.maxComputeWorkgroupSizeX > 0 &&
    typedLimits.maxComputeWorkgroupSizeY > 0 &&
    typedLimits.maxComputeWorkgroupSizeZ > 0 &&
    typedLimits.maxComputeWorkgroupsPerDimension > 0
  );
}

export function browserGpuAdapterIdentityEqual(left: unknown, right: unknown): boolean {
  if (!isCompleteBrowserGpuAdapterIdentity(left) || !isCompleteBrowserGpuAdapterIdentity(right)) {
    return false;
  }
  return (
    left.vendor === right.vendor &&
    left.architecture === right.architecture &&
    left.device === right.device &&
    left.description === right.description &&
    left.timestampQuery === right.timestampQuery &&
    GPU_ADAPTER_LIMIT_KEYS.every((key) => left.limits[key] === right.limits[key])
  );
}

export interface BrowserBenchmarkBuildManifestEntry {
  /** Reproducible build output path relative to the build root. */
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

export type BrowserBenchmarkHarnessManifestEntry = BrowserBenchmarkBuildManifestEntry;

export interface BrowserBenchmarkProvenance {
  /** UUID v4 generated once per benchmark runner invocation. */
  readonly runId: string;
  /** SHA-256 of the sorted browser build manifest. */
  readonly buildFingerprintSha256: string;
  /** Content-addressed browser bundle, worker, Wasm, and asset outputs. */
  readonly buildManifest: readonly Readonly<BrowserBenchmarkBuildManifestEntry>[];
  /** SHA-256 of the sorted Node runner and promotion-control manifest. */
  readonly harnessFingerprintSha256: string;
  /** Content-addressed runner, budget, sampling, package, and lockfile inputs. */
  readonly harnessManifest: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[];
  /** SHA-256 of canonical artifact JSON bytes with this field omitted. */
  readonly evidenceSha256: string;
}

export type BrowserBenchmarkFixture = "bitmap-text" | "glyphflow" | "html-text" | "text";

export type BrowserBenchmarkWorkload =
  | "atlas-pressure"
  | "camera-live"
  | "dynamic-counters"
  | "first-seen"
  | "gpu-scene-heterogeneous-64"
  | "gpu-scene-resident"
  | "gpu-scene-v2"
  | "label-collision"
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
  readonly renderer: BrowserBenchmarkRenderer;
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
  readonly gpuTimestampMs?: readonly (number | null)[];
  readonly paletteGpuTimestampMs?: readonly (number | null)[];
  readonly cullGpuTimestampMs?: readonly (number | null)[];
  readonly sceneRenderGpuTimestampMs?: readonly (number | null)[];
  readonly completionWallMs?: readonly number[];
  /** Timer-owned slot retirement outside the formal product-frame metric. */
  readonly instrumentationWallMs?: readonly number[];
  /** Timestamp map/read/unmap wall, associated with the originating frame token. */
  readonly timestampReadbackWallMs?: readonly number[];
  readonly uploadBytes?: readonly number[];
  readonly transformUploadBytes?: readonly number[];
  readonly cullRecordUploadBytes?: readonly number[];
  /** Product transaction submissions accepted per sampled frame. */
  readonly frameTransactionSubmissionDeltas?: readonly number[];
  readonly frameTransactionFusedSubmissionDeltas?: readonly number[];
  readonly frameTransactionStandaloneSubmissionDeltas?: readonly number[];
  readonly mutationMs?: readonly number[];
  readonly commitMs?: readonly number[];
  readonly cullingMs?: readonly number[];
  readonly visibilitySelectionMs?: readonly number[];
  readonly renderPreparationMs?: readonly number[];
  readonly renderCoordinatorMs?: readonly number[];
  readonly surfaceApplyMs?: readonly number[];
  readonly offscreenInspectedLabels?: readonly number[];
  readonly offscreenMaterializedLabels?: readonly number[];
  readonly offscreenAdmissionDeferred?: readonly boolean[];
  readonly offscreenAdmissionGeneration?: readonly number[];
  readonly offscreenAdmissionCursor?: readonly number[];
  readonly offscreenAdmissionCursorResets?: readonly number[];
  readonly offscreenAdmissionCycles?: readonly number[];
  readonly deferredSpatialLabels?: readonly number[];
  readonly uploadMs?: readonly number[];
  readonly phases?: Readonly<{
    camera: Readonly<BrowserBenchmarkPhaseTimings>;
    positionMutation: Readonly<BrowserBenchmarkPhaseTimings>;
  }>;
  readonly gpuTiming?: Readonly<BrowserGpuTimingCapability>;
}

export interface BrowserBenchmarkPhaseTimings {
  readonly frameMs: readonly number[];
  /** Exact additive definition used to form every frameMs sample. */
  readonly frameMetric?: "mutation+timer-cpu+queue-completion";
  /** Budget used for the explicit long-tail fields below. */
  readonly frameBudgetMs?: number;
  readonly frameOverBudgetCount?: number;
  readonly frameOverBudgetRatio?: number;
  readonly frameP99Ms?: number;
  readonly frameMaxMs?: number;
  readonly cpuMs: readonly number[];
  readonly gpuMs: readonly number[];
  readonly gpuTimestampMs: readonly (number | null)[];
  readonly paletteGpuTimestampMs?: readonly (number | null)[];
  readonly cullGpuTimestampMs?: readonly (number | null)[];
  readonly sceneRenderGpuTimestampMs?: readonly (number | null)[];
  readonly completionWallMs: readonly number[];
  /** Timer-owned slot retirement outside frameMs. */
  readonly instrumentationWallMs?: readonly number[];
  /** Timestamp map/read/unmap wall, ordered by originating frame token. */
  readonly timestampReadbackWallMs?: readonly number[];
  readonly uploadBytes: readonly number[];
  readonly transformUploadBytes?: readonly number[];
  readonly cullRecordUploadBytes?: readonly number[];
  /** Product transaction submissions accepted per sampled frame. */
  readonly frameTransactionSubmissionDeltas?: readonly number[];
  readonly frameTransactionFusedSubmissionDeltas?: readonly number[];
  readonly frameTransactionStandaloneSubmissionDeltas?: readonly number[];
  readonly uploadMs: readonly number[];
  readonly commitMs: readonly number[];
  readonly cullingMs: readonly number[];
  readonly mutationMs: readonly number[];
  readonly visibilitySelectionMs: readonly number[];
  readonly renderPreparationMs: readonly number[];
  readonly renderCoordinatorMs: readonly number[];
  readonly surfaceApplyMs: readonly number[];
  readonly offscreenInspectedLabels: readonly number[];
  readonly offscreenMaterializedLabels: readonly number[];
  readonly offscreenAdmissionDeferred: readonly boolean[];
  readonly offscreenAdmissionGeneration: readonly number[];
  readonly offscreenAdmissionCursor: readonly number[];
  readonly offscreenAdmissionCursorResets: readonly number[];
  readonly offscreenAdmissionCycles: readonly number[];
  readonly deferredSpatialLabels?: readonly number[];
  readonly shapedLabelsDelta: number;
  readonly admittedLabelsTotal: number;
  readonly cullingQueriesDelta?: number;
}

export interface BrowserGpuTimingCapability {
  readonly renderer: BrowserBenchmarkRenderer;
  readonly method: "completion-wall" | "ext-disjoint-timer-query-webgl2" | "timestamp-query";
  readonly gpuTimeSource: "completion-wall" | "gpu-timestamp" | "mixed";
  readonly quality: "fallback" | "mixed" | "unavailable" | "valid";
  readonly supported: boolean;
  readonly timerQuery: boolean;
  readonly timestampWrites: boolean;
  readonly resolveQuerySet: boolean;
  readonly readback: boolean;
  readonly disjoint: boolean;
  readonly samples: number;
  readonly validSamples: number;
  readonly fallbackSamples: number;
  /** Timestamp resolve/copy operations encoded into an existing product command buffer. */
  readonly fusedTimestampResolves: number;
  /** Benchmark-owned timestamp command-buffer submissions outside the product frame. */
  readonly standaloneTimestampSubmissions: number;
  /** Readback scheduling used after the timestamp copy has joined the product command buffer. */
  readonly timestampReadbackMode?: "deferred-ring" | "immediate";
  /** Number of reusable query/resolve/readback slots. */
  readonly timestampReadbackRingSize?: number;
  /** Timestamp copies waiting for map/unmap completion. */
  readonly pendingTimestampReadbacks?: number;
  /** High-water mark for timestamp copies waiting in the readback ring. */
  readonly maxPendingTimestampReadbacks?: number;
  /** Command-encoder writes captured every product, palette, and cull boundary. */
  readonly segmentedTimestampWrites?: boolean;
  /** Query count resolved and copied once per sampled WebGPU product frame. */
  readonly timestampQueriesPerFrame?: number;
  readonly segmentedSamples?: number;
  readonly validSegmentedSamples?: number;
  readonly segmentedFallbackSamples?: number;
  readonly validPaletteSamples?: number;
  readonly validCullSamples?: number;
  readonly validSceneRenderSamples?: number;
  readonly segmentedReason?: string;
  readonly reason?: string;
}

export interface BrowserBenchmarkCounters {
  readonly residentLabels: number;
  readonly submittedLabels: number;
  readonly minimumSubmittedLabels?: number;
  readonly maximumSubmittedLabels?: number;
  readonly visibleGlyphs: number;
  readonly drawCalls: number;
  readonly drawCallsSource?: "logical-mesh-count" | "renderer-observer";
  readonly allocatedStoreBytes?: number;
  /** Logical draw-reference storage submitted at eight bytes per visible glyph. */
  readonly drawReferenceBytes?: number;
  /** Unique prototype-record storage at 24 bytes per glyph record. */
  readonly prototypeRecordBytes?: number;
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
  readonly observedDrawCallsSource?: "webgl-instanced-draw-observer" | "unavailable-webgpu";
  readonly maximumInstanceCount?: number;
  readonly nonTransparentPixels?: number;
  readonly lastLayoutMs?: number;
  readonly lastInstanceWriteMs?: number;
  readonly lastPaletteWriteMs?: number;
  readonly lastSpatialUpdateMs?: number;
  readonly lastUploadMs?: number;
  readonly submittedGlyphs?: number;
  readonly activeGlyphInstances?: number;
  readonly submittedGlyphsSource?: "cpu-submit" | "gpu-indirect-readback";
  readonly submittedGlyphsHashSource?: "cpu-expected" | "gpu-instances-out-readback";
  readonly cameraSubmittedGlyphs?: number;
  readonly cameraSubmittedGlyphsHash?: number;
  readonly expectedCameraSubmittedGlyphs?: number;
  readonly expectedCameraSubmittedGlyphsHash?: number;
  readonly expectedSubmittedGlyphs?: number;
  readonly expectedSubmittedGlyphsHash?: number;
  readonly expectedSubmittedGlyphsSource?: "cpu-prototype-bounds";
  readonly rendererAdapter?: "detached" | "unknown" | "webgl" | "webgpu";
  readonly cullPath?: string;
  readonly palettePath?: string;
  readonly residencyRequested?: string;
  readonly residencyActive?: string;
  readonly residencyFallbackReason?: string;
  readonly gpuResidentLabels?: number;
  readonly prototypeCount?: number;
  readonly paintCount?: number;
  readonly prototypePaintPairCount?: number;
  readonly gpuScenePerLabelObjectCount?: number;
  readonly collisionEnabled?: boolean;
  readonly deferredSpatialLabels?: number;
  readonly cullRecordUploadBytes?: number;
  readonly lastSceneSetupMs?: number;
  readonly frameTransactionSubmissions?: number;
  readonly frameTransactionFusedSubmissions?: number;
  readonly frameTransactionStandaloneSubmissions?: number;
  /** Renderer-lifetime totals retained beside workload-scoped transaction deltas. */
  readonly frameTransactionCumulativeSubmissions?: number;
  readonly frameTransactionCumulativeFusedSubmissions?: number;
  readonly frameTransactionCumulativeStandaloneSubmissions?: number;
  /** Explicit compacted-output copy/map submits outside product frames. */
  readonly diagnosticReadbackSubmissions?: number;
  /** Timestamp query readbacks completed by the benchmark timer. */
  readonly timestampReadbackSubmissions?: number;
  /** Timestamp resolve/copy operations encoded into product command buffers. */
  readonly timestampFusedResolves?: number;
  /** Benchmark-owned timestamp command-buffer submissions outside product frames. */
  readonly timestampStandaloneSubmissions?: number;
  readonly timestampReadbackRingSize?: number;
  readonly timestampMaxPendingReadbacks?: number;
  readonly timestampPendingReadbacks?: number;
  readonly timestampQueriesPerFrame?: number;
  readonly timestampSegmentedSamples?: number;
  readonly timestampValidSegmentedSamples?: number;
  readonly timestampSegmentedFallbackSamples?: number;
  readonly timestampValidPaletteSamples?: number;
  readonly timestampValidCullSamples?: number;
  readonly timestampValidSceneRenderSamples?: number;
  readonly submittedGlyphsHash?: number;
  readonly renderedPixelHash?: number;
  readonly renderedPixelHashRepeat?: number;
  readonly nonTransparentPixelsRepeat?: number;
  readonly collisionCandidateLabels?: number;
  readonly collisionCulledLabels?: number;
  readonly densityCulledLabels?: number;
  readonly submittedReduction?: number;
  readonly submittedReductionRatio?: number;
  readonly collisionCandidateReductionRatio?: number;
  readonly collisionSelectionHash?: number;
  readonly lastCollisionMs?: number;
  readonly collisionRecordBytes?: number;
  readonly offscreenInspectedLabels?: number;
  readonly offscreenMaterializedLabels?: number;
  readonly offscreenAdmittedLabels?: number;
  readonly offscreenMaxInspectedLabels?: number;
  readonly offscreenMaxMaterializedLabels?: number;
  readonly offscreenAdmissionDeferred?: boolean;
  readonly offscreenAdmissionGeneration?: number;
  readonly offscreenAdmissionCursor?: number;
  readonly offscreenAdmissionCursorResets?: number;
  readonly offscreenAdmissionCycles?: number;
}

export interface BrowserBenchmarkSample {
  readonly schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  readonly kind: "pixi-glyphflow-browser-sample";
  /** One-based formal repetition ordinal within an artifact. */
  readonly repeatIndex?: number;
  readonly capturedAt: string;
  readonly userAgent: string;
  /** Adapter identity and device limits captured by WebGPU samples. */
  readonly gpuAdapter?: Readonly<BrowserGpuAdapterIdentity>;
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
  readonly repeatIndex?: number;
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
  readonly renderer: BrowserBenchmarkRenderer;
  /** Adapter identity promoted from the WebGPU sample by the Node runner. */
  readonly gpuAdapter?: Readonly<BrowserGpuAdapterIdentity>;
  readonly artifactRole: BrowserBenchmarkArtifactRole;
  readonly provenance: Readonly<BrowserBenchmarkProvenance>;
  readonly status: "capacity-limit" | "complete";
  /** Scale overrides mark the artifact exploratory; it never replaces the formal file. */
  readonly exploratory?: boolean;
  readonly samples: readonly Readonly<BrowserBenchmarkSample>[];
  readonly failures: readonly Readonly<BrowserBenchmarkFailure>[];
  readonly budget?: Readonly<BrowserBenchmarkBudgetDecision>;
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

export type BrowserBenchmarkArtifactPayload = Omit<BrowserBenchmarkArtifact, "provenance">;

export type HistoricalBrowserBenchmarkSampleV6 = Omit<BrowserBenchmarkSample, "schemaVersion"> & {
  readonly schemaVersion: typeof HISTORICAL_BENCHMARK_SCHEMA_VERSION;
};

export type HistoricalBrowserBenchmarkArtifactV6 = Omit<
  BrowserBenchmarkArtifact,
  "provenance" | "samples" | "schemaVersion"
> & {
  readonly schemaVersion: typeof HISTORICAL_BENCHMARK_SCHEMA_VERSION;
  readonly provenance?: never;
  readonly samples: readonly Readonly<HistoricalBrowserBenchmarkSampleV6>[];
};

export type ReadableBrowserBenchmarkArtifact =
  | BrowserBenchmarkArtifact
  | HistoricalBrowserBenchmarkArtifactV6;

export interface BrowserBenchmarkBudgetCheck {
  readonly name: string;
  readonly actual: number | string;
  readonly limit: number | string;
  readonly passed: boolean;
}

export interface BrowserBenchmarkBudgetDecision {
  readonly passed: boolean;
  readonly checks: readonly Readonly<BrowserBenchmarkBudgetCheck>[];
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
