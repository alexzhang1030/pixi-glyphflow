import { describe, expect, test } from "bun:test";

import { evaluateLabelCollisionBudget } from "../benchmarks/label-collision-budget";
import { BENCHMARK_SCHEMA_VERSION, type BrowserBenchmarkSample } from "../benchmarks/schema";

describe("label collision formal budget", () => {
  test("accepts an exact 1M-label 120-frame high-overlap sample", () => {
    const decision = evaluateLabelCollisionBudget([sample()], "webgl");

    expect(decision.passed).toBe(true);
    expect(decision.checks).toContainEqual({
      name: "selection-hash",
      actual: 0x1234_5678,
      limit: "> 0",
      passed: true,
    });
    expect(decision.checks).toContainEqual({
      name: "visibility-selection-samples",
      actual: 120,
      limit: 120,
      passed: true,
    });
  });

  test("fails the formal decision when CPU or collision p95 exceeds one frame", () => {
    const slow = sample({ cpuMs: 17, collisionMs: 18 });
    const decision = evaluateLabelCollisionBudget([slow], "webgl");

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual({
      name: "cpu-p95-ms",
      actual: 17,
      limit: 16.67,
      passed: false,
    });
    expect(decision.checks).toContainEqual({
      name: "collision-p95-ms",
      actual: 18,
      limit: 16.67,
      passed: false,
    });
  });

  test("fails the formal decision when whole-frame p95 exceeds one frame", () => {
    const decision = evaluateLabelCollisionBudget(
      [sample({ frameMs: 18, renderer: "webgpu" })],
      "webgpu",
    );

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual({
      name: "frame-p95-ms",
      actual: 18,
      limit: 16.67,
      passed: false,
    });
  });

  test("fails empty selections and inconsistent collision accounting", () => {
    const decision = evaluateLabelCollisionBudget(
      [sample({ selectionHash: 0, collisionCulledLabels: 558_000 })],
      "webgpu",
    );

    expect(decision.passed).toBe(false);
    expect(decision.checks).toContainEqual({
      name: "selection-hash",
      actual: 0,
      limit: "> 0",
      passed: false,
    });
    expect(decision.checks).toContainEqual({
      name: "candidate-accounting",
      actual: 559_024,
      limit: 559_104,
      passed: false,
    });
  });
});

function sample(
  overrides: Readonly<{
    frameMs?: number;
    cpuMs?: number;
    collisionMs?: number;
    selectionHash?: number;
    collisionCulledLabels?: number;
    renderer?: "webgl" | "webgpu";
  }> = {},
): Readonly<BrowserBenchmarkSample> {
  const sampleCount = 120;
  const samples = (value: number): readonly number[] =>
    Object.freeze(Array.from({ length: sampleCount }, () => value));
  const submittedLabels = 512;
  const renderer = overrides.renderer ?? "webgl";
  const candidateLabels = 559_104;
  const collisionCulledLabels = overrides.collisionCulledLabels ?? 558_080;
  const densityCulledLabels = 512;
  return Object.freeze({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    kind: "pixi-glyphflow-browser-sample",
    capturedAt: "2026-08-29T00:00:00.000Z",
    userAgent: "benchmark-test",
    configuration: Object.freeze({
      fixture: "glyphflow",
      workload: "label-collision",
      renderer,
      labelCount: 1_000_000,
      mutationCount: 1,
      warmupFrames: 5,
      sampleFrames: sampleCount,
      width: 1_280,
      height: 800,
    }),
    timings: Object.freeze({
      setupMs: 1,
      frameMs: samples(overrides.frameMs ?? 10),
      cpuMs: samples(overrides.cpuMs ?? 10),
      gpuMs: samples(5),
      uploadBytes: samples(0),
      uploadMs: samples(1),
      commitMs: samples(9),
      cullingMs: samples(overrides.collisionMs ?? 5),
      visibilitySelectionMs: samples(8),
      renderPreparationMs: samples(1),
      renderCoordinatorMs: samples(0.5),
      surfaceApplyMs: samples(0.5),
      gpuTiming: Object.freeze({
        renderer,
        method: renderer === "webgpu" ? "timestamp-query" : "ext-disjoint-timer-query-webgl2",
        gpuTimeSource: "gpu-timestamp",
        quality: "valid",
        supported: true,
        timerQuery: renderer === "webgl",
        timestampWrites: renderer === "webgpu",
        resolveQuerySet: renderer === "webgpu",
        readback: true,
        disjoint: false,
        samples: 125,
        validSamples: 125,
        fallbackSamples: 0,
        fusedTimestampResolves: 0,
        standaloneTimestampSubmissions: 0,
      }),
    }),
    counters: Object.freeze({
      residentLabels: 1_000_000,
      submittedLabels,
      visibleGlyphs: submittedLabels * 8,
      submittedGlyphs: submittedLabels * 8,
      drawCalls: 1,
      rendererAdapter: renderer,
      cullPath: "cpu-grid",
      palettePath: renderer === "webgpu" ? "storage" : "texture",
      collisionCandidateLabels: candidateLabels,
      collisionCulledLabels,
      densityCulledLabels,
      collisionSelectionHash: overrides.selectionHash ?? 0x1234_5678,
      submittedReduction: 1_000_000 - submittedLabels,
      submittedReductionRatio: (1_000_000 - submittedLabels) / 1_000_000,
      collisionCandidateReductionRatio: (candidateLabels - submittedLabels) / candidateLabels,
      lastCollisionMs: overrides.collisionMs ?? 5,
      collisionRecordBytes: 8_000_000,
    }),
    invariants: Object.freeze({}),
  });
}
