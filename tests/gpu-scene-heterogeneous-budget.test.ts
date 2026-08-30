import { describe, expect, test } from "bun:test";

import {
  evaluateGpuSceneHeterogeneousArtifactSummary,
  isBlockingBenchmarkBudgetFailure,
} from "../benchmarks/budgets";
import {
  GPU_SCENE_HETEROGENEOUS_CAMERA_BASELINE_P95_MS,
  GPU_SCENE_HETEROGENEOUS_DELIVERY_FRAME_BUDGET_MS,
  GPU_SCENE_HETEROGENEOUS_POSITION_BASELINE_P95_MS,
  GPU_SCENE_HETEROGENEOUS_POSITION_UPLOAD_BYTES,
  evaluateGpuSceneHeterogeneousBudget,
} from "../benchmarks/gpu-scene-heterogeneous-budget";
import {
  BENCHMARK_SCHEMA_VERSION,
  type BrowserBenchmarkPhaseTimings,
  type BrowserBenchmarkSample,
} from "../benchmarks/schema";

describe("R1a heterogeneous GPU-scene delivery gate", () => {
  test("accepts two exact repetitions and reports the 16.67 ms promotion target separately", () => {
    const decision = evaluateGpuSceneHeterogeneousBudget([sample(1), sample(2)]);

    expect(decision.checks.filter((check) => !check.passed)).toEqual([]);
    expect(decision.passed).toBe(true);
    expect(decision.delivery.passed).toBe(true);
    expect(decision.promotion).toEqual({
      status: "PAUSE",
      frameBudgetMs: 16.67,
      cameraPassed: false,
      positionPassed: false,
    });
    expect(decision.checks).toEqual(
      expect.arrayContaining([
        {
          name: "camera-frame-p95-ms",
          actual: 20,
          limit: GPU_SCENE_HETEROGENEOUS_DELIVERY_FRAME_BUDGET_MS,
          passed: true,
        },
        {
          name: "camera-speedup-vs-gpu-scene-v2",
          actual: GPU_SCENE_HETEROGENEOUS_CAMERA_BASELINE_P95_MS / 20,
          limit: 4,
          passed: true,
        },
        {
          name: "position-speedup-vs-gpu-scene-v2",
          actual: GPU_SCENE_HETEROGENEOUS_POSITION_BASELINE_P95_MS / 25,
          limit: 4,
          passed: true,
        },
        {
          name: "position-transform-upload-exact-samples",
          actual: 120,
          limit: 120,
          passed: true,
        },
      ]),
    );
  });

  test("fails missing and stale repetition schema without throwing", () => {
    const missing = evaluateGpuSceneHeterogeneousBudget([sample(1)]);
    const stale = mutableSample(2);
    stale.schemaVersion = BENCHMARK_SCHEMA_VERSION - 1;

    expect(missing.passed).toBe(false);
    expect(missing.checks).toContainEqual({
      name: "repetitions",
      actual: 1,
      limit: 2,
      passed: false,
    });
    expect(() => evaluateMutable([mutableSample(1), stale])).not.toThrow();
    expect(evaluateMutable([mutableSample(1), stale]).passed).toBe(false);
  });

  test("fails inexact scene identity, output identity, upload, and segmented telemetry", () => {
    const first = mutableSample(1);
    const second = mutableSample(2);
    second.counters.prototypeCount = 63;
    second.counters.paintCount = 7;
    second.counters.gpuScenePerLabelObjectCount = 1;
    second.counters.deferredSpatialLabels = 99_999;
    second.counters.cullRecordUploadBytes = 31_999_968;
    second.counters.frameTransactionSubmissions = 259;
    second.counters.frameTransactionFusedSubmissions = 259;
    second.counters.frameTransactionStandaloneSubmissions = 1;
    second.counters.diagnosticReadbackSubmissions = 1;
    second.counters.timestampReadbackRingSize = 2;
    second.counters.timestampMaxPendingReadbacks = 2;
    second.counters.timestampPendingReadbacks = 1;
    second.counters.submittedGlyphsHash = 0x1234_5679;
    second.timings.phases.positionMutation.transformUploadBytes![0] =
      GPU_SCENE_HETEROGENEOUS_POSITION_UPLOAD_BYTES - 12;
    second.timings.phases.camera.paletteGpuTimestampMs![0] = null;
    second.timings.phases.camera.frameBudgetMs = 33.34;
    second.invariants.prototypePaintInterleaveExact = false;
    second.invariants.timestampSegmentedExact = false;

    const decision = evaluateMutable([first, second]);

    expect(decision.passed).toBe(false);
    expect(decision.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "prototype-count",
        "paint-count",
        "per-label-object-count",
        "deferred-spatial-labels",
        "initial-cull-record-upload-bytes",
        "product-frame-submissions",
        "product-frame-fused-submissions",
        "product-frame-standalone-submissions",
        "diagnostic-readback-submissions",
        "timestamp-readback-ring-size",
        "timestamp-max-pending-readbacks",
        "timestamp-pending-readbacks-after-drain",
        "prototype-paint-interleave-exact-invariant",
        "timestamp-segmented-exact-invariant",
        "camera-frame-budget-ms-recorded",
        "repetition-submitted-hash-exact",
        "position-transform-upload-exact-samples",
        "camera-palette-gpu-timestamp-values",
      ]),
    );
  });

  test("fails missing independent output identity fields", () => {
    const first = mutableSample(1);
    const second = mutableSample(2);
    delete second.counters.expectedSubmittedGlyphs;
    delete second.counters.expectedSubmittedGlyphsHash;
    delete second.counters.expectedSubmittedGlyphsSource;
    delete second.counters.cameraSubmittedGlyphs;
    delete second.counters.cameraSubmittedGlyphsHash;
    delete second.counters.expectedCameraSubmittedGlyphs;
    delete second.counters.expectedCameraSubmittedGlyphsHash;

    const decision = evaluateMutable([first, second]);

    expect(decision.passed).toBe(false);
    expect(decision.checks.filter((check) => !check.passed).map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "expected-submitted-source",
        "camera-submitted-count",
        "camera-submitted-hash",
        "submitted-count",
        "submitted-labels",
        "submitted-hash",
      ]),
    );
  });

  test("fails delivery budgets while retaining the fixed v2 baseline", () => {
    const first = mutableSample(1);
    const second = mutableSample(2);
    second.timings.setupMs = 2_001;
    second.timings.phases.camera.frameMs.fill(50);
    second.timings.phases.camera.cpuMs.fill(4.01);
    second.timings.phases.camera.commitMs.fill(2.01);
    second.timings.phases.positionMutation.cpuMs.fill(8.01);
    second.timings.phases.positionMutation.commitMs.fill(4.01);
    second.timings.phases.positionMutation.surfaceApplyMs.fill(2.01);
    second.timings.phases.positionMutation.gpuTimestampMs.fill(30.01);

    const decision = evaluateMutable([first, second]);

    expect(decision.passed).toBe(false);
    expect(decision.baseline).toEqual({
      workload: "gpu-scene-v2",
      cameraFrameP95Ms: 199.5,
      positionFrameP95Ms: 199.9,
      minimumSpeedup: 4,
    });
  });

  test("recomputes every heterogeneous evaluator check and blocks embedded mismatch", () => {
    const samples = [sample(1), sample(2)];
    const decision = evaluateGpuSceneHeterogeneousBudget(samples);
    const matching = evaluateGpuSceneHeterogeneousArtifactSummary(samples, decision);

    expect(matching).toHaveLength(decision.checks.length + 1);
    expect(matching.slice(0, decision.checks.length)).toEqual(
      decision.checks.map((check) => ({
        ...check,
        name: `gpu-scene-heterogeneous:webgpu/${check.name}`,
        blocking: true,
        classification: "budget-gate",
      })),
    );
    expect(matching).toContainEqual({
      name: "gpu-scene-heterogeneous:webgpu/repetitions",
      actual: 2,
      limit: 2,
      passed: true,
      blocking: true,
      classification: "budget-gate",
    });

    const mismatched = evaluateGpuSceneHeterogeneousArtifactSummary(samples, {
      ...decision,
      passed: false,
    });
    const embeddedMismatch = mismatched.at(-1)!;
    expect(embeddedMismatch).toEqual({
      name: "embedded-budget:gpu-scene-heterogeneous-64:webgpu",
      actual: "false",
      limit: "true",
      passed: false,
      blocking: true,
      classification: "budget-gate",
    });
    expect(isBlockingBenchmarkBudgetFailure(embeddedMismatch)).toBe(true);
  });
});

interface MutableSample extends Omit<
  BrowserBenchmarkSample,
  "counters" | "invariants" | "schemaVersion" | "timings"
> {
  schemaVersion: number;
  counters: Record<string, unknown> & {
    gpuScenePerLabelObjectCount?: number;
    paintCount?: number;
    prototypeCount?: number;
    submittedGlyphsHash?: number;
  };
  timings: {
    setupMs: number;
    phases: {
      camera: MutablePhase;
      positionMutation: MutablePhase;
    };
  } & Record<string, unknown>;
  invariants: Record<string, boolean | number | string>;
}

interface MutablePhase extends Omit<BrowserBenchmarkPhaseTimings, "frameBudgetMs" | "frameMs"> {
  frameBudgetMs?: number;
  frameMs: number[];
  cpuMs: number[];
  gpuTimestampMs: Array<number | null>;
  paletteGpuTimestampMs?: Array<number | null>;
  commitMs: number[];
  surfaceApplyMs: number[];
  transformUploadBytes?: number[];
}

function mutableSample(repeatIndex: 1 | 2): MutableSample {
  return structuredClone(sample(repeatIndex)) as unknown as MutableSample;
}

function evaluateMutable(samples: readonly MutableSample[]) {
  return evaluateGpuSceneHeterogeneousBudget(
    samples as unknown as readonly Readonly<BrowserBenchmarkSample>[],
  );
}

function sample(repeatIndex: 1 | 2): Readonly<BrowserBenchmarkSample> {
  const camera = phase("camera");
  const positionMutation = phase("position");
  const timestampSamples = 260;
  return Object.freeze({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    kind: "pixi-glyphflow-browser-sample",
    repeatIndex,
    capturedAt: `2026-08-30T00:00:0${String(repeatIndex)}.000Z`,
    userAgent: "benchmark-test",
    configuration: Object.freeze({
      fixture: "glyphflow",
      workload: "gpu-scene-heterogeneous-64",
      renderer: "webgpu",
      labelCount: 1_000_000,
      mutationCount: 100_000,
      warmupFrames: 10,
      sampleFrames: 120,
      width: 1_280,
      height: 800,
    }),
    timings: Object.freeze({
      setupMs: 1_200,
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
      prototypeCount: 64,
      paintCount: 8,
      prototypePaintPairCount: 512,
      gpuScenePerLabelObjectCount: 0,
      collisionEnabled: false,
      submittedLabels: 259_605,
      visibleGlyphs: 259_605,
      submittedGlyphs: 259_605,
      submittedGlyphsHash: 0x79af_6755,
      submittedGlyphsHashSource: "gpu-instances-out-readback",
      cameraSubmittedGlyphs: 259_605,
      cameraSubmittedGlyphsHash: 0x1357_9bdf,
      expectedCameraSubmittedGlyphs: 259_605,
      expectedCameraSubmittedGlyphsHash: 0x1357_9bdf,
      expectedSubmittedGlyphs: 259_605,
      expectedSubmittedGlyphsHash: 0x79af_6755,
      expectedSubmittedGlyphsSource: "cpu-prototype-bounds",
      renderedPixelHash: 0x1234_5678,
      renderedPixelHashRepeat: 0x1234_5678,
      nonTransparentPixels: 300_000,
      nonTransparentPixelsRepeat: 300_000,
      submittedGlyphsSource: "gpu-indirect-readback",
      drawCalls: 64,
      drawCallsSource: "logical-mesh-count",
      observedDrawCalls: 0,
      observedDrawCallsSource: "unavailable-webgpu",
      heapBytes: 256 * 1_024 ** 2,
      rendererAdapter: "webgpu",
      cullPath: "compute-cull",
      palettePath: "storage",
      residencyRequested: "gpu-scene",
      residencyActive: "gpu-scene",
      deferredSpatialLabels: 100_000,
      cullRecordUploadBytes: 32_000_000,
      lastSceneSetupMs: 1_000,
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
      expectedSubmittedIdentity: true,
      pixelReadbackRepeatable: true,
      prototypePaintInterleaveExact: true,
      timestampSegmentedExact: true,
      timestampSegmentsValid: true,
    }),
  } as unknown as BrowserBenchmarkSample);
}

function phase(kind: "camera" | "position"): Readonly<BrowserBenchmarkPhaseTimings> {
  const numbers = (value: number): readonly number[] =>
    Object.freeze(Array.from({ length: 120 }, () => value));
  const booleans = (): readonly boolean[] =>
    Object.freeze(Array.from({ length: 120 }, () => false));
  const position = kind === "position";
  const mutation = position ? 6 : 0;
  const cpu = position ? 7 : 3;
  const frame = position ? 25 : 20;
  const completion = frame - mutation - cpu;
  return Object.freeze({
    frameMs: numbers(frame),
    frameMetric: "mutation+timer-cpu+queue-completion",
    frameBudgetMs: 16.67,
    frameOverBudgetCount: 120,
    frameOverBudgetRatio: 1,
    frameP99Ms: frame,
    frameMaxMs: frame,
    cpuMs: numbers(cpu),
    gpuMs: numbers(20),
    gpuTimestampMs: numbers(20),
    paletteGpuTimestampMs: numbers(position ? 4 : 0),
    cullGpuTimestampMs: numbers(3),
    sceneRenderGpuTimestampMs: numbers(13),
    completionWallMs: numbers(completion),
    instrumentationWallMs: numbers(0.1),
    timestampReadbackWallMs: numbers(0.2),
    uploadBytes: numbers(position ? GPU_SCENE_HETEROGENEOUS_POSITION_UPLOAD_BYTES : 0),
    transformUploadBytes: numbers(position ? GPU_SCENE_HETEROGENEOUS_POSITION_UPLOAD_BYTES : 0),
    cullRecordUploadBytes: numbers(0),
    uploadMs: numbers(1),
    commitMs: numbers(position ? 3 : 1),
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
