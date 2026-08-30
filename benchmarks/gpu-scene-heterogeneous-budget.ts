import {
  BENCHMARK_SCHEMA_VERSION,
  summarize,
  type BrowserBenchmarkBudgetCheck,
  type BrowserBenchmarkBudgetDecision,
  type BrowserBenchmarkPhaseTimings,
  type BrowserBenchmarkSample,
} from "./schema";
import { getBenchmarkWorkload } from "./workloads";

export const GPU_SCENE_HETEROGENEOUS_PROTOTYPES = 64;
export const GPU_SCENE_HETEROGENEOUS_PAINTS = 8;
export const GPU_SCENE_HETEROGENEOUS_PROTOTYPE_PAINT_PAIRS = 512;
export const GPU_SCENE_HETEROGENEOUS_REPETITIONS = 2;
export const GPU_SCENE_HETEROGENEOUS_DELIVERY_FRAME_BUDGET_MS = 33.34;
export const GPU_SCENE_HETEROGENEOUS_PROMOTION_FRAME_BUDGET_MS = 16.67;
export const GPU_SCENE_HETEROGENEOUS_CAMERA_BASELINE_P95_MS = 199.5;
export const GPU_SCENE_HETEROGENEOUS_POSITION_BASELINE_P95_MS = 199.9;
export const GPU_SCENE_HETEROGENEOUS_MINIMUM_SPEEDUP = 4;
export const GPU_SCENE_HETEROGENEOUS_CAMERA_CPU_BUDGET_MS = 4;
export const GPU_SCENE_HETEROGENEOUS_CAMERA_COMMIT_BUDGET_MS = 2;
export const GPU_SCENE_HETEROGENEOUS_POSITION_CPU_BUDGET_MS = 8;
export const GPU_SCENE_HETEROGENEOUS_POSITION_COMMIT_BUDGET_MS = 4;
export const GPU_SCENE_HETEROGENEOUS_SURFACE_BUDGET_MS = 2;
export const GPU_SCENE_HETEROGENEOUS_GPU_BUDGET_MS = 30;
export const GPU_SCENE_HETEROGENEOUS_SETUP_BUDGET_MS = 2_000;
export const GPU_SCENE_HETEROGENEOUS_HEAP_BUDGET_BYTES: number = 512 * 1_024 ** 2;
export const GPU_SCENE_HETEROGENEOUS_POSITION_UPLOAD_BYTES = 800_016;
export const GPU_SCENE_HETEROGENEOUS_INITIAL_CULL_UPLOAD_BYTES = 32_000_000;
export const GPU_SCENE_HETEROGENEOUS_VISIBLE_GLYPHS_MIN = 250_000;
export const GPU_SCENE_HETEROGENEOUS_VISIBLE_GLYPHS_MAX = 270_000;

export interface GpuSceneHeterogeneousBudgetDecision extends BrowserBenchmarkBudgetDecision {
  readonly baseline: Readonly<{
    workload: "gpu-scene-v2";
    cameraFrameP95Ms: number;
    positionFrameP95Ms: number;
    minimumSpeedup: number;
  }>;
  readonly delivery: Readonly<{
    passed: boolean;
    frameBudgetMs: number;
  }>;
  readonly promotion: Readonly<{
    status: "GO" | "PAUSE";
    frameBudgetMs: number;
    cameraPassed: boolean;
    positionPassed: boolean;
  }>;
}

type RecordCheck = (
  name: string,
  actual: number | string,
  limit: number | string,
  passed: boolean,
) => void;

export function evaluateGpuSceneHeterogeneousBudget(
  samples: readonly Readonly<BrowserBenchmarkSample>[],
): Readonly<GpuSceneHeterogeneousBudgetDecision> {
  const expected = getBenchmarkWorkload("gpu-scene-heterogeneous-64");
  const checks: BrowserBenchmarkBudgetCheck[] = [];
  const record: RecordCheck = (name, actual, limit, passed): void => {
    checks.push(Object.freeze({ name, actual, limit, passed }));
  };

  record(
    "repetitions",
    samples.length,
    GPU_SCENE_HETEROGENEOUS_REPETITIONS,
    samples.length === GPU_SCENE_HETEROGENEOUS_REPETITIONS,
  );

  let cameraPromotionPassed = samples.length === GPU_SCENE_HETEROGENEOUS_REPETITIONS;
  let positionPromotionPassed = samples.length === GPU_SCENE_HETEROGENEOUS_REPETITIONS;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    const repeatIndex = index + 1;
    const configuration = sample.configuration;
    const camera = sample.timings.phases?.camera;
    const position = sample.timings.phases?.positionMutation;
    const expectedTimingSamples = 2 * (configuration.warmupFrames + configuration.sampleFrames);

    record(
      "repeat-index",
      sample.repeatIndex ?? "missing",
      repeatIndex,
      sample.repeatIndex === repeatIndex,
    );
    record(
      "schema-version",
      sample.schemaVersion,
      BENCHMARK_SCHEMA_VERSION,
      sample.schemaVersion === BENCHMARK_SCHEMA_VERSION,
    );
    record("workload", configuration.workload, expected.id, configuration.workload === expected.id);
    record("renderer", configuration.renderer, "webgpu", configuration.renderer === "webgpu");
    for (const [name, actual, limit] of [
      ["resident-labels", configuration.labelCount, expected.labelCount],
      ["position-mutations", configuration.mutationCount, expected.mutationCount],
      ["warmup-frames", configuration.warmupFrames, expected.warmupFrames],
      ["sample-frames", configuration.sampleFrames, expected.sampleFrames],
      ["width", configuration.width, 1_280],
      ["height", configuration.height, 800],
    ] as const) {
      record(name, actual, limit, actual === limit);
    }

    recordFinite("setup-ms-domain", sample.timings.setupMs, false, record);
    record(
      "setup-ms",
      finiteOrMissing(sample.timings.setupMs),
      GPU_SCENE_HETEROGENEOUS_SETUP_BUDGET_MS,
      isFiniteNumber(sample.timings.setupMs) &&
        sample.timings.setupMs <= GPU_SCENE_HETEROGENEOUS_SETUP_BUDGET_MS,
    );
    record(
      "scene-setup-ms",
      finiteOrMissing(sample.counters.lastSceneSetupMs),
      GPU_SCENE_HETEROGENEOUS_SETUP_BUDGET_MS,
      isFiniteNumber(sample.counters.lastSceneSetupMs) &&
        sample.counters.lastSceneSetupMs > 0 &&
        sample.counters.lastSceneSetupMs <= GPU_SCENE_HETEROGENEOUS_SETUP_BUDGET_MS,
    );
    record(
      "heap-bytes",
      integerOrMissing(sample.counters.heapBytes),
      GPU_SCENE_HETEROGENEOUS_HEAP_BUDGET_BYTES,
      isNonNegativeInteger(sample.counters.heapBytes) &&
        sample.counters.heapBytes <= GPU_SCENE_HETEROGENEOUS_HEAP_BUDGET_BYTES,
    );

    recordExactCounter(sample, "resident-labels", "residentLabels", expected.labelCount, record);
    recordExactCounter(
      sample,
      "gpu-resident-labels",
      "gpuResidentLabels",
      expected.labelCount,
      record,
    );
    recordExactCounter(
      sample,
      "prototype-count",
      "prototypeCount",
      GPU_SCENE_HETEROGENEOUS_PROTOTYPES,
      record,
    );
    recordExactCounter(sample, "paint-count", "paintCount", GPU_SCENE_HETEROGENEOUS_PAINTS, record);
    recordExactCounter(
      sample,
      "prototype-paint-pair-count",
      "prototypePaintPairCount",
      GPU_SCENE_HETEROGENEOUS_PROTOTYPE_PAINT_PAIRS,
      record,
    );
    recordExactCounter(sample, "per-label-object-count", "gpuScenePerLabelObjectCount", 0, record);
    recordExactCounter(
      sample,
      "deferred-spatial-labels",
      "deferredSpatialLabels",
      expected.mutationCount,
      record,
    );
    recordExactCounter(
      sample,
      "initial-cull-record-upload-bytes",
      "cullRecordUploadBytes",
      GPU_SCENE_HETEROGENEOUS_INITIAL_CULL_UPLOAD_BYTES,
      record,
    );
    record(
      "collision-enabled",
      sample.counters.collisionEnabled === undefined
        ? "missing"
        : String(sample.counters.collisionEnabled),
      "false",
      sample.counters.collisionEnabled === false,
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
      "expected-submitted-source",
      sample.counters.expectedSubmittedGlyphsSource ?? "missing",
      "cpu-prototype-bounds",
      sample.counters.expectedSubmittedGlyphsSource === "cpu-prototype-bounds",
    );
    record(
      "camera-submitted-count",
      integerOrMissing(sample.counters.cameraSubmittedGlyphs),
      integerOrMissing(sample.counters.expectedCameraSubmittedGlyphs),
      isNonNegativeInteger(sample.counters.expectedCameraSubmittedGlyphs) &&
        sample.counters.expectedCameraSubmittedGlyphs > 0 &&
        sample.counters.cameraSubmittedGlyphs === sample.counters.expectedCameraSubmittedGlyphs,
    );
    record(
      "camera-submitted-hash",
      integerOrMissing(sample.counters.cameraSubmittedGlyphsHash),
      integerOrMissing(sample.counters.expectedCameraSubmittedGlyphsHash),
      isNonNegativeInteger(sample.counters.expectedCameraSubmittedGlyphsHash) &&
        sample.counters.cameraSubmittedGlyphsHash ===
          sample.counters.expectedCameraSubmittedGlyphsHash,
    );
    record(
      "submitted-count",
      integerOrMissing(sample.counters.submittedGlyphs),
      integerOrMissing(sample.counters.expectedSubmittedGlyphs),
      isNonNegativeInteger(sample.counters.expectedSubmittedGlyphs) &&
        sample.counters.expectedSubmittedGlyphs > 0 &&
        sample.counters.submittedGlyphs === sample.counters.expectedSubmittedGlyphs,
    );
    record(
      "submitted-labels",
      integerOrMissing(sample.counters.submittedLabels),
      integerOrMissing(sample.counters.expectedSubmittedGlyphs),
      sample.counters.submittedLabels === sample.counters.expectedSubmittedGlyphs,
    );
    record(
      "submitted-hash",
      integerOrMissing(sample.counters.submittedGlyphsHash),
      integerOrMissing(sample.counters.expectedSubmittedGlyphsHash),
      isNonNegativeInteger(sample.counters.expectedSubmittedGlyphsHash) &&
        sample.counters.submittedGlyphsHash === sample.counters.expectedSubmittedGlyphsHash,
    );
    record(
      "full-screen-visible-scale",
      integerOrMissing(sample.counters.expectedSubmittedGlyphs),
      `${String(GPU_SCENE_HETEROGENEOUS_VISIBLE_GLYPHS_MIN)}..${String(
        GPU_SCENE_HETEROGENEOUS_VISIBLE_GLYPHS_MAX,
      )}`,
      isNonNegativeInteger(sample.counters.expectedSubmittedGlyphs) &&
        sample.counters.expectedSubmittedGlyphs >= GPU_SCENE_HETEROGENEOUS_VISIBLE_GLYPHS_MIN &&
        sample.counters.expectedSubmittedGlyphs <= GPU_SCENE_HETEROGENEOUS_VISIBLE_GLYPHS_MAX,
    );
    record(
      "pixel-readback-repeat",
      integerOrMissing(sample.counters.renderedPixelHashRepeat),
      integerOrMissing(sample.counters.renderedPixelHash),
      isNonNegativeInteger(sample.counters.renderedPixelHash) &&
        sample.counters.renderedPixelHash > 0 &&
        sample.counters.renderedPixelHashRepeat === sample.counters.renderedPixelHash,
    );
    record(
      "non-transparent-pixels-repeat",
      integerOrMissing(sample.counters.nonTransparentPixelsRepeat),
      integerOrMissing(sample.counters.nonTransparentPixels),
      isNonNegativeInteger(sample.counters.nonTransparentPixels) &&
        sample.counters.nonTransparentPixels > 0 &&
        sample.counters.nonTransparentPixelsRepeat === sample.counters.nonTransparentPixels,
    );
    record(
      "expected-submitted-identity-invariant",
      String(sample.invariants.expectedSubmittedIdentity ?? "missing"),
      "true",
      sample.invariants.expectedSubmittedIdentity === true,
    );
    record(
      "pixel-readback-repeatable-invariant",
      String(sample.invariants.pixelReadbackRepeatable ?? "missing"),
      "true",
      sample.invariants.pixelReadbackRepeatable === true,
    );
    for (const [name, invariant] of [
      ["prototype-paint-interleave-exact-invariant", "prototypePaintInterleaveExact"],
      ["timestamp-segmented-exact-invariant", "timestampSegmentedExact"],
      ["timestamp-segments-valid-invariant", "timestampSegmentsValid"],
    ] as const) {
      const value = sample.invariants[invariant];
      record(name, String(value ?? "missing"), "true", value === true);
    }
    for (const [name, field, exact] of [
      ["product-frame-submissions", "frameTransactionSubmissions", expectedTimingSamples],
      [
        "product-frame-fused-submissions",
        "frameTransactionFusedSubmissions",
        expectedTimingSamples,
      ],
      ["product-frame-standalone-submissions", "frameTransactionStandaloneSubmissions", 0],
      ["diagnostic-readback-submissions", "diagnosticReadbackSubmissions", 2],
      ["timestamp-readback-ring-size", "timestampReadbackRingSize", 3],
      ["timestamp-max-pending-readbacks", "timestampMaxPendingReadbacks", 3],
      ["timestamp-pending-readbacks-after-drain", "timestampPendingReadbacks", 0],
    ] as const) {
      recordExactCounter(sample, name, field, exact, record);
    }

    if (camera === undefined || position === undefined) {
      record("phase-telemetry", "missing", "camera+position", false);
      cameraPromotionPassed = false;
      positionPromotionPassed = false;
      continue;
    }
    validatePhase("camera", camera, expected.sampleFrames, record);
    validatePhase("position", position, expected.sampleFrames, record);
    validatePhaseBudgets("camera", camera, record);
    validatePhaseBudgets("position", position, record);
    validateUploads("camera", camera, 0, record);
    validateUploads("position", position, GPU_SCENE_HETEROGENEOUS_POSITION_UPLOAD_BYTES, record);
    validateTransactionSamples("camera", camera, expected.sampleFrames, record);
    validateTransactionSamples("position", position, expected.sampleFrames, record);
    validatePostSetupDeltas("camera", camera, record);
    validatePostSetupDeltas("position", position, record);

    const cameraP95 = safeP95(camera.frameMs);
    const positionP95 = safeP95(position.frameMs);
    record(
      "camera-speedup-vs-gpu-scene-v2",
      finiteOrMissing(speedup(GPU_SCENE_HETEROGENEOUS_CAMERA_BASELINE_P95_MS, cameraP95)),
      GPU_SCENE_HETEROGENEOUS_MINIMUM_SPEEDUP,
      isFiniteNumber(cameraP95) &&
        speedup(GPU_SCENE_HETEROGENEOUS_CAMERA_BASELINE_P95_MS, cameraP95) >=
          GPU_SCENE_HETEROGENEOUS_MINIMUM_SPEEDUP,
    );
    record(
      "position-speedup-vs-gpu-scene-v2",
      finiteOrMissing(speedup(GPU_SCENE_HETEROGENEOUS_POSITION_BASELINE_P95_MS, positionP95)),
      GPU_SCENE_HETEROGENEOUS_MINIMUM_SPEEDUP,
      isFiniteNumber(positionP95) &&
        speedup(GPU_SCENE_HETEROGENEOUS_POSITION_BASELINE_P95_MS, positionP95) >=
          GPU_SCENE_HETEROGENEOUS_MINIMUM_SPEEDUP,
    );
    cameraPromotionPassed &&=
      isFiniteNumber(cameraP95) && cameraP95 <= GPU_SCENE_HETEROGENEOUS_PROMOTION_FRAME_BUDGET_MS;
    positionPromotionPassed &&=
      isFiniteNumber(positionP95) &&
      positionP95 <= GPU_SCENE_HETEROGENEOUS_PROMOTION_FRAME_BUDGET_MS;

    validateTimestampSummary(sample, expected.sampleFrames, record);
  }

  const first = samples[0]?.counters;
  for (const [name, read] of [
    [
      "camera-submitted-count",
      (sample: BrowserBenchmarkSample) => sample.counters.cameraSubmittedGlyphs,
    ],
    [
      "camera-submitted-hash",
      (sample: BrowserBenchmarkSample) => sample.counters.cameraSubmittedGlyphsHash,
    ],
    ["submitted-count", (sample: BrowserBenchmarkSample) => sample.counters.submittedGlyphs],
    ["submitted-hash", (sample: BrowserBenchmarkSample) => sample.counters.submittedGlyphsHash],
    ["pixel-hash", (sample: BrowserBenchmarkSample) => sample.counters.renderedPixelHash],
    [
      "non-transparent-pixels",
      (sample: BrowserBenchmarkSample) => sample.counters.nonTransparentPixels,
    ],
  ] as const) {
    const expectedValue = first === undefined ? undefined : read(samples[0]!);
    const exact =
      samples.length === GPU_SCENE_HETEROGENEOUS_REPETITIONS &&
      isNonNegativeInteger(expectedValue) &&
      samples.every((sample) => read(sample) === expectedValue);
    record(
      `repetition-${name}-exact`,
      exact ? integerOrMissing(expectedValue) : "mismatch",
      integerOrMissing(expectedValue),
      exact,
    );
  }

  const deliveryPassed = checks.every((check) => check.passed);
  return Object.freeze({
    passed: deliveryPassed,
    checks: Object.freeze(checks),
    baseline: Object.freeze({
      workload: "gpu-scene-v2",
      cameraFrameP95Ms: GPU_SCENE_HETEROGENEOUS_CAMERA_BASELINE_P95_MS,
      positionFrameP95Ms: GPU_SCENE_HETEROGENEOUS_POSITION_BASELINE_P95_MS,
      minimumSpeedup: GPU_SCENE_HETEROGENEOUS_MINIMUM_SPEEDUP,
    }),
    delivery: Object.freeze({
      passed: deliveryPassed,
      frameBudgetMs: GPU_SCENE_HETEROGENEOUS_DELIVERY_FRAME_BUDGET_MS,
    }),
    promotion: Object.freeze({
      status: cameraPromotionPassed && positionPromotionPassed ? "GO" : "PAUSE",
      frameBudgetMs: GPU_SCENE_HETEROGENEOUS_PROMOTION_FRAME_BUDGET_MS,
      cameraPassed: cameraPromotionPassed,
      positionPassed: positionPromotionPassed,
    }),
  });
}

function validatePhase(
  name: "camera" | "position",
  phase: Readonly<BrowserBenchmarkPhaseTimings>,
  expectedSamples: number,
  record: RecordCheck,
): void {
  record(
    `${name}-frame-metric`,
    phase.frameMetric ?? "missing",
    "mutation+timer-cpu+queue-completion",
    phase.frameMetric === "mutation+timer-cpu+queue-completion",
  );
  for (const [field, values, nullable] of [
    ["frame", phase.frameMs, false],
    ["cpu", phase.cpuMs, false],
    ["gpu-timestamp", phase.gpuTimestampMs, false],
    ["palette-gpu-timestamp", phase.paletteGpuTimestampMs, false],
    ["cull-gpu-timestamp", phase.cullGpuTimestampMs, false],
    ["scene-render-gpu-timestamp", phase.sceneRenderGpuTimestampMs, false],
    ["completion-wall", phase.completionWallMs, false],
    ["commit", phase.commitMs, false],
    ["surface", phase.surfaceApplyMs, false],
  ] as const) {
    const array = Array.isArray(values) ? values : [];
    record(
      `${name}-${field}-samples`,
      array.length,
      expectedSamples,
      array.length === expectedSamples,
    );
    record(
      `${name}-${field}-values`,
      array.filter((value) => validSampleValue(value, nullable)).length,
      expectedSamples,
      array.length === expectedSamples && array.every((value) => validSampleValue(value, nullable)),
    );
  }
  const composed = phase.frameMs.reduce((count, frame, index) => {
    const mutation = phase.mutationMs[index];
    const cpu = phase.cpuMs[index];
    const completion = phase.completionWallMs[index];
    if (
      !isFiniteNumber(frame) ||
      !isFiniteNumber(mutation) ||
      !isFiniteNumber(cpu) ||
      !isFiniteNumber(completion)
    ) {
      return count;
    }
    return count + Number(Math.abs(frame - (mutation + cpu + completion)) <= 1e-6);
  }, 0);
  record(
    `${name}-frame-metric-composed-samples`,
    composed,
    expectedSamples,
    composed === expectedSamples,
  );
  const frames = Array.isArray(phase.frameMs) ? phase.frameMs : [];
  const validFrames =
    frames.length === expectedSamples &&
    frames.every((value) => isFiniteNumber(value) && value >= 0);
  const distribution = validFrames ? summarize(frames as readonly number[], "ms") : undefined;
  const overBudgetCount = validFrames
    ? frames.filter((value) => value > GPU_SCENE_HETEROGENEOUS_PROMOTION_FRAME_BUDGET_MS).length
    : -1;
  const overBudgetRatio = validFrames ? overBudgetCount / frames.length : Number.POSITIVE_INFINITY;
  for (const [field, actual, exact] of [
    [
      "frame-budget-ms-recorded",
      phase.frameBudgetMs,
      GPU_SCENE_HETEROGENEOUS_PROMOTION_FRAME_BUDGET_MS,
    ],
    ["frame-over-budget-count-recorded", phase.frameOverBudgetCount, overBudgetCount],
    ["frame-over-budget-ratio-recorded", phase.frameOverBudgetRatio, overBudgetRatio],
    ["frame-p99-ms-recorded", phase.frameP99Ms, distribution?.p99],
    ["frame-max-ms-recorded", phase.frameMaxMs, distribution?.max],
  ] as const) {
    record(
      `${name}-${field}`,
      finiteOrMissing(actual),
      finiteOrMissing(exact),
      isFiniteNumber(exact) && numbersEqual(actual, exact),
    );
  }
}

function validatePhaseBudgets(
  name: "camera" | "position",
  phase: Readonly<BrowserBenchmarkPhaseTimings>,
  record: RecordCheck,
): void {
  const frameP95 = safeP95(phase.frameMs);
  const cpuP95 = safeP95(phase.cpuMs);
  const commitP95 = safeP95(phase.commitMs);
  const surfaceP95 = safeP95(phase.surfaceApplyMs);
  const gpuP95 = safeP95(phase.gpuTimestampMs);
  const cpuLimit =
    name === "camera"
      ? GPU_SCENE_HETEROGENEOUS_CAMERA_CPU_BUDGET_MS
      : GPU_SCENE_HETEROGENEOUS_POSITION_CPU_BUDGET_MS;
  const commitLimit =
    name === "camera"
      ? GPU_SCENE_HETEROGENEOUS_CAMERA_COMMIT_BUDGET_MS
      : GPU_SCENE_HETEROGENEOUS_POSITION_COMMIT_BUDGET_MS;
  for (const [field, actual, limit] of [
    ["frame", frameP95, GPU_SCENE_HETEROGENEOUS_DELIVERY_FRAME_BUDGET_MS],
    ["cpu", cpuP95, cpuLimit],
    ["commit", commitP95, commitLimit],
    ["surface", surfaceP95, GPU_SCENE_HETEROGENEOUS_SURFACE_BUDGET_MS],
    ["gpu", gpuP95, GPU_SCENE_HETEROGENEOUS_GPU_BUDGET_MS],
  ] as const) {
    record(
      `${name}-${field}-p95-ms`,
      finiteOrMissing(actual),
      limit,
      isFiniteNumber(actual) && actual <= limit,
    );
  }
}

function validateUploads(
  name: "camera" | "position",
  phase: Readonly<BrowserBenchmarkPhaseTimings>,
  expectedTransformBytes: number,
  record: RecordCheck,
): void {
  const count = phase.frameMs.length;
  for (const [field, values, expected] of [
    ["upload", phase.uploadBytes, expectedTransformBytes],
    ["transform-upload", phase.transformUploadBytes, expectedTransformBytes],
    ["cull-record-upload", phase.cullRecordUploadBytes, 0],
  ] as const) {
    const array = Array.isArray(values) ? values : [];
    const exact = array.filter((value) => value === expected).length;
    record(
      `${name}-${field}-exact-samples`,
      exact,
      count,
      exact === count && array.length === count,
    );
  }
}

function validateTransactionSamples(
  name: "camera" | "position",
  phase: Readonly<BrowserBenchmarkPhaseTimings>,
  expectedSamples: number,
  record: RecordCheck,
): void {
  for (const [field, values, expected] of [
    ["product-submissions", phase.frameTransactionSubmissionDeltas, 1],
    ["fused-submissions", phase.frameTransactionFusedSubmissionDeltas, 1],
    ["standalone-submissions", phase.frameTransactionStandaloneSubmissionDeltas, 0],
  ] as const) {
    const array = Array.isArray(values) ? values : [];
    const exact = array.filter((value) => value === expected).length;
    record(
      `${name}-${field}-exact`,
      exact,
      expectedSamples,
      array.length === expectedSamples && exact === expectedSamples,
    );
  }
}

function validatePostSetupDeltas(
  name: "camera" | "position",
  phase: Readonly<BrowserBenchmarkPhaseTimings>,
  record: RecordCheck,
): void {
  for (const [field, value] of [
    ["shaped-labels-delta", phase.shapedLabelsDelta],
    ["admitted-labels-delta", phase.admittedLabelsTotal],
    ["culling-queries-delta", phase.cullingQueriesDelta],
  ] as const) {
    record(`${name}-${field}`, integerOrMissing(value), 0, value === 0);
  }
}

function validateTimestampSummary(
  sample: Readonly<BrowserBenchmarkSample>,
  sampleFrames: number,
  record: RecordCheck,
): void {
  const expected = 2 * (sample.configuration.warmupFrames + sampleFrames);
  const timing = sample.timings.gpuTiming;
  record(
    "gpu-timing-method",
    timing?.method ?? "missing",
    "timestamp-query",
    timing?.method === "timestamp-query",
  );
  record("gpu-timing-quality", timing?.quality ?? "missing", "valid", timing?.quality === "valid");
  record(
    "gpu-timing-readback-mode",
    timing?.timestampReadbackMode ?? "missing",
    "deferred-ring",
    timing?.timestampReadbackMode === "deferred-ring",
  );
  for (const [field, actual, limit] of [
    ["gpu-timing-readback-ring-size", timing?.timestampReadbackRingSize, 3],
    ["gpu-timing-max-pending-readbacks", timing?.maxPendingTimestampReadbacks, 3],
    ["gpu-timing-pending-readbacks-after-drain", timing?.pendingTimestampReadbacks, 0],
  ] as const) {
    record(field, integerOrMissing(actual), limit, actual === limit);
  }
  for (const [field, actual, limit] of [
    ["gpu-timing-samples", timing?.samples, expected],
    ["gpu-timing-valid-samples", timing?.validSamples, expected],
    ["gpu-timing-fallback-samples", timing?.fallbackSamples, 0],
    ["gpu-timing-fused-resolves", timing?.fusedTimestampResolves, expected],
    ["gpu-timing-standalone-submissions", timing?.standaloneTimestampSubmissions, 0],
    ["gpu-timing-queries-per-frame", timing?.timestampQueriesPerFrame, 6],
    ["gpu-timing-segmented-samples", timing?.segmentedSamples, expected],
    ["gpu-timing-valid-segmented-samples", timing?.validSegmentedSamples, expected],
    ["gpu-timing-segmented-fallback-samples", timing?.segmentedFallbackSamples, 0],
    ["gpu-timing-valid-palette-samples", timing?.validPaletteSamples, expected],
    ["gpu-timing-valid-cull-samples", timing?.validCullSamples, expected],
    ["gpu-timing-valid-scene-render-samples", timing?.validSceneRenderSamples, expected],
    ["timestamp-readbacks", sample.counters.timestampReadbackSubmissions, expected],
    ["timestamp-fused-resolves", sample.counters.timestampFusedResolves, expected],
    ["timestamp-standalone-submissions", sample.counters.timestampStandaloneSubmissions, 0],
    ["timestamp-queries-per-frame", sample.counters.timestampQueriesPerFrame, 6],
    ["timestamp-segmented-samples", sample.counters.timestampSegmentedSamples, expected],
    ["timestamp-valid-segmented-samples", sample.counters.timestampValidSegmentedSamples, expected],
    ["timestamp-segmented-fallback-samples", sample.counters.timestampSegmentedFallbackSamples, 0],
    ["timestamp-valid-palette-samples", sample.counters.timestampValidPaletteSamples, expected],
    ["timestamp-valid-cull-samples", sample.counters.timestampValidCullSamples, expected],
    [
      "timestamp-valid-scene-render-samples",
      sample.counters.timestampValidSceneRenderSamples,
      expected,
    ],
  ] as const) {
    record(field, integerOrMissing(actual), limit, actual === limit);
  }
  record(
    "gpu-timing-segmented-writes",
    String(timing?.segmentedTimestampWrites ?? "missing"),
    "true",
    timing?.segmentedTimestampWrites === true,
  );
}

function recordExactCounter(
  sample: Readonly<BrowserBenchmarkSample>,
  name: string,
  field: keyof BrowserBenchmarkSample["counters"],
  expected: number,
  record: RecordCheck,
): void {
  const actual = sample.counters[field];
  record(name, integerOrMissing(actual), expected, actual === expected);
}

function recordFinite(name: string, value: unknown, integer: boolean, record: RecordCheck): void {
  const valid = integer ? isNonNegativeInteger(value) : isFiniteNumber(value) && value >= 0;
  record(name, valid ? (value as number) : "missing-or-invalid", "finite-nonnegative", valid);
}

function validSampleValue(value: unknown, nullable: boolean): boolean {
  if (nullable && value === null) return true;
  return isFiniteNumber(value) && value >= 0;
}

function safeP95(values: readonly (number | null)[] | undefined): number {
  if (
    values === undefined ||
    values.length === 0 ||
    values.some((value) => !isFiniteNumber(value) || value < 0)
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return summarize(values as readonly number[], "ms").p95;
}

function speedup(baseline: number, current: number): number {
  return current > 0 ? baseline / current : Number.POSITIVE_INFINITY;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function finiteOrMissing(value: unknown): number | string {
  return isFiniteNumber(value) ? value : "missing-or-invalid";
}

function integerOrMissing(value: unknown): number | string {
  return isNonNegativeInteger(value) ? value : "missing-or-invalid";
}

function numbersEqual(left: unknown, right: number): boolean {
  return isFiniteNumber(left) && Math.abs(left - right) <= 1e-9;
}
