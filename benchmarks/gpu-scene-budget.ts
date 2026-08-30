import {
  BENCHMARK_SCHEMA_VERSION,
  GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET,
  summarize,
  type BrowserBenchmarkBudgetCheck,
  type BrowserBenchmarkBudgetDecision,
  type BrowserBenchmarkRenderer,
  type BrowserBenchmarkSample,
} from "./schema";
import { getBenchmarkWorkload } from "./workloads";

export const GPU_SCENE_V2_FRAME_BUDGET_MS = 16.67;

export function evaluateGpuSceneV2Budget(
  samples: readonly Readonly<BrowserBenchmarkSample>[],
  renderer: BrowserBenchmarkRenderer,
): Readonly<BrowserBenchmarkBudgetDecision> {
  const expected = getBenchmarkWorkload("gpu-scene-v2");
  const checks: BrowserBenchmarkBudgetCheck[] = [];
  const record = (
    name: string,
    actual: number | string,
    limit: number | string,
    passed: boolean,
  ): void => {
    checks.push(Object.freeze({ name, actual, limit, passed }));
  };
  record("samples", samples.length, 1, samples.length === 1);

  for (const sample of samples) {
    const configuration = sample.configuration;
    const phases = sample.timings.phases;
    record(
      "schema-version",
      sample.schemaVersion,
      BENCHMARK_SCHEMA_VERSION,
      sample.schemaVersion === BENCHMARK_SCHEMA_VERSION,
    );
    record("renderer", configuration.renderer, renderer, configuration.renderer === renderer);
    record(
      "resident-labels",
      sample.counters.residentLabels,
      expected.labelCount,
      sample.counters.residentLabels === expected.labelCount,
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
      expected.sampleFrames,
      configuration.sampleFrames === expected.sampleFrames,
    );
    record(
      "submitted-glyphs",
      sample.counters.submittedGlyphs ?? 0,
      "> 0",
      (sample.counters.submittedGlyphs ?? 0) > 0,
    );
    record(
      "submitted-labels",
      sample.counters.submittedLabels,
      sample.counters.submittedGlyphs ?? 0,
      sample.counters.submittedLabels === sample.counters.submittedGlyphs,
    );
    const submittedGlyphsSource = renderer === "webgpu" ? "gpu-indirect-readback" : "cpu-submit";
    record(
      "submitted-glyphs-source",
      sample.counters.submittedGlyphsSource ?? "missing",
      submittedGlyphsSource,
      sample.counters.submittedGlyphsSource === submittedGlyphsSource,
    );
    record(
      "offscreen-inspected-max",
      sample.counters.offscreenMaxInspectedLabels ?? Number.POSITIVE_INFINITY,
      GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET,
      (sample.counters.offscreenMaxInspectedLabels ?? Number.POSITIVE_INFINITY) <=
        GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET,
    );
    record(
      "offscreen-materialized-max",
      sample.counters.offscreenMaxMaterializedLabels ?? Number.POSITIVE_INFINITY,
      GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET,
      (sample.counters.offscreenMaxMaterializedLabels ?? Number.POSITIVE_INFINITY) <=
        GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET,
    );
    record("draw-calls", sample.counters.drawCalls, "> 0", sample.counters.drawCalls > 0);
    record(
      "renderer-adapter",
      sample.counters.rendererAdapter ?? "missing",
      renderer,
      sample.counters.rendererAdapter === renderer,
    );
    const expectedCullPath = renderer === "webgpu" ? "compute-cull" : "cpu-grid";
    const expectedPalettePath = renderer === "webgpu" ? "storage" : "texture";
    record(
      "cull-path",
      sample.counters.cullPath ?? "missing",
      expectedCullPath,
      sample.counters.cullPath === expectedCullPath,
    );
    record(
      "palette-path",
      sample.counters.palettePath ?? "missing",
      expectedPalettePath,
      sample.counters.palettePath === expectedPalettePath,
    );
    if (phases === undefined) {
      record("two-phase-timings", "missing", "present", false);
      continue;
    }

    recordPhase("camera", phases.camera, expected.sampleFrames, record);
    recordPhase("position-mutation", phases.positionMutation, expected.sampleFrames, record);
    const gpuTiming = sample.timings.gpuTiming;
    record(
      "gpu-timing-renderer",
      gpuTiming?.renderer ?? "missing",
      renderer,
      gpuTiming?.renderer === renderer,
    );
    const expectedTimerSamples = 2 * (expected.warmupFrames + expected.sampleFrames);
    record(
      "viewport-frame-events",
      numberInvariant(sample, "viewportFrameEvents"),
      expectedTimerSamples,
      numberInvariant(sample, "viewportFrameEvents") === expectedTimerSamples,
    );
    record(
      "viewport-commits",
      numberInvariant(sample, "viewportCommits"),
      `>= ${String(expectedTimerSamples)}`,
      numberInvariant(sample, "viewportCommits") >= expectedTimerSamples,
    );
    record(
      "gpu-timing-samples",
      gpuTiming?.samples ?? 0,
      expectedTimerSamples,
      gpuTiming?.samples === expectedTimerSamples,
    );
    record(
      "gpu-timing-quality",
      gpuTiming?.quality ?? "missing",
      "valid",
      gpuTiming?.quality === "valid",
    );
    record(
      "gpu-timing-valid-samples",
      gpuTiming?.validSamples ?? 0,
      expectedTimerSamples,
      gpuTiming?.validSamples === expectedTimerSamples,
    );
    record(
      "gpu-timing-fallback-samples",
      gpuTiming?.fallbackSamples ?? 0,
      0,
      gpuTiming?.fallbackSamples === 0,
    );
  }

  return Object.freeze({
    passed: checks.every((check) => check.passed),
    checks: Object.freeze(checks),
  });
}

function recordPhase(
  name: string,
  phase: NonNullable<BrowserBenchmarkSample["timings"]["phases"]>["camera"],
  expectedSamples: number,
  record: (name: string, actual: number | string, limit: number | string, passed: boolean) => void,
): void {
  record(
    `${name}-frame-p95-ms`,
    p95(phase.frameMs),
    GPU_SCENE_V2_FRAME_BUDGET_MS,
    p95(phase.frameMs) <= GPU_SCENE_V2_FRAME_BUDGET_MS,
  );
  const metricSamples: readonly (readonly [string, readonly unknown[] | undefined])[] = [
    ["frame", phase.frameMs],
    ["cpu", phase.cpuMs],
    ["gpu", phase.gpuMs],
    ["gpuTimestamp", phase.gpuTimestampMs],
    ["completionWall", phase.completionWallMs],
    ["upload", phase.uploadMs],
    ["commit", phase.commitMs],
    ["cull", phase.cullingMs],
    ["mutation", phase.mutationMs],
    ["visibilitySelection", phase.visibilitySelectionMs],
    ["renderPreparation", phase.renderPreparationMs],
    ["renderCoordinator", phase.renderCoordinatorMs],
    ["surfaceApply", phase.surfaceApplyMs],
    ["offscreenInspected", phase.offscreenInspectedLabels],
    ["offscreenMaterialized", phase.offscreenMaterializedLabels],
    ["offscreenDeferred", phase.offscreenAdmissionDeferred],
    ["offscreenGeneration", phase.offscreenAdmissionGeneration],
    ["offscreenCursor", phase.offscreenAdmissionCursor],
    ["offscreenCursorResets", phase.offscreenAdmissionCursorResets],
    ["offscreenCycles", phase.offscreenAdmissionCycles],
  ];
  for (const [metric, samples] of metricSamples) {
    record(
      `${name}-${metric}-samples`,
      samples?.length ?? 0,
      expectedSamples,
      samples?.length === expectedSamples,
    );
  }
  const gpuTimestampMs = phase.gpuTimestampMs ?? [];
  record(
    `${name}-gpu-timestamp-values`,
    gpuTimestampMs.filter((sample) => sample !== null).length,
    expectedSamples,
    gpuTimestampMs.length === expectedSamples && gpuTimestampMs.every((sample) => sample !== null),
  );
  const offscreenInspectedLabels = phase.offscreenInspectedLabels ?? [];
  const offscreenMaterializedLabels = phase.offscreenMaterializedLabels ?? [];
  record(
    `${name}-offscreen-inspected-max`,
    maximum(offscreenInspectedLabels),
    GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET,
    maximum(offscreenInspectedLabels) <= GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET,
  );
  record(
    `${name}-offscreen-materialized-max`,
    maximum(offscreenMaterializedLabels),
    GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET,
    maximum(offscreenMaterializedLabels) <= GPU_SCENE_V2_OFFSCREEN_LABEL_BUDGET,
  );
  const materializedWithinInspection = offscreenMaterializedLabels.every(
    (sample, index) => sample <= (offscreenInspectedLabels[index] ?? -1),
  );
  record(
    `${name}-offscreen-materialized-within-inspection`,
    materializedWithinInspection ? "valid" : "invalid",
    "valid",
    offscreenMaterializedLabels.length === expectedSamples && materializedWithinInspection,
  );
  const admittedLabelsTotal = phase.admittedLabelsTotal;
  const expectedAdmittedLabels = sum(offscreenMaterializedLabels);
  record(
    `${name}-offscreen-admitted-total`,
    admittedLabelsTotal ?? "missing",
    expectedAdmittedLabels,
    admittedLabelsTotal !== undefined && admittedLabelsTotal === expectedAdmittedLabels,
  );
  const shapedLabelsDelta = phase.shapedLabelsDelta;
  record(
    `${name}-shaped-labels-delta`,
    shapedLabelsDelta ?? "missing",
    ">= 0",
    shapedLabelsDelta !== undefined && shapedLabelsDelta >= 0,
  );
}

function p95(samples: readonly number[]): number {
  if (samples.length === 0) return Number.POSITIVE_INFINITY;
  return summarize(samples, "ms").p95;
}

function maximum(samples: readonly number[]): number {
  if (samples.length === 0) return Number.POSITIVE_INFINITY;
  let value = 0;
  for (const sample of samples) value = Math.max(value, sample);
  return value;
}

function sum(samples: readonly number[]): number {
  let value = 0;
  for (const sample of samples) value += sample;
  return value;
}

function numberInvariant(sample: Readonly<BrowserBenchmarkSample>, name: string): number {
  const value = sample.invariants[name];
  return typeof value === "number" ? value : Number.NaN;
}
