import { GPU_SCENE_RESIDENT_CANONICAL_TRUTH } from "./gpu-scene-resident-truth";
import {
  BENCHMARK_SCHEMA_VERSION,
  summarize,
  type BrowserBenchmarkBudgetCheck,
  type BrowserBenchmarkBudgetDecision,
  type BrowserBenchmarkPhaseTimings,
  type BrowserBenchmarkSample,
} from "./schema";
import { getBenchmarkWorkload } from "./workloads";

export const GPU_SCENE_RESIDENT_CAMERA_CPU_BUDGET_MS = 2;
export const GPU_SCENE_RESIDENT_CAMERA_COMMIT_BUDGET_MS = 1;
export const GPU_SCENE_RESIDENT_POSITION_MUTATION_BUDGET_MS = 8;
export const GPU_SCENE_RESIDENT_POSITION_COMMIT_BUDGET_MS = 4;
export const GPU_SCENE_RESIDENT_SURFACE_BUDGET_MS = 2;
export const GPU_SCENE_RESIDENT_FRAME_BUDGET_MS = 16.67;
export const GPU_SCENE_RESIDENT_SETUP_BUDGET_MS = 2_000;
export const GPU_SCENE_RESIDENT_HEAP_BUDGET_BYTES: number = 512 * 1_024 ** 2;
export const GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES = 800_016;
export const GPU_SCENE_RESIDENT_POSITION_UPLOAD_MIN_BYTES: number =
  GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES;
export const GPU_SCENE_RESIDENT_INITIAL_CULL_UPLOAD_BYTES = 32_000_000;
export const GPU_SCENE_RESIDENT_SUBMITTED_GLYPHS: number =
  GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal.output.submittedGlyphs;
export const GPU_SCENE_RESIDENT_SUBMITTED_HASH: number =
  GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal.output.submittedGlyphsHash;

interface GpuSceneResidentBudgetPolicy {
  readonly sampleFrames: number;
  readonly maximumOverBudgetFrames: number;
  readonly maximumOverBudgetRatio: number;
  readonly frameMaxIsGate: boolean;
}

type RecordBudgetCheck = (
  name: string,
  actual: number | string,
  limit: number | string,
  passed: boolean,
) => void;

const FORMAL_POLICY: Readonly<GpuSceneResidentBudgetPolicy> = Object.freeze({
  sampleFrames: 120,
  maximumOverBudgetFrames: 0,
  maximumOverBudgetRatio: 0,
  frameMaxIsGate: true,
});

const SUSTAINED_600_POLICY: Readonly<GpuSceneResidentBudgetPolicy> = Object.freeze({
  sampleFrames: 600,
  maximumOverBudgetFrames: 6,
  maximumOverBudgetRatio: 0.01,
  frameMaxIsGate: false,
});

export function evaluateGpuSceneResidentBudget(
  samples: readonly Readonly<BrowserBenchmarkSample>[],
): Readonly<BrowserBenchmarkBudgetDecision> {
  return evaluateGpuSceneResidentBudgetWithPolicy(samples, FORMAL_POLICY);
}

export function evaluateGpuSceneResidentSustained600Budget(
  samples: readonly Readonly<BrowserBenchmarkSample>[],
): Readonly<BrowserBenchmarkBudgetDecision> {
  return evaluateGpuSceneResidentBudgetWithPolicy(samples, SUSTAINED_600_POLICY);
}

function evaluateGpuSceneResidentBudgetWithPolicy(
  samples: readonly Readonly<BrowserBenchmarkSample>[],
  policy: Readonly<GpuSceneResidentBudgetPolicy>,
): Readonly<BrowserBenchmarkBudgetDecision> {
  const expected = getBenchmarkWorkload("gpu-scene-resident");
  const checks: BrowserBenchmarkBudgetCheck[] = [];
  const record: RecordBudgetCheck = (name, actual, limit, passed): void => {
    checks.push(Object.freeze({ name, actual, limit, passed }));
  };

  record("samples", samples.length, 1, samples.length === 1);
  for (const sample of samples) {
    const configuration = sample.configuration;
    const expectedTimingSamples = 2 * (expected.warmupFrames + policy.sampleFrames);
    recordNumericDomain("setup-ms-domain", sample.timings.setupMs, false, record);
    recordNumericDomain("scene-setup-ms-domain", sample.counters.lastSceneSetupMs, false, record);
    for (const [name, value] of [
      ["resident-labels-domain", sample.counters.residentLabels],
      ["gpu-resident-labels-domain", sample.counters.gpuResidentLabels],
      ["prototype-count-domain", sample.counters.prototypeCount],
      ["deferred-spatial-labels-domain", sample.counters.deferredSpatialLabels],
      ["initial-cull-record-upload-bytes-domain", sample.counters.cullRecordUploadBytes],
      ["heap-bytes-domain", sample.counters.heapBytes],
      ["submitted-count-domain", sample.counters.submittedGlyphs],
      ["submitted-labels-domain", sample.counters.submittedLabels],
      ["submitted-hash-domain", sample.counters.submittedGlyphsHash],
      ["rendered-pixel-hash-domain", sample.counters.renderedPixelHash],
      ["rendered-pixel-hash-repeat-domain", sample.counters.renderedPixelHashRepeat],
      ["non-transparent-pixels-domain", sample.counters.nonTransparentPixels],
      ["non-transparent-pixels-repeat-domain", sample.counters.nonTransparentPixelsRepeat],
      ["logical-render-meshes-domain", sample.counters.drawCalls],
      ["observed-instanced-draws-domain", sample.counters.observedDrawCalls],
      ["product-frame-submissions-domain", sample.counters.frameTransactionSubmissions],
      ["product-frame-fused-submissions-domain", sample.counters.frameTransactionFusedSubmissions],
      [
        "product-frame-standalone-submissions-domain",
        sample.counters.frameTransactionStandaloneSubmissions,
      ],
      ["diagnostic-readback-submissions-domain", sample.counters.diagnosticReadbackSubmissions],
      ["timestamp-readbacks-domain", sample.counters.timestampReadbackSubmissions],
      ["timestamp-fused-resolves-domain", sample.counters.timestampFusedResolves],
      ["timestamp-standalone-submissions-domain", sample.counters.timestampStandaloneSubmissions],
      ["timestamp-readback-ring-size-domain", sample.counters.timestampReadbackRingSize],
      ["timestamp-max-pending-readbacks-domain", sample.counters.timestampMaxPendingReadbacks],
      ["timestamp-pending-readbacks-domain", sample.counters.timestampPendingReadbacks],
      ["timestamp-queries-per-frame-domain", sample.counters.timestampQueriesPerFrame],
      ["timestamp-segmented-samples-domain", sample.counters.timestampSegmentedSamples],
      ["timestamp-valid-segmented-samples-domain", sample.counters.timestampValidSegmentedSamples],
      [
        "timestamp-segmented-fallback-samples-domain",
        sample.counters.timestampSegmentedFallbackSamples,
      ],
      ["timestamp-valid-palette-samples-domain", sample.counters.timestampValidPaletteSamples],
      ["timestamp-valid-cull-samples-domain", sample.counters.timestampValidCullSamples],
      [
        "timestamp-valid-scene-render-samples-domain",
        sample.counters.timestampValidSceneRenderSamples,
      ],
      ["gpu-timing-samples-domain", sample.timings.gpuTiming?.samples],
      ["gpu-timing-valid-samples-domain", sample.timings.gpuTiming?.validSamples],
      ["gpu-timing-fallback-samples-domain", sample.timings.gpuTiming?.fallbackSamples],
      ["gpu-timing-fused-resolves-domain", sample.timings.gpuTiming?.fusedTimestampResolves],
      [
        "gpu-timing-standalone-submissions-domain",
        sample.timings.gpuTiming?.standaloneTimestampSubmissions,
      ],
      ["gpu-timing-queries-per-frame-domain", sample.timings.gpuTiming?.timestampQueriesPerFrame],
      ["gpu-timing-segmented-samples-domain", sample.timings.gpuTiming?.segmentedSamples],
      [
        "gpu-timing-valid-segmented-samples-domain",
        sample.timings.gpuTiming?.validSegmentedSamples,
      ],
      [
        "gpu-timing-segmented-fallback-samples-domain",
        sample.timings.gpuTiming?.segmentedFallbackSamples,
      ],
      ["gpu-timing-valid-palette-samples-domain", sample.timings.gpuTiming?.validPaletteSamples],
      ["gpu-timing-valid-cull-samples-domain", sample.timings.gpuTiming?.validCullSamples],
      [
        "gpu-timing-valid-scene-render-samples-domain",
        sample.timings.gpuTiming?.validSceneRenderSamples,
      ],
    ] as const) {
      recordNumericDomain(name, value, true, record);
    }
    record(
      "schema-version",
      sample.schemaVersion,
      BENCHMARK_SCHEMA_VERSION,
      sample.schemaVersion === BENCHMARK_SCHEMA_VERSION,
    );
    record("workload", configuration.workload, expected.id, configuration.workload === expected.id);
    record("renderer", configuration.renderer, "webgpu", configuration.renderer === "webgpu");
    record(
      "resident-labels",
      sample.counters.residentLabels,
      expected.labelCount,
      sample.counters.residentLabels === expected.labelCount,
    );
    record(
      "gpu-resident-labels",
      sample.counters.gpuResidentLabels ?? -1,
      expected.labelCount,
      sample.counters.gpuResidentLabels === expected.labelCount,
    );
    record(
      "prototype-count",
      sample.counters.prototypeCount ?? -1,
      1,
      sample.counters.prototypeCount === 1,
    );
    record(
      "deferred-spatial-labels",
      sample.counters.deferredSpatialLabels ?? -1,
      expected.mutationCount,
      sample.counters.deferredSpatialLabels === expected.mutationCount,
    );
    record(
      "initial-cull-record-upload-bytes",
      sample.counters.cullRecordUploadBytes ?? -1,
      GPU_SCENE_RESIDENT_INITIAL_CULL_UPLOAD_BYTES,
      sample.counters.cullRecordUploadBytes === GPU_SCENE_RESIDENT_INITIAL_CULL_UPLOAD_BYTES,
    );
    record(
      "position-mutations",
      configuration.mutationCount,
      expected.mutationCount,
      configuration.mutationCount === expected.mutationCount,
    );
    record(
      "warmup-frames",
      configuration.warmupFrames,
      expected.warmupFrames,
      configuration.warmupFrames === expected.warmupFrames,
    );
    record(
      "sample-frames",
      configuration.sampleFrames,
      policy.sampleFrames,
      configuration.sampleFrames === policy.sampleFrames,
    );
    record(
      "setup-ms",
      sample.timings.setupMs,
      GPU_SCENE_RESIDENT_SETUP_BUDGET_MS,
      sample.timings.setupMs <= GPU_SCENE_RESIDENT_SETUP_BUDGET_MS,
    );
    record(
      "scene-setup-ms",
      sample.counters.lastSceneSetupMs ?? Number.POSITIVE_INFINITY,
      GPU_SCENE_RESIDENT_SETUP_BUDGET_MS,
      (sample.counters.lastSceneSetupMs ?? 0) > 0 &&
        (sample.counters.lastSceneSetupMs ?? Number.POSITIVE_INFINITY) <=
          GPU_SCENE_RESIDENT_SETUP_BUDGET_MS,
    );
    record(
      "heap-bytes",
      sample.counters.heapBytes ?? Number.POSITIVE_INFINITY,
      GPU_SCENE_RESIDENT_HEAP_BUDGET_BYTES,
      (sample.counters.heapBytes ?? Number.POSITIVE_INFINITY) <=
        GPU_SCENE_RESIDENT_HEAP_BUDGET_BYTES,
    );
    record(
      "residency-requested",
      sample.counters.residencyRequested ?? "missing",
      "gpu-scene",
      sample.counters.residencyRequested === "gpu-scene",
    );
    record(
      "residency-active",
      sample.counters.residencyActive ?? "missing",
      "gpu-scene",
      sample.counters.residencyActive === "gpu-scene",
    );
    record(
      "residency-fallback",
      sample.counters.residencyFallbackReason ?? "none",
      "none",
      sample.counters.residencyFallbackReason === undefined,
    );
    record(
      "submitted-glyphs-source",
      sample.counters.submittedGlyphsSource ?? "missing",
      "gpu-indirect-readback",
      sample.counters.submittedGlyphsSource === "gpu-indirect-readback",
    );
    record(
      "submitted-hash-source",
      sample.counters.submittedGlyphsHashSource ?? "missing",
      "gpu-instances-out-readback",
      sample.counters.submittedGlyphsHashSource === "gpu-instances-out-readback",
    );
    record(
      "submitted-count",
      sample.counters.submittedGlyphs ?? 0,
      GPU_SCENE_RESIDENT_SUBMITTED_GLYPHS,
      sample.counters.submittedGlyphs === GPU_SCENE_RESIDENT_SUBMITTED_GLYPHS,
    );
    record(
      "submitted-labels",
      sample.counters.submittedLabels,
      sample.counters.submittedGlyphs ?? 0,
      sample.counters.submittedLabels === sample.counters.submittedGlyphs,
    );
    record(
      "submitted-hash",
      sample.counters.submittedGlyphsHash ?? 0,
      GPU_SCENE_RESIDENT_SUBMITTED_HASH,
      sample.counters.submittedGlyphsHash === GPU_SCENE_RESIDENT_SUBMITTED_HASH,
    );
    record(
      "rendered-pixel-hash",
      sample.counters.renderedPixelHash ?? 0,
      GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal.output.renderedPixelHash,
      sample.counters.renderedPixelHash ===
        GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal.output.renderedPixelHash,
    );
    record(
      "non-transparent-pixels",
      sample.counters.nonTransparentPixels ?? 0,
      GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal.output.nonTransparentPixels,
      sample.counters.nonTransparentPixels ===
        GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal.output.nonTransparentPixels,
    );
    record(
      "rendered-pixel-hash-repeat",
      sample.counters.renderedPixelHashRepeat ?? 0,
      sample.counters.renderedPixelHash ?? 0,
      sample.counters.renderedPixelHashRepeat ===
        GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal.output.renderedPixelHash &&
        sample.counters.renderedPixelHashRepeat === sample.counters.renderedPixelHash,
    );
    record(
      "non-transparent-pixels-repeat",
      sample.counters.nonTransparentPixelsRepeat ?? 0,
      sample.counters.nonTransparentPixels ?? 0,
      sample.counters.nonTransparentPixelsRepeat ===
        GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal.output.nonTransparentPixels &&
        sample.counters.nonTransparentPixelsRepeat === sample.counters.nonTransparentPixels,
    );
    record(
      "renderer-adapter",
      sample.counters.rendererAdapter ?? "missing",
      "webgpu",
      sample.counters.rendererAdapter === "webgpu",
    );
    record(
      "palette-path",
      sample.counters.palettePath ?? "missing",
      "storage",
      sample.counters.palettePath === "storage",
    );
    record(
      "cull-path",
      sample.counters.cullPath ?? "missing",
      "compute-cull",
      sample.counters.cullPath === "compute-cull",
    );
    record(
      "logical-render-meshes-source",
      sample.counters.drawCallsSource ?? "missing",
      "logical-mesh-count",
      sample.counters.drawCallsSource === "logical-mesh-count",
    );
    record("logical-render-meshes", sample.counters.drawCalls, 1, sample.counters.drawCalls === 1);
    record(
      "observed-instanced-draws-source",
      sample.counters.observedDrawCallsSource ?? "missing",
      "unavailable-webgpu",
      sample.counters.observedDrawCallsSource === "unavailable-webgpu",
    );
    record(
      "observed-instanced-draws",
      sample.counters.observedDrawCalls ?? -1,
      0,
      sample.counters.observedDrawCalls === 0,
    );
    for (const invariant of [
      "submittedCountExact",
      "submittedHashStable",
      "submittedGlyphsReadback",
      "pixelsRendered",
      "pixelReadbackRepeatable",
      "timestampFusedResolveExact",
      "timestampStandaloneSubmissionZero",
      "timestampSegmentedExact",
      "timestampSegmentsValid",
    ] as const) {
      const value = sample.invariants[invariant];
      record(invariant, String(value ?? "missing"), "true", value === true);
    }

    record(
      "product-frame-submissions",
      sample.counters.frameTransactionSubmissions ?? -1,
      expectedTimingSamples,
      sample.counters.frameTransactionSubmissions === expectedTimingSamples,
    );
    record(
      "product-frame-fused-submissions",
      sample.counters.frameTransactionFusedSubmissions ?? -1,
      expectedTimingSamples,
      sample.counters.frameTransactionFusedSubmissions === expectedTimingSamples,
    );
    record(
      "product-frame-standalone-submissions",
      sample.counters.frameTransactionStandaloneSubmissions ?? -1,
      0,
      sample.counters.frameTransactionStandaloneSubmissions === 0,
    );
    record(
      "diagnostic-readback-submissions",
      sample.counters.diagnosticReadbackSubmissions ?? -1,
      2,
      sample.counters.diagnosticReadbackSubmissions === 2,
    );
    record(
      "timestamp-readbacks",
      sample.counters.timestampReadbackSubmissions ?? -1,
      expectedTimingSamples,
      sample.counters.timestampReadbackSubmissions === expectedTimingSamples,
    );
    record(
      "timestamp-fused-resolves",
      sample.counters.timestampFusedResolves ?? -1,
      expectedTimingSamples,
      sample.counters.timestampFusedResolves === expectedTimingSamples,
    );
    record(
      "timestamp-standalone-submissions",
      sample.counters.timestampStandaloneSubmissions ?? -1,
      0,
      sample.counters.timestampStandaloneSubmissions === 0,
    );
    record(
      "timestamp-readback-ring-size",
      sample.counters.timestampReadbackRingSize ?? -1,
      3,
      sample.counters.timestampReadbackRingSize === 3,
    );
    record(
      "timestamp-max-pending-readbacks",
      sample.counters.timestampMaxPendingReadbacks ?? -1,
      3,
      sample.counters.timestampMaxPendingReadbacks === 3,
    );
    record(
      "timestamp-pending-readbacks-after-drain",
      sample.counters.timestampPendingReadbacks ?? -1,
      0,
      sample.counters.timestampPendingReadbacks === 0,
    );
    record(
      "timestamp-queries-per-frame",
      sample.counters.timestampQueriesPerFrame ?? -1,
      6,
      sample.counters.timestampQueriesPerFrame === 6,
    );
    record(
      "timestamp-segmented-samples",
      sample.counters.timestampSegmentedSamples ?? -1,
      expectedTimingSamples,
      sample.counters.timestampSegmentedSamples === expectedTimingSamples,
    );
    record(
      "timestamp-valid-segmented-samples",
      sample.counters.timestampValidSegmentedSamples ?? -1,
      expectedTimingSamples,
      sample.counters.timestampValidSegmentedSamples === expectedTimingSamples,
    );
    record(
      "timestamp-segmented-fallback-samples",
      sample.counters.timestampSegmentedFallbackSamples ?? -1,
      0,
      sample.counters.timestampSegmentedFallbackSamples === 0,
    );
    record(
      "timestamp-valid-palette-samples",
      sample.counters.timestampValidPaletteSamples ?? -1,
      expectedTimingSamples,
      sample.counters.timestampValidPaletteSamples === expectedTimingSamples,
    );
    record(
      "timestamp-valid-cull-samples",
      sample.counters.timestampValidCullSamples ?? -1,
      expectedTimingSamples,
      sample.counters.timestampValidCullSamples === expectedTimingSamples,
    );
    record(
      "timestamp-valid-scene-render-samples",
      sample.counters.timestampValidSceneRenderSamples ?? -1,
      expectedTimingSamples,
      sample.counters.timestampValidSceneRenderSamples === expectedTimingSamples,
    );

    const phases = sample.timings.phases;
    if (phases === undefined) {
      record("two-phase-timings", "missing", "present", false);
    } else {
      recordResidentPhase("camera", phases.camera, policy, record);
      recordResidentPhase("position-mutation", phases.positionMutation, policy, record);
      record(
        "camera-cpu-p95-ms",
        p95(phases.camera.cpuMs),
        GPU_SCENE_RESIDENT_CAMERA_CPU_BUDGET_MS,
        p95(phases.camera.cpuMs) <= GPU_SCENE_RESIDENT_CAMERA_CPU_BUDGET_MS,
      );
      record(
        "camera-commit-p95-ms",
        p95(phases.camera.commitMs),
        GPU_SCENE_RESIDENT_CAMERA_COMMIT_BUDGET_MS,
        p95(phases.camera.commitMs) <= GPU_SCENE_RESIDENT_CAMERA_COMMIT_BUDGET_MS,
      );
      record(
        "position-mutation-p95-ms",
        p95(phases.positionMutation.mutationMs),
        GPU_SCENE_RESIDENT_POSITION_MUTATION_BUDGET_MS,
        p95(phases.positionMutation.mutationMs) <= GPU_SCENE_RESIDENT_POSITION_MUTATION_BUDGET_MS,
      );
      record(
        "position-commit-p95-ms",
        p95(phases.positionMutation.commitMs),
        GPU_SCENE_RESIDENT_POSITION_COMMIT_BUDGET_MS,
        p95(phases.positionMutation.commitMs) <= GPU_SCENE_RESIDENT_POSITION_COMMIT_BUDGET_MS,
      );
      record(
        "camera-transform-upload-max-bytes",
        maximum(phases.camera.transformUploadBytes),
        0,
        maximum(phases.camera.transformUploadBytes) === 0,
      );
      record(
        "camera-cull-record-upload-max-bytes",
        maximum(phases.camera.cullRecordUploadBytes),
        0,
        maximum(phases.camera.cullRecordUploadBytes) === 0,
      );
      const positionTransformUploads = phases.positionMutation.transformUploadBytes ?? [];
      record(
        "position-transform-upload-min-bytes",
        minimum(positionTransformUploads),
        GPU_SCENE_RESIDENT_POSITION_UPLOAD_MIN_BYTES,
        positionTransformUploads.length === policy.sampleFrames &&
          minimum(positionTransformUploads) === GPU_SCENE_RESIDENT_POSITION_UPLOAD_MIN_BYTES,
      );
      record(
        "position-transform-upload-max-bytes",
        maximum(positionTransformUploads),
        GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES,
        positionTransformUploads.length === policy.sampleFrames &&
          maximum(positionTransformUploads) === GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES,
      );
      record(
        "position-transform-upload-exact-samples",
        positionTransformUploads.filter(
          (bytes) => bytes === GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES,
        ).length,
        policy.sampleFrames,
        positionTransformUploads.length === policy.sampleFrames &&
          positionTransformUploads.every(
            (bytes) => bytes === GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES,
          ),
      );
      record(
        "position-cull-record-upload-max-bytes",
        maximum(phases.positionMutation.cullRecordUploadBytes),
        0,
        maximum(phases.positionMutation.cullRecordUploadBytes) === 0,
      );
    }

    const timing = sample.timings.gpuTiming;
    record(
      "gpu-timing-method",
      timing?.method ?? "missing",
      "timestamp-query",
      timing?.method === "timestamp-query",
    );
    record(
      "gpu-timing-quality",
      timing?.quality ?? "missing",
      "valid",
      timing?.quality === "valid",
    );
    record(
      "gpu-timing-readback",
      String(timing?.readback ?? false),
      "true",
      timing?.readback === true,
    );
    record(
      "gpu-timing-samples",
      timing?.samples ?? 0,
      expectedTimingSamples,
      timing?.samples === expectedTimingSamples,
    );
    record(
      "gpu-timing-valid-samples",
      timing?.validSamples ?? 0,
      expectedTimingSamples,
      timing?.validSamples === expectedTimingSamples,
    );
    record(
      "gpu-timing-fallback-samples",
      timing?.fallbackSamples ?? 0,
      0,
      timing?.fallbackSamples === 0,
    );
    record(
      "gpu-timing-fused-resolves",
      timing?.fusedTimestampResolves ?? -1,
      expectedTimingSamples,
      timing?.fusedTimestampResolves === expectedTimingSamples,
    );
    record(
      "gpu-timing-standalone-submissions",
      timing?.standaloneTimestampSubmissions ?? -1,
      0,
      timing?.standaloneTimestampSubmissions === 0,
    );
    record(
      "gpu-timing-readback-mode",
      timing?.timestampReadbackMode ?? "missing",
      "deferred-ring",
      timing?.timestampReadbackMode === "deferred-ring",
    );
    record(
      "gpu-timing-readback-ring-size",
      timing?.timestampReadbackRingSize ?? -1,
      3,
      timing?.timestampReadbackRingSize === 3,
    );
    record(
      "gpu-timing-max-pending-readbacks",
      timing?.maxPendingTimestampReadbacks ?? -1,
      3,
      timing?.maxPendingTimestampReadbacks === 3,
    );
    record(
      "gpu-timing-pending-readbacks-after-drain",
      timing?.pendingTimestampReadbacks ?? -1,
      0,
      timing?.pendingTimestampReadbacks === 0,
    );
    record(
      "gpu-timing-segmented-writes",
      String(timing?.segmentedTimestampWrites ?? false),
      "true",
      timing?.segmentedTimestampWrites === true,
    );
    record(
      "gpu-timing-queries-per-frame",
      timing?.timestampQueriesPerFrame ?? -1,
      6,
      timing?.timestampQueriesPerFrame === 6,
    );
    record(
      "gpu-timing-segmented-samples",
      timing?.segmentedSamples ?? -1,
      expectedTimingSamples,
      timing?.segmentedSamples === expectedTimingSamples,
    );
    record(
      "gpu-timing-valid-segmented-samples",
      timing?.validSegmentedSamples ?? -1,
      expectedTimingSamples,
      timing?.validSegmentedSamples === expectedTimingSamples,
    );
    record(
      "gpu-timing-segmented-fallback-samples",
      timing?.segmentedFallbackSamples ?? -1,
      0,
      timing?.segmentedFallbackSamples === 0,
    );
    record(
      "gpu-timing-valid-palette-samples",
      timing?.validPaletteSamples ?? -1,
      expectedTimingSamples,
      timing?.validPaletteSamples === expectedTimingSamples,
    );
    record(
      "gpu-timing-valid-cull-samples",
      timing?.validCullSamples ?? -1,
      expectedTimingSamples,
      timing?.validCullSamples === expectedTimingSamples,
    );
    record(
      "gpu-timing-valid-scene-render-samples",
      timing?.validSceneRenderSamples ?? -1,
      expectedTimingSamples,
      timing?.validSceneRenderSamples === expectedTimingSamples,
    );
  }

  return Object.freeze({
    passed: checks.every((check) => check.passed),
    checks: Object.freeze(checks),
  });
}

function recordResidentPhase(
  name: string,
  phase: Readonly<BrowserBenchmarkPhaseTimings>,
  policy: Readonly<GpuSceneResidentBudgetPolicy>,
  record: RecordBudgetCheck,
): void {
  const expectedSamples = policy.sampleFrames;
  const timingMetrics: readonly (readonly [string, readonly unknown[] | undefined])[] = [
    ["frame", phase.frameMs],
    ["cpu", phase.cpuMs],
    ["gpu", phase.gpuMs],
    ["gpu-timestamp", phase.gpuTimestampMs],
    ["palette-gpu-timestamp", phase.paletteGpuTimestampMs],
    ["cull-gpu-timestamp", phase.cullGpuTimestampMs],
    ["scene-render-gpu-timestamp", phase.sceneRenderGpuTimestampMs],
    ["completion-wall", phase.completionWallMs],
    ["instrumentation-wall", phase.instrumentationWallMs],
    ["timestamp-readback-wall", phase.timestampReadbackWallMs],
    ["upload", phase.uploadMs],
    ["commit", phase.commitMs],
    ["culling", phase.cullingMs],
    ["mutation", phase.mutationMs],
    ["surface", phase.surfaceApplyMs],
    ["visibility-selection", phase.visibilitySelectionMs],
    ["render-preparation", phase.renderPreparationMs],
    ["render-coordinator", phase.renderCoordinatorMs],
  ];
  const integerMetrics: readonly (readonly [string, readonly unknown[] | undefined])[] = [
    ["upload-bytes", phase.uploadBytes],
    ["transform-upload-bytes", phase.transformUploadBytes],
    ["cull-record-upload-bytes", phase.cullRecordUploadBytes],
    ["deferred-spatial-labels", phase.deferredSpatialLabels],
    ["product-submission-deltas", phase.frameTransactionSubmissionDeltas],
    ["fused-submission-deltas", phase.frameTransactionFusedSubmissionDeltas],
    ["standalone-submission-deltas", phase.frameTransactionStandaloneSubmissionDeltas],
    ["offscreen-inspected-labels", phase.offscreenInspectedLabels],
    ["offscreen-materialized-labels", phase.offscreenMaterializedLabels],
    ["offscreen-admission-generation", phase.offscreenAdmissionGeneration],
    ["offscreen-admission-cursor", phase.offscreenAdmissionCursor],
    ["offscreen-admission-cursor-resets", phase.offscreenAdmissionCursorResets],
    ["offscreen-admission-cycles", phase.offscreenAdmissionCycles],
  ];
  for (const [metric, values] of timingMetrics) {
    record(
      `${name}-${metric}-samples`,
      values?.length ?? 0,
      expectedSamples,
      values?.length === expectedSamples,
    );
    record(
      `${name}-${metric}-values`,
      countValid(values, isFiniteNonnegativeNumber),
      expectedSamples,
      values?.length === expectedSamples && values.every(isFiniteNonnegativeNumber),
    );
  }
  for (const [metric, values] of integerMetrics) {
    record(
      `${name}-${metric}-samples`,
      values?.length ?? 0,
      expectedSamples,
      values?.length === expectedSamples,
    );
    record(
      `${name}-${metric}-values`,
      countValid(values, isFiniteNonnegativeInteger),
      expectedSamples,
      values?.length === expectedSamples && values.every(isFiniteNonnegativeInteger),
    );
  }
  record(
    `${name}-frame-metric-definition`,
    phase.frameMetric ?? "missing",
    "mutation+timer-cpu+queue-completion",
    phase.frameMetric === "mutation+timer-cpu+queue-completion",
  );
  const composedFrameSamples = phase.frameMs.filter((sample, index) =>
    numbersEqual(
      sample,
      (phase.mutationMs[index] ?? Number.NaN) +
        (phase.cpuMs[index] ?? Number.NaN) +
        (phase.completionWallMs[index] ?? Number.NaN),
    ),
  ).length;
  record(
    `${name}-frame-metric-composed-samples`,
    composedFrameSamples,
    expectedSamples,
    phase.frameMs.length === expectedSamples && composedFrameSamples === expectedSamples,
  );
  record(
    `${name}-offscreen-admission-deferred-samples`,
    phase.offscreenAdmissionDeferred.length,
    expectedSamples,
    phase.offscreenAdmissionDeferred.length === expectedSamples,
  );
  record(
    `${name}-offscreen-admission-deferred-values`,
    phase.offscreenAdmissionDeferred.filter((value) => typeof value === "boolean").length,
    expectedSamples,
    phase.offscreenAdmissionDeferred.length === expectedSamples &&
      phase.offscreenAdmissionDeferred.every((value) => typeof value === "boolean"),
  );
  recordNumericDomain(`${name}-frame-budget-ms-domain`, phase.frameBudgetMs, false, record);
  recordNumericDomain(
    `${name}-frame-over-budget-count-domain`,
    phase.frameOverBudgetCount,
    true,
    record,
  );
  recordNumericDomain(
    `${name}-frame-over-budget-ratio-domain`,
    phase.frameOverBudgetRatio,
    false,
    record,
  );
  recordNumericDomain(`${name}-frame-p99-ms-domain`, phase.frameP99Ms, false, record);
  recordNumericDomain(`${name}-frame-max-ms-domain`, phase.frameMaxMs, false, record);
  recordNumericDomain(`${name}-shaped-labels-delta-domain`, phase.shapedLabelsDelta, true, record);
  recordNumericDomain(
    `${name}-admitted-labels-total-domain`,
    phase.admittedLabelsTotal,
    true,
    record,
  );
  recordNumericDomain(
    `${name}-culling-queries-delta-domain`,
    phase.cullingQueriesDelta,
    true,
    record,
  );
  const productSubmissions = phase.frameTransactionSubmissionDeltas ?? [];
  const fusedSubmissions = phase.frameTransactionFusedSubmissionDeltas ?? [];
  const standaloneSubmissions = phase.frameTransactionStandaloneSubmissionDeltas ?? [];
  record(
    `${name}-product-submissions-exact`,
    productSubmissions.filter((value) => value === 1).length,
    expectedSamples,
    productSubmissions.length === expectedSamples &&
      productSubmissions.every((value) => value === 1),
  );
  record(
    `${name}-fused-submissions-exact`,
    fusedSubmissions.filter((value) => value === 1).length,
    expectedSamples,
    fusedSubmissions.length === expectedSamples && fusedSubmissions.every((value) => value === 1),
  );
  record(
    `${name}-standalone-submissions-zero`,
    standaloneSubmissions.filter((value) => value === 0).length,
    expectedSamples,
    standaloneSubmissions.length === expectedSamples &&
      standaloneSubmissions.every((value) => value === 0),
  );
  record(
    `${name}-frame-p95-ms`,
    p95(phase.frameMs),
    GPU_SCENE_RESIDENT_FRAME_BUDGET_MS,
    p95(phase.frameMs) <= GPU_SCENE_RESIDENT_FRAME_BUDGET_MS,
  );
  const frameP99 = p99(phase.frameMs);
  const frameMax = maximum(phase.frameMs);
  const frameOverBudgetCount = phase.frameMs.filter(
    (sample) => sample > GPU_SCENE_RESIDENT_FRAME_BUDGET_MS,
  ).length;
  const frameOverBudgetRatio =
    phase.frameMs.length === 0
      ? Number.POSITIVE_INFINITY
      : frameOverBudgetCount / phase.frameMs.length;
  record(
    `${name}-frame-budget-ms-recorded`,
    phase.frameBudgetMs ?? Number.POSITIVE_INFINITY,
    GPU_SCENE_RESIDENT_FRAME_BUDGET_MS,
    phase.frameBudgetMs === GPU_SCENE_RESIDENT_FRAME_BUDGET_MS,
  );
  record(
    `${name}-frame-over-budget-count-recorded`,
    phase.frameOverBudgetCount ?? -1,
    frameOverBudgetCount,
    phase.frameOverBudgetCount === frameOverBudgetCount,
  );
  record(
    `${name}-frame-over-budget-ratio-recorded`,
    phase.frameOverBudgetRatio ?? Number.POSITIVE_INFINITY,
    frameOverBudgetRatio,
    numbersEqual(phase.frameOverBudgetRatio, frameOverBudgetRatio),
  );
  record(
    `${name}-frame-p99-ms-recorded`,
    phase.frameP99Ms ?? Number.POSITIVE_INFINITY,
    frameP99,
    numbersEqual(phase.frameP99Ms, frameP99),
  );
  record(
    `${name}-frame-max-ms-recorded`,
    phase.frameMaxMs ?? Number.POSITIVE_INFINITY,
    frameMax,
    numbersEqual(phase.frameMaxMs, frameMax),
  );
  record(
    `${name}-frame-over-budget-count`,
    frameOverBudgetCount,
    policy.maximumOverBudgetFrames,
    frameOverBudgetCount <= policy.maximumOverBudgetFrames,
  );
  record(
    `${name}-frame-over-budget-ratio`,
    frameOverBudgetRatio,
    policy.maximumOverBudgetRatio,
    frameOverBudgetRatio <= policy.maximumOverBudgetRatio,
  );
  record(
    `${name}-frame-p99-ms`,
    frameP99,
    GPU_SCENE_RESIDENT_FRAME_BUDGET_MS,
    frameP99 <= GPU_SCENE_RESIDENT_FRAME_BUDGET_MS,
  );
  record(
    `${name}-frame-max-ms`,
    frameMax,
    policy.frameMaxIsGate ? GPU_SCENE_RESIDENT_FRAME_BUDGET_MS : "telemetry",
    policy.frameMaxIsGate
      ? frameMax <= GPU_SCENE_RESIDENT_FRAME_BUDGET_MS
      : Number.isFinite(frameMax),
  );
  record(
    `${name}-gpu-p95-ms`,
    p95(phase.gpuMs),
    GPU_SCENE_RESIDENT_FRAME_BUDGET_MS,
    p95(phase.gpuMs) <= GPU_SCENE_RESIDENT_FRAME_BUDGET_MS,
  );
  record(
    `${name}-surface-p95-ms`,
    p95(phase.surfaceApplyMs),
    GPU_SCENE_RESIDENT_SURFACE_BUDGET_MS,
    p95(phase.surfaceApplyMs) <= GPU_SCENE_RESIDENT_SURFACE_BUDGET_MS,
  );
  record(`${name}-shaped-labels-delta`, phase.shapedLabelsDelta, 0, phase.shapedLabelsDelta === 0);
  record(
    `${name}-admitted-labels-total`,
    phase.admittedLabelsTotal,
    0,
    phase.admittedLabelsTotal === 0,
  );
  record(
    `${name}-culling-queries-delta`,
    phase.cullingQueriesDelta ?? Number.POSITIVE_INFINITY,
    0,
    phase.cullingQueriesDelta === 0,
  );
}

function recordNumericDomain(
  name: string,
  value: unknown,
  integer: boolean,
  record: RecordBudgetCheck,
): void {
  const passed = integer ? isFiniteNonnegativeInteger(value) : isFiniteNonnegativeNumber(value);
  record(
    name,
    numericActual(value),
    integer ? "finite nonnegative integer" : "finite nonnegative number",
    passed,
  );
}

function numericActual(value: unknown): number | string {
  return typeof value === "number" && Number.isFinite(value) ? value : String(value);
}

function isFiniteNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isFiniteNonnegativeInteger(value: unknown): value is number {
  return isFiniteNonnegativeNumber(value) && Number.isInteger(value);
}

function countValid(
  values: readonly unknown[] | undefined,
  predicate: (value: unknown) => boolean,
): number {
  return values?.filter(predicate).length ?? 0;
}

function p95(samples: readonly number[]): number {
  if (samples.length === 0) return Number.POSITIVE_INFINITY;
  return summarize(samples, "ms").p95;
}

function p99(samples: readonly number[]): number {
  if (samples.length === 0) return Number.POSITIVE_INFINITY;
  return summarize(samples, "ms").p99;
}

function numbersEqual(left: number | undefined, right: number): boolean {
  return left !== undefined && Number.isFinite(left) && Math.abs(left - right) <= 1e-12;
}

function minimum(samples: readonly number[]): number {
  if (samples.length === 0) return Number.POSITIVE_INFINITY;
  let value = Number.POSITIVE_INFINITY;
  for (const sample of samples) value = Math.min(value, sample);
  return value;
}

function maximum(samples: readonly number[] | undefined): number {
  if (samples === undefined || samples.length === 0) return Number.POSITIVE_INFINITY;
  let value = 0;
  for (const sample of samples) value = Math.max(value, sample);
  return value;
}
