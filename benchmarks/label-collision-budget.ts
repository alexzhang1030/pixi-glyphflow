import { LABEL_COLLISION_BENCHMARK_DEFAULTS } from "./label-collision";
import {
  BENCHMARK_SCHEMA_VERSION,
  summarize,
  type BrowserBenchmarkBudgetCheck,
  type BrowserBenchmarkBudgetDecision,
  type BrowserBenchmarkRenderer,
  type BrowserBenchmarkSample,
} from "./schema";
import { getBenchmarkWorkload } from "./workloads";

export const LABEL_COLLISION_CPU_BUDGET_MS = 16.67;
export const LABEL_COLLISION_WHOLE_FRAME_BUDGET_MS = 16.67;

export function evaluateLabelCollisionBudget(
  samples: readonly Readonly<BrowserBenchmarkSample>[],
  renderer: BrowserBenchmarkRenderer,
): Readonly<BrowserBenchmarkBudgetDecision> {
  const expected = getBenchmarkWorkload("label-collision");
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
    const counters = sample.counters;
    const candidateLabels = counters.collisionCandidateLabels ?? 0;
    const submittedLabels = counters.submittedLabels;
    const collisionCulledLabels = counters.collisionCulledLabels ?? 0;
    const densityCulledLabels = counters.densityCulledLabels ?? 0;
    const accountedLabels = submittedLabels + collisionCulledLabels + densityCulledLabels;
    const maxVisible = LABEL_COLLISION_BENCHMARK_DEFAULTS.collision.maxVisible ?? 512;
    record(
      "schema-version",
      sample.schemaVersion,
      BENCHMARK_SCHEMA_VERSION,
      sample.schemaVersion === BENCHMARK_SCHEMA_VERSION,
    );
    record(
      "renderer",
      sample.configuration.renderer,
      renderer,
      sample.configuration.renderer === renderer,
    );
    record(
      "renderer-adapter",
      counters.rendererAdapter ?? "missing",
      renderer,
      counters.rendererAdapter === renderer,
    );
    record(
      "resident-labels",
      counters.residentLabels,
      expected.labelCount,
      counters.residentLabels === expected.labelCount,
    );
    record(
      "warmup-frames",
      sample.configuration.warmupFrames,
      expected.warmupFrames,
      sample.configuration.warmupFrames === expected.warmupFrames,
    );
    record(
      "sample-frames",
      sample.configuration.sampleFrames,
      expected.sampleFrames,
      sample.configuration.sampleFrames === expected.sampleFrames,
    );
    record(
      "frame-samples",
      sample.timings.frameMs.length,
      expected.sampleFrames,
      sample.timings.frameMs.length === expected.sampleFrames,
    );
    record(
      "cpu-samples",
      sample.timings.cpuMs?.length ?? 0,
      expected.sampleFrames,
      sample.timings.cpuMs?.length === expected.sampleFrames,
    );
    record(
      "collision-samples",
      sample.timings.cullingMs?.length ?? 0,
      expected.sampleFrames,
      sample.timings.cullingMs?.length === expected.sampleFrames,
    );
    record(
      "visibility-selection-samples",
      sample.timings.visibilitySelectionMs?.length ?? 0,
      expected.sampleFrames,
      sample.timings.visibilitySelectionMs?.length === expected.sampleFrames,
    );
    record(
      "render-preparation-samples",
      sample.timings.renderPreparationMs?.length ?? 0,
      expected.sampleFrames,
      sample.timings.renderPreparationMs?.length === expected.sampleFrames,
    );
    record(
      "render-coordinator-samples",
      sample.timings.renderCoordinatorMs?.length ?? 0,
      expected.sampleFrames,
      sample.timings.renderCoordinatorMs?.length === expected.sampleFrames,
    );
    record(
      "surface-apply-samples",
      sample.timings.surfaceApplyMs?.length ?? 0,
      expected.sampleFrames,
      sample.timings.surfaceApplyMs?.length === expected.sampleFrames,
    );
    if (renderer === "webgpu") {
      record(
        "frame-p95-ms",
        p95(sample.timings.frameMs),
        LABEL_COLLISION_WHOLE_FRAME_BUDGET_MS,
        p95(sample.timings.frameMs) <= LABEL_COLLISION_WHOLE_FRAME_BUDGET_MS,
      );
    }
    record(
      "cpu-p95-ms",
      p95(sample.timings.cpuMs),
      LABEL_COLLISION_CPU_BUDGET_MS,
      p95(sample.timings.cpuMs) <= LABEL_COLLISION_CPU_BUDGET_MS,
    );
    record(
      "collision-p95-ms",
      p95(sample.timings.cullingMs),
      LABEL_COLLISION_CPU_BUDGET_MS,
      p95(sample.timings.cullingMs) <= LABEL_COLLISION_CPU_BUDGET_MS,
    );
    record(
      "submitted-labels",
      submittedLabels,
      `1..${String(maxVisible)}`,
      submittedLabels > 0 && submittedLabels <= maxVisible,
    );
    record(
      "submitted-glyphs",
      counters.submittedGlyphs ?? 0,
      submittedLabels * 8,
      counters.submittedGlyphs === submittedLabels * 8,
    );
    record(
      "resident-reduction-ratio",
      counters.submittedReductionRatio ?? 0,
      ">= 0.9",
      (counters.submittedReductionRatio ?? 0) >= 0.9,
    );
    record(
      "candidate-reduction-ratio",
      counters.collisionCandidateReductionRatio ?? 0,
      ">= 0.9",
      (counters.collisionCandidateReductionRatio ?? 0) >= 0.9,
    );
    record(
      "candidate-accounting",
      accountedLabels,
      candidateLabels,
      candidateLabels > 0 && accountedLabels === candidateLabels,
    );
    record(
      "selection-hash",
      counters.collisionSelectionHash ?? 0,
      "> 0",
      (counters.collisionSelectionHash ?? 0) > 0,
    );
    record(
      "cull-path",
      counters.cullPath ?? "missing",
      "recorded",
      counters.cullPath !== undefined,
    );
    record(
      "palette-path",
      counters.palettePath ?? "missing",
      "recorded",
      counters.palettePath !== undefined,
    );
  }

  return Object.freeze({
    passed: checks.every((check) => check.passed),
    checks: Object.freeze(checks),
  });
}

function p95(samples: readonly number[] | undefined): number {
  if (samples === undefined || samples.length === 0) return Number.POSITIVE_INFINITY;
  return summarize(samples, "ms").p95;
}
