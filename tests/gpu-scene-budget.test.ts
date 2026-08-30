import { describe, expect, test } from "bun:test";

import {
  classifyBenchmarkBudgetSummaryCheck,
  isBlockingBenchmarkBudgetFailure,
} from "../benchmarks/budgets";
import { evaluateGpuSceneV2Budget } from "../benchmarks/gpu-scene-budget";
import {
  BENCHMARK_SCHEMA_VERSION,
  type BrowserBenchmarkPhaseTimings,
  type BrowserBenchmarkSample,
} from "../benchmarks/schema";

describe("GPU Scene v2 formal budget", () => {
  test("accepts the exact 1M/100K two-phase renderer sample", () => {
    const decision = evaluateGpuSceneV2Budget([sample("webgpu", 120, 5)], "webgpu");

    expect(decision.passed).toBe(true);
    expect(decision.checks).toContainEqual({
      name: "sample-frames",
      actual: 120,
      limit: 120,
      passed: true,
    });
  });

  test("rejects an exploratory one-frame sample and a renderer mismatch", () => {
    const decision = evaluateGpuSceneV2Budget([sample("webgl", 1, 5)], "webgpu");

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual({
      name: "renderer",
      actual: "webgl",
      limit: "webgpu",
      passed: false,
    });
    expect(decision.checks).toContainEqual({
      name: "sample-frames",
      actual: 1,
      limit: 120,
      passed: false,
    });
  });

  test("rejects WebGPU completion-wall fallback as invalid GPU timing", () => {
    const decision = evaluateGpuSceneV2Budget([sample("webgpu", 120, 5, false)], "webgpu");

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual({
      name: "gpu-timing-quality",
      actual: "fallback",
      limit: "valid",
      passed: false,
    });
  });

  test("returns a failed decision for empty phase arrays", () => {
    const broken = sample("webgl", 0, 5);

    expect(() => evaluateGpuSceneV2Budget([broken], "webgl")).not.toThrow();
    expect(evaluateGpuSceneV2Budget([broken], "webgl").passed).toBe(false);
  });

  test("rejects an offscreen admission scan above the per-commit label budget", () => {
    const decision = evaluateGpuSceneV2Budget([sample("webgpu", 120, 5, true, 4_096)], "webgpu");

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual({
      name: "position-mutation-offscreen-inspected-max",
      actual: 4_096,
      limit: 2_048,
      passed: false,
    });
  });

  test("fails a stale artifact with missing admission telemetry without throwing", () => {
    const stale = structuredClone(sample("webgpu", 120, 5)) as unknown as {
      schemaVersion: number;
      timings: {
        phases: {
          camera: Record<string, unknown>;
          positionMutation: Record<string, unknown>;
        };
      };
    };
    stale.schemaVersion = 5;
    for (const phase of [stale.timings.phases.camera, stale.timings.phases.positionMutation]) {
      delete phase.offscreenInspectedLabels;
      delete phase.offscreenMaterializedLabels;
      delete phase.shapedLabelsDelta;
      delete phase.admittedLabelsTotal;
    }

    const evaluate = () =>
      evaluateGpuSceneV2Budget([stale as unknown as Readonly<BrowserBenchmarkSample>], "webgpu");
    expect(evaluate).not.toThrow();
    expect(evaluate().passed).toBe(false);
    expect(evaluate().checks).toContainEqual({
      name: "schema-version",
      actual: 5,
      limit: BENCHMARK_SCHEMA_VERSION,
      passed: false,
    });
  });

  test("marks exactly four GPU Scene v2 frame p95 controls as non-blocking fixed red", () => {
    const fixedRedControlNames = [
      "gpu-scene-v2:webgl/camera-frame-p95-ms",
      "gpu-scene-v2:webgl/position-mutation-frame-p95-ms",
      "gpu-scene-v2:webgpu/camera-frame-p95-ms",
      "gpu-scene-v2:webgpu/position-mutation-frame-p95-ms",
    ];
    const fixedRedControls = (["webgl", "webgpu"] as const).flatMap((renderer) => {
      const decision = evaluateGpuSceneV2Budget([sample(renderer, 120, 20)], renderer);
      expect(decision.passed).toBe(false);
      return decision.checks
        .filter((check) => check.name.endsWith("-frame-p95-ms"))
        .map((check) =>
          classifyBenchmarkBudgetSummaryCheck({
            ...check,
            name: `gpu-scene-v2:${renderer}/${check.name}`,
          }),
        );
    });
    const classified = [
      ...fixedRedControls,
      "gpu-scene-v2:webgl/camera-frame-samples",
      "gpu-scene-v2:webgpu/camera-gpu-timestamp-values",
      "gpu-scene-resident:webgpu/camera-frame-p95-ms",
      "label-collision:webgl/frame-p95-ms",
    ].map((check) =>
      typeof check === "string"
        ? classifyBenchmarkBudgetSummaryCheck({
            name: check,
            actual: 131.3,
            limit: 16.67,
            passed: false,
          })
        : check,
    );

    expect(classified.filter((check) => !check.blocking).map((check) => check.name)).toEqual(
      fixedRedControlNames,
    );
    expect(classified.filter((check) => !check.blocking)).toEqual(
      fixedRedControlNames.map((name) => ({
        name,
        actual: 20,
        limit: 16.67,
        passed: false,
        blocking: false,
        classification: "fixed-red-control",
      })),
    );
    expect(classified.filter((check) => isBlockingBenchmarkBudgetFailure(check))).toHaveLength(4);
  });

  test("keeps GPU Scene v2 correctness and other workload failures blocking", () => {
    const blockingFailureNames = [
      "formal:gpu-scene-v2:webgpu",
      "schema:gpu-scene-v2:webgpu",
      "samples:gpu-scene-v2:webgpu",
      "invariant:gpu-scene-v2:webgpu/submittedGlyphsReadback",
      "gpu-scene-v2:webgpu/submitted-labels",
      "gpu-scene-v2:webgpu/gpu-timing-quality",
      "gpu-scene-resident:webgpu/camera-frame-p95-ms",
      "samples:gpu-scene-heterogeneous-64:webgpu",
    ];

    for (const name of blockingFailureNames) {
      const check = classifyBenchmarkBudgetSummaryCheck({
        name,
        actual: "invalid",
        limit: "valid",
        passed: false,
      });
      expect(check).toMatchObject({
        name,
        passed: false,
        blocking: true,
        classification: "budget-gate",
      });
      expect(isBlockingBenchmarkBudgetFailure(check)).toBe(true);
    }
  });
});

function sample(
  renderer: "webgl" | "webgpu",
  sampleFrames: number,
  frameMs: number,
  validGpuTiming = true,
  offscreenMax = 5,
): Readonly<BrowserBenchmarkSample> {
  const phase = phaseTimings(sampleFrames, frameMs, offscreenMax);
  return Object.freeze({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    kind: "pixi-glyphflow-browser-sample",
    capturedAt: "2026-08-29T00:00:00.000Z",
    userAgent: "benchmark-test",
    configuration: Object.freeze({
      fixture: "glyphflow",
      workload: "gpu-scene-v2",
      renderer,
      labelCount: 1_000_000,
      mutationCount: 100_000,
      warmupFrames: 10,
      sampleFrames,
      width: 1_280,
      height: 800,
    }),
    timings: Object.freeze({
      setupMs: 1,
      frameMs: Object.freeze([...phase.frameMs, ...phase.frameMs]),
      cpuMs: Object.freeze([...phase.cpuMs, ...phase.cpuMs]),
      gpuMs: Object.freeze([...phase.gpuMs, ...phase.gpuMs]),
      gpuTimestampMs: Object.freeze([...phase.gpuTimestampMs, ...phase.gpuTimestampMs]),
      completionWallMs: Object.freeze([...phase.completionWallMs, ...phase.completionWallMs]),
      uploadBytes: Object.freeze([...phase.uploadBytes, ...phase.uploadBytes]),
      uploadMs: Object.freeze([...phase.uploadMs, ...phase.uploadMs]),
      commitMs: Object.freeze([...phase.commitMs, ...phase.commitMs]),
      cullingMs: Object.freeze([...phase.cullingMs, ...phase.cullingMs]),
      mutationMs: phase.mutationMs,
      phases: Object.freeze({ camera: phase, positionMutation: phase }),
      gpuTiming: Object.freeze({
        renderer,
        method: renderer === "webgpu" ? "timestamp-query" : "ext-disjoint-timer-query-webgl2",
        supported: true,
        timerQuery: renderer === "webgl",
        timestampWrites: renderer === "webgpu",
        resolveQuerySet: renderer === "webgpu",
        readback: true,
        disjoint: false,
        samples: 2 * (10 + sampleFrames),
        validSamples: validGpuTiming ? 2 * (10 + sampleFrames) : 0,
        fallbackSamples: validGpuTiming ? 0 : 2 * (10 + sampleFrames),
        fusedTimestampResolves:
          renderer === "webgpu" && validGpuTiming ? 2 * (10 + sampleFrames) : 0,
        standaloneTimestampSubmissions: 0,
        gpuTimeSource: validGpuTiming ? "gpu-timestamp" : "completion-wall",
        quality: validGpuTiming ? "valid" : "fallback",
      }),
    }),
    counters: Object.freeze({
      residentLabels: 1_000_000,
      submittedLabels: 100_000,
      visibleGlyphs: 100_000,
      submittedGlyphs: 100_000,
      activeGlyphInstances: 200_000,
      submittedGlyphsSource: renderer === "webgpu" ? "gpu-indirect-readback" : "cpu-submit",
      drawCalls: 1,
      offscreenInspectedLabels: offscreenMax,
      offscreenMaterializedLabels: 5,
      offscreenAdmittedLabels: sampleFrames * 10,
      offscreenMaxInspectedLabels: offscreenMax,
      offscreenMaxMaterializedLabels: 5,
      offscreenAdmissionDeferred: false,
      offscreenAdmissionGeneration: 1,
      offscreenAdmissionCursor: 0,
      offscreenAdmissionCursorResets: 0,
      offscreenAdmissionCycles: 1,
      rendererAdapter: renderer,
      cullPath: renderer === "webgpu" ? "compute-cull" : "cpu-grid",
      palettePath: renderer === "webgpu" ? "storage" : "texture",
    }),
    invariants: Object.freeze({
      viewportFrameEvents: 2 * (10 + sampleFrames),
      viewportCommits: 2 * (10 + sampleFrames),
    }),
  });
}

function phaseTimings(
  count: number,
  frameMs: number,
  offscreenMax: number,
): Readonly<BrowserBenchmarkPhaseTimings> {
  const samples = (): readonly number[] =>
    Object.freeze(Array.from({ length: count }, () => frameMs));
  const booleans = (): readonly boolean[] =>
    Object.freeze(Array.from({ length: count }, () => false));
  return Object.freeze({
    frameMs: samples(),
    cpuMs: samples(),
    gpuMs: samples(),
    gpuTimestampMs: samples(),
    completionWallMs: samples(),
    uploadBytes: samples(),
    uploadMs: samples(),
    commitMs: samples(),
    cullingMs: samples(),
    mutationMs: samples(),
    visibilitySelectionMs: samples(),
    renderPreparationMs: samples(),
    renderCoordinatorMs: samples(),
    surfaceApplyMs: samples(),
    offscreenInspectedLabels: Object.freeze(Array.from({ length: count }, () => offscreenMax)),
    offscreenMaterializedLabels: samples(),
    offscreenAdmissionDeferred: booleans(),
    offscreenAdmissionGeneration: samples(),
    offscreenAdmissionCursor: samples(),
    offscreenAdmissionCursorResets: samples(),
    offscreenAdmissionCycles: samples(),
    shapedLabelsDelta: count,
    admittedLabelsTotal: count * frameMs,
  });
}
