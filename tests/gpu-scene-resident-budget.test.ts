import { describe, expect, test } from "bun:test";

import {
  GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES,
  GPU_SCENE_RESIDENT_SUBMITTED_GLYPHS,
  GPU_SCENE_RESIDENT_SUBMITTED_HASH,
  evaluateGpuSceneResidentBudget,
  evaluateGpuSceneResidentSustained600Budget,
} from "../benchmarks/gpu-scene-resident-budget";
import {
  BENCHMARK_SCHEMA_VERSION,
  type BrowserBenchmarkPhaseTimings,
  type BrowserBenchmarkSample,
} from "../benchmarks/schema";

describe("GPU-resident scene formal budget", () => {
  test("accepts the exact WebGPU 1M/100K two-phase sample", () => {
    const decision = evaluateGpuSceneResidentBudget([sample()]);

    expect(decision.passed).toBe(true);
    expect(decision.checks).toContainEqual({
      name: "prototype-count",
      actual: 1,
      limit: 1,
      passed: true,
    });
    expect(decision.checks).toContainEqual({
      name: "position-transform-upload-max-bytes",
      actual: GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES,
      limit: GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES,
      passed: true,
    });
  });

  test("accepts complete segmented telemetry for both 600-frame phases", () => {
    const decision = evaluateGpuSceneResidentSustained600Budget([sample(600)]);

    expect(decision.passed).toBe(true);
    expect(decision.checks).toContainEqual({
      name: "position-mutation-palette-gpu-timestamp-samples",
      actual: 600,
      limit: 600,
      passed: true,
    });
    expect(decision.checks).toContainEqual({
      name: "gpu-timing-valid-segmented-samples",
      actual: 1_220,
      limit: 1_220,
      passed: true,
    });
  });

  test("rejects a frame metric polluted by timestamp readback wall", () => {
    const broken = mutableSample();
    const camera = broken.timings.phases.camera;
    camera.frameMs[0] =
      camera.mutationMs[0]! +
      camera.cpuMs[0]! +
      camera.completionWallMs[0]! +
      camera.timestampReadbackWallMs![0]!;

    const decision = evaluateMutable(broken);

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual({
      name: "camera-frame-metric-composed-samples",
      actual: camera.frameMs.length - 1,
      limit: camera.frameMs.length,
      passed: false,
    });
  });

  test("rejects viewport fallback and incomplete GPU residency", () => {
    const broken = mutableSample();
    broken.counters.residencyActive = "viewport";
    broken.counters.residencyFallbackReason = "renderer-unsupported";
    broken.counters.gpuResidentLabels = 999_999;

    const decision = evaluateMutable(broken);

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual({
      name: "residency-active",
      actual: "viewport",
      limit: "gpu-scene",
      passed: false,
    });
    expect(decision.checks).toContainEqual({
      name: "gpu-resident-labels",
      actual: 999_999,
      limit: 1_000_000,
      passed: false,
    });
  });

  test("rejects phase work that reshapes, admits, queries, or uploads cull records", () => {
    const broken = mutableSample();
    broken.timings.phases.camera.shapedLabelsDelta = 1;
    broken.timings.phases.camera.admittedLabelsTotal = 1;
    broken.timings.phases.camera.cullingQueriesDelta = 1;
    broken.timings.phases.positionMutation.cullRecordUploadBytes![0] = 32;

    const decision = evaluateMutable(broken);

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual({
      name: "camera-culling-queries-delta",
      actual: 1,
      limit: 0,
      passed: false,
    });
    expect(decision.checks).toContainEqual({
      name: "position-cull-record-upload-max-bytes",
      actual: 32,
      limit: 0,
      passed: false,
    });
  });

  test("rejects performance and storage overages", () => {
    const broken = mutableSample();
    broken.timings.setupMs = 2_001;
    broken.counters.heapBytes = 512 * 1_024 ** 2 + 1;
    broken.timings.phases.camera.cpuMs[0] = 3;
    broken.timings.phases.positionMutation.mutationMs[0] = 9;
    broken.timings.phases.positionMutation.transformUploadBytes![0] =
      GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES + 16;

    expect(evaluateMutable(broken).passed).toBe(false);
  });

  test("rejects JSON null, negative, and fractional numeric telemetry", () => {
    const broken = mutableSample();
    const camera = broken.timings.phases.camera as unknown as {
      cpuMs: number[];
      gpuTimestampMs: number[];
      uploadBytes: number[];
      offscreenInspectedLabels: number[];
    };
    camera.cpuMs[0] = Number.NaN;
    camera.gpuTimestampMs[1] = -0.25;
    camera.uploadBytes[2] = 0.5;
    camera.offscreenInspectedLabels[3] = 0.5;
    broken.timings.setupMs = -1;
    broken.counters.heapBytes = -1;
    const jsonSample = JSON.parse(JSON.stringify(broken)) as MutableSample;

    const decision = evaluateMutable(jsonSample);

    expect(jsonSample.timings.phases.camera.cpuMs[0]).toBeNull();
    expect(decision.passed).toBe(false);
    expectFailedChecks(decision, [
      "setup-ms-domain",
      "heap-bytes-domain",
      "camera-cpu-values",
      "camera-gpu-timestamp-values",
      "camera-upload-bytes-values",
      "camera-offscreen-inspected-labels-values",
    ]);
  });

  test("rejects an inexact submitted set or empty pixel readback", () => {
    const broken = mutableSample();
    broken.counters.submittedLabels = GPU_SCENE_RESIDENT_SUBMITTED_GLYPHS - 1;
    broken.counters.submittedGlyphs = GPU_SCENE_RESIDENT_SUBMITTED_GLYPHS - 1;
    broken.counters.submittedGlyphsHash = GPU_SCENE_RESIDENT_SUBMITTED_HASH ^ 1;
    broken.counters.nonTransparentPixels = 0;

    const decision = evaluateMutable(broken);

    expect(decision.passed).toBe(false);
    expectFailedChecks(decision, ["submitted-count", "submitted-hash", "non-transparent-pixels"]);
  });

  test("rejects a wrong compacted selection with the correct submitted count", () => {
    const broken = mutableSample();
    broken.counters.submittedGlyphsHash = GPU_SCENE_RESIDENT_SUBMITTED_HASH ^ 1;

    const decision = evaluateMutable(broken);

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual({
      name: "submitted-count",
      actual: GPU_SCENE_RESIDENT_SUBMITTED_GLYPHS,
      limit: GPU_SCENE_RESIDENT_SUBMITTED_GLYPHS,
      passed: true,
    });
    expect(decision.checks).toContainEqual({
      name: "submitted-hash",
      actual: GPU_SCENE_RESIDENT_SUBMITTED_HASH ^ 1,
      limit: GPU_SCENE_RESIDENT_SUBMITTED_HASH,
      passed: false,
    });
  });

  test("rejects a repeatable pixel readback that differs from the canonical output", () => {
    const broken = mutableSample();
    broken.counters.renderedPixelHash = 0xa8ad_90b5;
    broken.counters.renderedPixelHashRepeat = 0xa8ad_90b5;
    broken.counters.nonTransparentPixels = 302_456;
    broken.counters.nonTransparentPixelsRepeat = 302_456;

    const decision = evaluateMutable(broken);

    expect(decision.passed).toBe(false);
    expectFailedChecks(decision, ["rendered-pixel-hash", "non-transparent-pixels"]);
  });

  test("rejects frame-tail spikes that p95 omits", () => {
    const broken = mutableSample();
    broken.timings.phases.camera.frameMs[0] = 50;

    const decision = evaluateMutable(broken);

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual({
      name: "camera-frame-over-budget-count",
      actual: 1,
      limit: 0,
      passed: false,
    });
    expect(decision.checks).toContainEqual({
      name: "camera-frame-max-ms",
      actual: 50,
      limit: 16.67,
      passed: false,
    });
  });

  test("requires the exact mover command plus uniform upload", () => {
    const broken = mutableSample();
    broken.timings.phases.positionMutation.transformUploadBytes!.fill(800_000);

    const decision = evaluateMutable(broken);

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual({
      name: "position-transform-upload-exact-samples",
      actual: 0,
      limit: 120,
      passed: false,
    });
  });

  test("rejects hidden timestamp submits and more than one product submit per frame", () => {
    const broken = mutableSample();
    const gpuTiming = broken.timings.gpuTiming as {
      fusedTimestampResolves: number;
      standaloneTimestampSubmissions: number;
    };
    gpuTiming.fusedTimestampResolves -= 1;
    gpuTiming.standaloneTimestampSubmissions = 1;
    broken.counters.timestampFusedResolves = gpuTiming.fusedTimestampResolves;
    broken.counters.timestampStandaloneSubmissions = 1;
    broken.timings.phases.camera.frameTransactionSubmissionDeltas![0] = 2;

    const decision = evaluateMutable(broken);

    expect(decision.passed).toBe(false);
    expectFailedChecks(decision, [
      "camera-product-submissions-exact",
      "gpu-timing-fused-resolves",
      "gpu-timing-standalone-submissions",
      "timestamp-fused-resolves",
      "timestamp-standalone-submissions",
    ]);
  });

  test("requires complete palette, cull, and scene-render timestamp telemetry", () => {
    const broken = mutableSample();
    const camera = broken.timings.phases.camera as MutablePhase & {
      paletteGpuTimestampMs: Array<number | null>;
    };
    camera.paletteGpuTimestampMs[0] = null;
    const gpuTiming = broken.timings.gpuTiming as Record<string, number | boolean | string>;
    gpuTiming.validSegmentedSamples = Number(gpuTiming.validSegmentedSamples) - 1;
    gpuTiming.validPaletteSamples = Number(gpuTiming.validPaletteSamples) - 1;
    broken.counters.timestampValidSegmentedSamples = gpuTiming.validSegmentedSamples;
    broken.counters.timestampValidPaletteSamples = gpuTiming.validPaletteSamples;

    const decision = evaluateMutable(broken);

    expect(decision.passed).toBe(false);
    expectFailedChecks(decision, [
      "camera-palette-gpu-timestamp-values",
      "gpu-timing-valid-segmented-samples",
      "gpu-timing-valid-palette-samples",
      "timestamp-valid-segmented-samples",
      "timestamp-valid-palette-samples",
    ]);
  });

  test("an exploratory scale cannot satisfy the formal sample contract", () => {
    const exploratory = sample(1);
    const decision = evaluateGpuSceneResidentBudget([exploratory]);

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual({
      name: "sample-frames",
      actual: 1,
      limit: 120,
      passed: false,
    });
  });

  test("fails stale telemetry without throwing", () => {
    const stale = mutableSample();
    stale.schemaVersion = 5;
    delete stale.timings.phases.camera.transformUploadBytes;
    delete stale.timings.phases.camera.cullRecordUploadBytes;
    delete stale.timings.phases.camera.deferredSpatialLabels;
    delete stale.timings.phases.camera.cullingQueriesDelta;

    const evaluate = () => evaluateMutable(stale);
    expect(evaluate).not.toThrow();
    expect(evaluate().passed).toBe(false);
  });
});

interface MutablePhase extends Omit<
  BrowserBenchmarkPhaseTimings,
  "cullRecordUploadBytes" | "deferredSpatialLabels" | "transformUploadBytes"
> {
  cullRecordUploadBytes?: number[];
  deferredSpatialLabels?: number[];
  transformUploadBytes?: number[];
  cullingQueriesDelta?: number;
  frameTransactionSubmissionDeltas?: number[];
  frameTransactionFusedSubmissionDeltas?: number[];
  frameTransactionStandaloneSubmissionDeltas?: number[];
  shapedLabelsDelta: number;
  admittedLabelsTotal: number;
  frameMs: number[];
  frameBudgetMs?: number;
  frameOverBudgetCount?: number;
  frameOverBudgetRatio?: number;
  frameP99Ms?: number;
  frameMaxMs?: number;
  cpuMs: number[];
  mutationMs: number[];
}

interface MutableSample extends Omit<
  BrowserBenchmarkSample,
  "counters" | "schemaVersion" | "timings"
> {
  schemaVersion: number;
  counters: Record<string, unknown> & {
    gpuResidentLabels?: number;
    heapBytes?: number;
    residencyActive?: string;
    residencyFallbackReason?: string;
  };
  timings: {
    setupMs: number;
    phases: {
      camera: MutablePhase;
      positionMutation: MutablePhase;
    };
  } & Record<string, unknown>;
}

function mutableSample(sampleFrames = 120): MutableSample {
  return structuredClone(sample(sampleFrames)) as unknown as MutableSample;
}

function evaluateMutable(sample: MutableSample) {
  return evaluateGpuSceneResidentBudget([sample as unknown as BrowserBenchmarkSample]);
}

function expectFailedChecks(
  decision: ReturnType<typeof evaluateGpuSceneResidentBudget>,
  names: readonly string[],
): void {
  expect(decision.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(
    expect.arrayContaining(names),
  );
}

function sample(sampleFrames = 120): Readonly<BrowserBenchmarkSample> {
  const camera = phase(sampleFrames, "camera");
  const positionMutation = phase(sampleFrames, "position");
  const timestampSamples = 2 * (10 + sampleFrames);
  return Object.freeze({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    kind: "pixi-glyphflow-browser-sample",
    capturedAt: "2026-08-29T00:00:00.000Z",
    userAgent: "benchmark-test",
    configuration: Object.freeze({
      fixture: "glyphflow",
      workload: "gpu-scene-resident",
      renderer: "webgpu",
      labelCount: 1_000_000,
      mutationCount: 100_000,
      warmupFrames: 10,
      sampleFrames,
      width: 1_280,
      height: 800,
    }),
    timings: Object.freeze({
      setupMs: 1_000,
      frameMs: Object.freeze([...camera.frameMs, ...positionMutation.frameMs]),
      cpuMs: Object.freeze([...camera.cpuMs, ...positionMutation.cpuMs]),
      gpuMs: Object.freeze([...camera.gpuMs, ...positionMutation.gpuMs]),
      gpuTimestampMs: Object.freeze([...camera.gpuTimestampMs, ...positionMutation.gpuTimestampMs]),
      paletteGpuTimestampMs: Object.freeze([
        ...(camera.paletteGpuTimestampMs ?? []),
        ...(positionMutation.paletteGpuTimestampMs ?? []),
      ]),
      cullGpuTimestampMs: Object.freeze([
        ...(camera.cullGpuTimestampMs ?? []),
        ...(positionMutation.cullGpuTimestampMs ?? []),
      ]),
      sceneRenderGpuTimestampMs: Object.freeze([
        ...(camera.sceneRenderGpuTimestampMs ?? []),
        ...(positionMutation.sceneRenderGpuTimestampMs ?? []),
      ]),
      completionWallMs: Object.freeze([
        ...camera.completionWallMs,
        ...positionMutation.completionWallMs,
      ]),
      instrumentationWallMs: Object.freeze([
        ...(camera.instrumentationWallMs ?? []),
        ...(positionMutation.instrumentationWallMs ?? []),
      ]),
      timestampReadbackWallMs: Object.freeze([
        ...(camera.timestampReadbackWallMs ?? []),
        ...(positionMutation.timestampReadbackWallMs ?? []),
      ]),
      uploadBytes: Object.freeze([...camera.uploadBytes, ...positionMutation.uploadBytes]),
      uploadMs: Object.freeze([...camera.uploadMs, ...positionMutation.uploadMs]),
      commitMs: Object.freeze([...camera.commitMs, ...positionMutation.commitMs]),
      cullingMs: Object.freeze([...camera.cullingMs, ...positionMutation.cullingMs]),
      mutationMs: positionMutation.mutationMs,
      phases: Object.freeze({ camera, positionMutation }),
      gpuTiming: Object.freeze({
        renderer: "webgpu",
        method: "timestamp-query",
        gpuTimeSource: "gpu-timestamp",
        quality: "valid",
        supported: true,
        timerQuery: false,
        timestampWrites: true,
        resolveQuerySet: true,
        readback: true,
        disjoint: false,
        samples: timestampSamples,
        validSamples: timestampSamples,
        fallbackSamples: 0,
        fusedTimestampResolves: timestampSamples,
        standaloneTimestampSubmissions: 0,
        timestampReadbackMode: "deferred-ring",
        timestampReadbackRingSize: 3,
        pendingTimestampReadbacks: 0,
        maxPendingTimestampReadbacks: 3,
        segmentedTimestampWrites: true,
        timestampQueriesPerFrame: 6,
        segmentedSamples: timestampSamples,
        validSegmentedSamples: timestampSamples,
        segmentedFallbackSamples: 0,
        validPaletteSamples: timestampSamples,
        validCullSamples: timestampSamples,
        validSceneRenderSamples: timestampSamples,
      }),
    }),
    counters: Object.freeze({
      residentLabels: 1_000_000,
      gpuResidentLabels: 1_000_000,
      prototypeCount: 1,
      submittedLabels: GPU_SCENE_RESIDENT_SUBMITTED_GLYPHS,
      visibleGlyphs: GPU_SCENE_RESIDENT_SUBMITTED_GLYPHS,
      submittedGlyphs: GPU_SCENE_RESIDENT_SUBMITTED_GLYPHS,
      submittedGlyphsHash: GPU_SCENE_RESIDENT_SUBMITTED_HASH,
      submittedGlyphsHashSource: "gpu-instances-out-readback",
      renderedPixelHash: 0xa8ad_90b4,
      renderedPixelHashRepeat: 0xa8ad_90b4,
      nonTransparentPixels: 302_457,
      nonTransparentPixelsRepeat: 302_457,
      submittedGlyphsSource: "gpu-indirect-readback",
      drawCalls: 1,
      drawCallsSource: "logical-mesh-count",
      observedDrawCalls: 0,
      observedDrawCallsSource: "unavailable-webgpu",
      heapBytes: 100 * 1_024 ** 2,
      rendererAdapter: "webgpu",
      cullPath: "compute-cull",
      palettePath: "storage",
      residencyRequested: "gpu-scene",
      residencyActive: "gpu-scene",
      deferredSpatialLabels: 100_000,
      cullRecordUploadBytes: 32_000_000,
      lastSceneSetupMs: 900,
      frameTransactionSubmissions: timestampSamples,
      frameTransactionFusedSubmissions: timestampSamples,
      frameTransactionStandaloneSubmissions: 0,
      diagnosticReadbackSubmissions: 2,
      timestampReadbackSubmissions: timestampSamples,
      timestampFusedResolves: timestampSamples,
      timestampStandaloneSubmissions: 0,
      timestampReadbackRingSize: 3,
      timestampMaxPendingReadbacks: 3,
      timestampPendingReadbacks: 0,
      timestampQueriesPerFrame: 6,
      timestampSegmentedSamples: timestampSamples,
      timestampValidSegmentedSamples: timestampSamples,
      timestampSegmentedFallbackSamples: 0,
      timestampValidPaletteSamples: timestampSamples,
      timestampValidCullSamples: timestampSamples,
      timestampValidSceneRenderSamples: timestampSamples,
    }),
    invariants: Object.freeze({
      submittedCountExact: true,
      submittedHashStable: true,
      submittedGlyphsReadback: true,
      pixelsRendered: true,
      pixelReadbackRepeatable: true,
      timestampFusedResolveExact: true,
      timestampStandaloneSubmissionZero: true,
      timestampSegmentedExact: true,
      timestampSegmentsValid: true,
    }),
  });
}

function phase(count: number, kind: "camera" | "position"): Readonly<BrowserBenchmarkPhaseTimings> {
  const numbers = (value: number): readonly number[] =>
    Object.freeze(Array.from({ length: count }, () => value));
  const booleans = (): readonly boolean[] =>
    Object.freeze(Array.from({ length: count }, () => false));
  const position = kind === "position";
  const cpu = position ? 6 : 1;
  const mutation = position ? 5 : 0;
  const completion = position ? 5 : 6;
  return Object.freeze({
    frameMs: numbers(mutation + cpu + completion),
    frameMetric: "mutation+timer-cpu+queue-completion",
    frameBudgetMs: 16.67,
    frameOverBudgetCount: 0,
    frameOverBudgetRatio: 0,
    frameP99Ms: mutation + cpu + completion,
    frameMaxMs: mutation + cpu + completion,
    cpuMs: numbers(cpu),
    gpuMs: numbers(5),
    gpuTimestampMs: numbers(5),
    paletteGpuTimestampMs: numbers(position ? 2 : 0),
    cullGpuTimestampMs: numbers(1),
    sceneRenderGpuTimestampMs: numbers(2),
    completionWallMs: numbers(completion),
    instrumentationWallMs: numbers(0.1),
    timestampReadbackWallMs: numbers(0.2),
    uploadBytes: numbers(position ? GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES : 0),
    transformUploadBytes: numbers(position ? GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES : 0),
    cullRecordUploadBytes: numbers(0),
    uploadMs: numbers(1),
    commitMs: numbers(position ? 3 : 0.5),
    cullingMs: numbers(0),
    mutationMs: numbers(mutation),
    visibilitySelectionMs: numbers(0),
    renderPreparationMs: numbers(0),
    renderCoordinatorMs: numbers(0),
    surfaceApplyMs: numbers(1),
    offscreenInspectedLabels: numbers(0),
    offscreenMaterializedLabels: numbers(0),
    offscreenAdmissionDeferred: booleans(),
    offscreenAdmissionGeneration: numbers(0),
    offscreenAdmissionCursor: numbers(0),
    offscreenAdmissionCursorResets: numbers(0),
    offscreenAdmissionCycles: numbers(0),
    deferredSpatialLabels: numbers(0),
    shapedLabelsDelta: 0,
    admittedLabelsTotal: 0,
    cullingQueriesDelta: 0,
    frameTransactionSubmissionDeltas: numbers(1),
    frameTransactionFusedSubmissionDeltas: numbers(1),
    frameTransactionStandaloneSubmissionDeltas: numbers(0),
  });
}
