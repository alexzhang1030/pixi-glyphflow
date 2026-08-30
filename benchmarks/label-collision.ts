import type { TextLabelSpec, TextLayerCollisionOptions } from "../src";

const BENCHMARK_STYLE = Object.freeze({ fontFamily: "Arial", fontSize: 8, fill: 0xffffff });

export interface LabelCollisionBenchmarkOptions {
  readonly labelCount?: number;
  readonly overlapGroupSize?: number;
  readonly groupColumns?: number;
  readonly groupSpacingX?: number;
  readonly groupSpacingY?: number;
  readonly text?: string;
  readonly style?: Readonly<TextLabelSpec["style"]>;
}

export interface LabelCollisionBenchmarkStats {
  readonly labelCount: number;
  readonly visibleLabelCount: number;
  readonly collisionCandidateCount: number;
  readonly collisionCulledLabelCount: number;
  readonly densityCulledLabelCount: number;
  readonly lastCollisionMs: number;
  readonly collisionSelectionHash: number;
}

export interface LabelCollisionWorkloadSummary {
  readonly residentLabels: number;
  readonly candidateLabels: number;
  readonly submittedLabels: number;
  readonly submittedReduction: number;
  readonly submittedReductionRatio: number;
  readonly collisionCulledLabels: number;
  readonly densityCulledLabels: number;
  readonly cpuMs: number;
  readonly collisionCpuMs: number;
  readonly selectionHash: number;
}

export const LABEL_COLLISION_REPEATABILITY_SCHEMA_VERSION = 1;
export const LABEL_COLLISION_ACTIVE_SCATTER_SCHEMA_VERSION = 1;

export interface LabelCollisionRepeatabilityTiming {
  readonly p50: number;
  readonly p95: number;
}

export interface LabelCollisionRepeatabilityRun {
  readonly index: number;
  readonly renderer: "webgl" | "webgpu";
  readonly timings: Readonly<{
    frameMs: Readonly<LabelCollisionRepeatabilityTiming>;
    cpuMs: Readonly<LabelCollisionRepeatabilityTiming>;
    commitMs: Readonly<LabelCollisionRepeatabilityTiming>;
    collisionMs: Readonly<LabelCollisionRepeatabilityTiming>;
  }>;
  readonly submittedLabels: number;
  readonly submittedGlyphs: number;
  readonly selectionHash: number;
  readonly accountingPassed: boolean;
  readonly budgetPassed: boolean;
}

export interface LabelCollisionRepeatabilityMetric {
  readonly mean: number;
  readonly min: number;
  readonly max: number;
  readonly range: number;
  readonly coefficientOfVariation: number;
}

export interface LabelCollisionRepeatabilityRendererSummary {
  readonly sourceCandidateArtifact: string;
  readonly runs: readonly Readonly<LabelCollisionRepeatabilityRun>[];
  readonly aggregate: Readonly<{
    frameP50Ms: Readonly<LabelCollisionRepeatabilityMetric>;
    frameP95Ms: Readonly<LabelCollisionRepeatabilityMetric>;
    cpuP50Ms: Readonly<LabelCollisionRepeatabilityMetric>;
    cpuP95Ms: Readonly<LabelCollisionRepeatabilityMetric>;
    commitP50Ms: Readonly<LabelCollisionRepeatabilityMetric>;
    commitP95Ms: Readonly<LabelCollisionRepeatabilityMetric>;
    collisionP50Ms: Readonly<LabelCollisionRepeatabilityMetric>;
    collisionP95Ms: Readonly<LabelCollisionRepeatabilityMetric>;
  }>;
  readonly invariants: Readonly<{
    submittedGlyphsMatchLabels: boolean;
    selectionHashStable: boolean;
    accountingPassed: boolean;
    budgetsPassed: boolean;
  }>;
}

export interface LabelCollisionRepeatabilityArtifact {
  readonly schemaVersion: typeof LABEL_COLLISION_REPEATABILITY_SCHEMA_VERSION;
  readonly kind: "pixi-glyphflow-label-collision-repeatability";
  readonly capturedAt: string;
  readonly packageVersion: "1.2.0";
  readonly workload: "label-collision";
  readonly runtime: Readonly<{
    readonly bun: string;
    readonly cpu: string;
    readonly platform: string;
    readonly architecture: string;
  }>;
  readonly configuration: Readonly<{
    readonly residentLabels: number;
    readonly warmupFrames: 5;
    readonly sampleFrames: 120;
    readonly runsPerRenderer: 3;
  }>;
  readonly renderers: Readonly<{
    readonly webgl: Readonly<LabelCollisionRepeatabilityRendererSummary>;
    readonly webgpu: Readonly<LabelCollisionRepeatabilityRendererSummary>;
  }>;
}

export interface LabelCollisionRepeatabilityArtifactInput {
  readonly capturedAt: string;
  readonly runtime: LabelCollisionRepeatabilityArtifact["runtime"];
  readonly webgl: readonly Readonly<LabelCollisionRepeatabilityRun>[];
  readonly webgpu: readonly Readonly<LabelCollisionRepeatabilityRun>[];
}

export interface LabelCollisionDetailedTimings {
  readonly frameMs: Readonly<LabelCollisionRepeatabilityTiming>;
  readonly cpuMs: Readonly<LabelCollisionRepeatabilityTiming>;
  readonly commitMs: Readonly<LabelCollisionRepeatabilityTiming>;
  readonly collisionMs: Readonly<LabelCollisionRepeatabilityTiming>;
  readonly visibilitySelectionMs: Readonly<LabelCollisionRepeatabilityTiming>;
  readonly renderPreparationMs: Readonly<LabelCollisionRepeatabilityTiming>;
  readonly renderCoordinatorMs: Readonly<LabelCollisionRepeatabilityTiming>;
  readonly surfaceApplyMs: Readonly<LabelCollisionRepeatabilityTiming>;
  readonly uploadMs: Readonly<LabelCollisionRepeatabilityTiming>;
  readonly uploadBytes: Readonly<LabelCollisionRepeatabilityTiming>;
}

export interface LabelCollisionActiveScatterRun {
  readonly index: number;
  readonly capturedAt: string;
  readonly timings: Readonly<LabelCollisionDetailedTimings>;
  readonly submittedLabels: number;
  readonly submittedGlyphs: number;
  readonly selectionHash: number;
  readonly accountingPassed: boolean;
  readonly gpuTimestampSamples: number;
  readonly budgetPassed: boolean;
}

export interface LabelCollisionPhaseDiagnostic {
  readonly renderer: "webgl" | "webgpu";
  readonly sampleFrames: number;
  readonly palettePath: "texture" | "storage";
  readonly timings: Readonly<LabelCollisionDetailedTimings>;
  readonly submittedLabels: number;
  readonly submittedGlyphs: number;
  readonly selectionHash: number;
  readonly accountingPassed: boolean;
  readonly gpuTimestampSamples: number;
}

export interface LabelCollisionBeforeAfterMetric {
  readonly before: readonly number[];
  readonly after: readonly number[];
  readonly beforeMean: number;
  readonly afterMean: number;
  readonly delta: number;
  readonly reductionRatio: number;
}

export interface LabelCollisionActiveScatterArtifact {
  readonly schemaVersion: typeof LABEL_COLLISION_ACTIVE_SCATTER_SCHEMA_VERSION;
  readonly kind: "pixi-glyphflow-label-collision-active-scatter-repeatability";
  readonly capturedAt: string;
  readonly packageVersion: "1.2.0";
  readonly workload: "label-collision";
  readonly renderer: "webgpu";
  readonly runtime: LabelCollisionRepeatabilityArtifact["runtime"];
  readonly configuration: Readonly<{
    residentLabels: 1_000_000;
    warmupFrames: 5;
    sampleFrames: 120;
    runs: 3;
    cpuBudgetMs: 16.67;
  }>;
  readonly implementation: Readonly<{
    commandStrideBytes: 64;
    maximumCommandBytes: 16_777_216;
    maximumActiveLabels: 262_144;
    fixedDispatchCostBytes: 65_536;
  }>;
  readonly before: Readonly<{
    sourceArtifact: "browser-label-collision-repeatability-1.2.0.json";
    formalRuns: readonly Readonly<LabelCollisionRepeatabilityRun>[];
    webgpuPhaseDiagnostic: Readonly<LabelCollisionPhaseDiagnostic>;
    webglControl: Readonly<LabelCollisionPhaseDiagnostic>;
  }>;
  readonly after: Readonly<{
    sourceCandidateArtifact: "browser-label-collision-webgpu-candidate-1.2.0.json";
    formalRuns: readonly Readonly<LabelCollisionActiveScatterRun>[];
    webglControl: Readonly<LabelCollisionPhaseDiagnostic>;
    aggregateP95: Readonly<{
      frameMs: Readonly<LabelCollisionRepeatabilityMetric>;
      cpuMs: Readonly<LabelCollisionRepeatabilityMetric>;
      commitMs: Readonly<LabelCollisionRepeatabilityMetric>;
      collisionMs: Readonly<LabelCollisionRepeatabilityMetric>;
      visibilitySelectionMs: Readonly<LabelCollisionRepeatabilityMetric>;
      renderPreparationMs: Readonly<LabelCollisionRepeatabilityMetric>;
      renderCoordinatorMs: Readonly<LabelCollisionRepeatabilityMetric>;
      surfaceApplyMs: Readonly<LabelCollisionRepeatabilityMetric>;
      uploadMs: Readonly<LabelCollisionRepeatabilityMetric>;
      uploadBytes: Readonly<LabelCollisionRepeatabilityMetric>;
    }>;
  }>;
  readonly comparison: Readonly<{
    frameP95Ms: Readonly<LabelCollisionBeforeAfterMetric>;
    cpuP95Ms: Readonly<LabelCollisionBeforeAfterMetric>;
    commitP95Ms: Readonly<LabelCollisionBeforeAfterMetric>;
    collisionP95Ms: Readonly<LabelCollisionBeforeAfterMetric>;
    surfaceApplyP95Ms: Readonly<LabelCollisionBeforeAfterMetric>;
    uploadP95Ms: Readonly<LabelCollisionBeforeAfterMetric>;
    uploadP95Bytes: Readonly<LabelCollisionBeforeAfterMetric>;
  }>;
  readonly invariants: Readonly<{
    formalSelectionHashStable: boolean;
    submittedGlyphsMatchLabels: boolean;
    accountingPassed: boolean;
    beforeBudgetsPassed: boolean;
    afterBudgetsPassed: boolean;
    afterCpuBudgetPassed: boolean;
    afterCollisionBudgetPassed: boolean;
    afterWholeFrameBudgetPassed: boolean;
    webglControlStable: boolean;
  }>;
}

export interface LabelCollisionActiveScatterArtifactInput {
  readonly capturedAt: string;
  readonly runtime: LabelCollisionRepeatabilityArtifact["runtime"];
  readonly beforeFormalRuns: readonly Readonly<LabelCollisionRepeatabilityRun>[];
  readonly beforeWebgpuDiagnostic: Readonly<LabelCollisionPhaseDiagnostic>;
  readonly afterFormalRuns: readonly Readonly<LabelCollisionActiveScatterRun>[];
  readonly beforeWebglControl: Readonly<LabelCollisionPhaseDiagnostic>;
  readonly afterWebglControl: Readonly<LabelCollisionPhaseDiagnostic>;
}

export const LABEL_COLLISION_BENCHMARK_DEFAULTS: Readonly<{
  labelCount: number;
  overlapGroupSize: number;
  groupColumns: number;
  groupSpacingX: number;
  groupSpacingY: number;
  collision: Readonly<TextLayerCollisionOptions>;
}> = Object.freeze({
  labelCount: 1_000_000,
  overlapGroupSize: 1_024,
  groupColumns: 32,
  groupSpacingX: 64,
  groupSpacingY: 32,
  collision: Object.freeze({
    enabled: true,
    padding: 2,
    maxVisible: 512,
    cellSize: 64,
  }),
});

/** Build a bounded chunk of the million-resident, high-overlap browser workload. */
export function createLabelCollisionBenchmarkSpecs(
  start: number,
  count: number,
  options: Readonly<LabelCollisionBenchmarkOptions> = {},
): TextLabelSpec[] {
  const labelCount = options.labelCount ?? LABEL_COLLISION_BENCHMARK_DEFAULTS.labelCount;
  const overlapGroupSize =
    options.overlapGroupSize ?? LABEL_COLLISION_BENCHMARK_DEFAULTS.overlapGroupSize;
  const groupColumns = options.groupColumns ?? LABEL_COLLISION_BENCHMARK_DEFAULTS.groupColumns;
  const groupSpacingX = options.groupSpacingX ?? LABEL_COLLISION_BENCHMARK_DEFAULTS.groupSpacingX;
  const groupSpacingY = options.groupSpacingY ?? LABEL_COLLISION_BENCHMARK_DEFAULTS.groupSpacingY;
  assertPositiveSafeInteger("labelCount", labelCount);
  assertPositiveSafeInteger("overlapGroupSize", overlapGroupSize);
  assertPositiveSafeInteger("groupColumns", groupColumns);
  assertFinitePositive("groupSpacingX", groupSpacingX);
  assertFinitePositive("groupSpacingY", groupSpacingY);
  if (!Number.isSafeInteger(start) || start < 0) {
    throw new TypeError("Label collision benchmark start must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(count) || count < 0 || start + count > labelCount) {
    throw new RangeError("Label collision benchmark chunk exceeds the configured label count");
  }
  const text = options.text ?? "MapLabel";
  const style = options.style ?? BENCHMARK_STYLE;

  return Array.from({ length: count }, (_, localIndex): TextLabelSpec => {
    const index = start + localIndex;
    const group = Math.floor(index / overlapGroupSize);
    return {
      text,
      x: (group % groupColumns) * groupSpacingX,
      y: Math.floor(group / groupColumns) * groupSpacingY,
      priority: labelCount - index,
      style,
    };
  });
}

/** Normalize the counters required by benchmark artifacts and reports. */
export function summarizeLabelCollisionWorkload(
  stats: Readonly<LabelCollisionBenchmarkStats>,
  cpuMs: number,
  residentLabels: number = stats.labelCount,
): Readonly<LabelCollisionWorkloadSummary> {
  if (!Number.isFinite(cpuMs) || cpuMs < 0) {
    throw new TypeError("Label collision benchmark cpuMs must be a finite non-negative number");
  }
  if (!Number.isSafeInteger(residentLabels) || residentLabels < 0) {
    throw new TypeError("Label collision benchmark residentLabels must be a non-negative integer");
  }
  const submittedLabels = stats.visibleLabelCount;
  const submittedReduction = Math.max(0, residentLabels - submittedLabels);

  return Object.freeze({
    residentLabels,
    candidateLabels: stats.collisionCandidateCount,
    submittedLabels,
    submittedReduction,
    submittedReductionRatio: residentLabels === 0 ? 0 : submittedReduction / residentLabels,
    collisionCulledLabels: stats.collisionCulledLabelCount,
    densityCulledLabels: stats.densityCulledLabelCount,
    cpuMs,
    collisionCpuMs: stats.lastCollisionMs,
    selectionHash: stats.collisionSelectionHash,
  });
}

/** Build durable three-run evidence for each renderer from exact formal summaries. */
export function createLabelCollisionRepeatabilityArtifact(
  input: Readonly<LabelCollisionRepeatabilityArtifactInput>,
): Readonly<LabelCollisionRepeatabilityArtifact> {
  if (Number.isNaN(Date.parse(input.capturedAt))) {
    throw new TypeError("Label collision repeatability capturedAt must be an ISO timestamp");
  }
  const webgl = summarizeRepeatabilityRenderer("webgl", input.webgl);
  const webgpu = summarizeRepeatabilityRenderer("webgpu", input.webgpu);

  return Object.freeze({
    schemaVersion: LABEL_COLLISION_REPEATABILITY_SCHEMA_VERSION,
    kind: "pixi-glyphflow-label-collision-repeatability",
    capturedAt: input.capturedAt,
    packageVersion: "1.2.0",
    workload: "label-collision",
    runtime: Object.freeze({ ...input.runtime }),
    configuration: Object.freeze({
      residentLabels: LABEL_COLLISION_BENCHMARK_DEFAULTS.labelCount,
      warmupFrames: 5,
      sampleFrames: 120,
      runsPerRenderer: 3,
    }),
    renderers: Object.freeze({ webgl, webgpu }),
  });
}

/** Preserve the formal WebGPU before/after evidence for active transform scatter. */
export function createLabelCollisionActiveScatterArtifact(
  input: Readonly<LabelCollisionActiveScatterArtifactInput>,
): Readonly<LabelCollisionActiveScatterArtifact> {
  if (Number.isNaN(Date.parse(input.capturedAt))) {
    throw new TypeError("Label collision active scatter capturedAt must be an ISO timestamp");
  }
  const beforeSummary = summarizeRepeatabilityRenderer("webgpu", input.beforeFormalRuns);
  const afterRuns = Object.freeze(
    input.afterFormalRuns.map((run, index) => normalizeActiveScatterRun(run, index + 1)),
  );
  if (afterRuns.length !== 3) {
    throw new RangeError("Label collision active scatter requires exactly three after runs");
  }
  const beforeWebgpuDiagnostic = normalizePhaseDiagnostic(input.beforeWebgpuDiagnostic, "webgpu");
  const beforeWebglControl = normalizePhaseDiagnostic(input.beforeWebglControl, "webgl");
  const afterWebglControl = normalizePhaseDiagnostic(input.afterWebglControl, "webgl");
  const aggregateP95 = Object.freeze({
    frameMs: metric(afterRuns.map((run) => run.timings.frameMs.p95)),
    cpuMs: metric(afterRuns.map((run) => run.timings.cpuMs.p95)),
    commitMs: metric(afterRuns.map((run) => run.timings.commitMs.p95)),
    collisionMs: metric(afterRuns.map((run) => run.timings.collisionMs.p95)),
    visibilitySelectionMs: metric(afterRuns.map((run) => run.timings.visibilitySelectionMs.p95)),
    renderPreparationMs: metric(afterRuns.map((run) => run.timings.renderPreparationMs.p95)),
    renderCoordinatorMs: metric(afterRuns.map((run) => run.timings.renderCoordinatorMs.p95)),
    surfaceApplyMs: metric(afterRuns.map((run) => run.timings.surfaceApplyMs.p95)),
    uploadMs: metric(afterRuns.map((run) => run.timings.uploadMs.p95)),
    uploadBytes: metric(afterRuns.map((run) => run.timings.uploadBytes.p95)),
  });
  const beforeRuns = beforeSummary.runs;
  const comparison = Object.freeze({
    frameP95Ms: beforeAfterMetric(
      beforeRuns.map((run) => run.timings.frameMs.p95),
      afterRuns.map((run) => run.timings.frameMs.p95),
    ),
    cpuP95Ms: beforeAfterMetric(
      beforeRuns.map((run) => run.timings.cpuMs.p95),
      afterRuns.map((run) => run.timings.cpuMs.p95),
    ),
    commitP95Ms: beforeAfterMetric(
      beforeRuns.map((run) => run.timings.commitMs.p95),
      afterRuns.map((run) => run.timings.commitMs.p95),
    ),
    collisionP95Ms: beforeAfterMetric(
      beforeRuns.map((run) => run.timings.collisionMs.p95),
      afterRuns.map((run) => run.timings.collisionMs.p95),
    ),
    surfaceApplyP95Ms: beforeAfterMetric(
      [beforeWebgpuDiagnostic.timings.surfaceApplyMs.p95],
      afterRuns.map((run) => run.timings.surfaceApplyMs.p95),
    ),
    uploadP95Ms: beforeAfterMetric(
      [beforeWebgpuDiagnostic.timings.uploadMs.p95],
      afterRuns.map((run) => run.timings.uploadMs.p95),
    ),
    uploadP95Bytes: beforeAfterMetric(
      [beforeWebgpuDiagnostic.timings.uploadBytes.p95],
      afterRuns.map((run) => run.timings.uploadBytes.p95),
    ),
  });
  const formalHashes = [
    ...beforeRuns.map((run) => run.selectionHash),
    ...afterRuns.map((run) => run.selectionHash),
  ];
  const firstFormalHash = formalHashes[0] ?? 0;
  const cpuBudgetMs = 16.67;

  return Object.freeze({
    schemaVersion: LABEL_COLLISION_ACTIVE_SCATTER_SCHEMA_VERSION,
    kind: "pixi-glyphflow-label-collision-active-scatter-repeatability",
    capturedAt: input.capturedAt,
    packageVersion: "1.2.0",
    workload: "label-collision",
    renderer: "webgpu",
    runtime: Object.freeze({ ...input.runtime }),
    configuration: Object.freeze({
      residentLabels: 1_000_000,
      warmupFrames: 5,
      sampleFrames: 120,
      runs: 3,
      cpuBudgetMs,
    }),
    implementation: Object.freeze({
      commandStrideBytes: 64,
      maximumCommandBytes: 16_777_216,
      maximumActiveLabels: 262_144,
      fixedDispatchCostBytes: 65_536,
    }),
    before: Object.freeze({
      sourceArtifact: "browser-label-collision-repeatability-1.2.0.json",
      formalRuns: beforeRuns,
      webgpuPhaseDiagnostic: beforeWebgpuDiagnostic,
      webglControl: beforeWebglControl,
    }),
    after: Object.freeze({
      sourceCandidateArtifact: "browser-label-collision-webgpu-candidate-1.2.0.json",
      formalRuns: afterRuns,
      webglControl: afterWebglControl,
      aggregateP95,
    }),
    comparison,
    invariants: Object.freeze({
      formalSelectionHashStable:
        firstFormalHash > 0 && formalHashes.every((hash) => hash === firstFormalHash),
      submittedGlyphsMatchLabels: afterRuns.every(
        (run) => run.submittedGlyphs === run.submittedLabels * 8,
      ),
      accountingPassed: afterRuns.every((run) => run.accountingPassed),
      beforeBudgetsPassed: beforeRuns.every((run) => run.budgetPassed),
      afterBudgetsPassed: afterRuns.every((run) => run.budgetPassed),
      afterCpuBudgetPassed: afterRuns.every((run) => run.timings.cpuMs.p95 <= cpuBudgetMs),
      afterCollisionBudgetPassed: afterRuns.every(
        (run) => run.timings.collisionMs.p95 <= cpuBudgetMs,
      ),
      afterWholeFrameBudgetPassed: afterRuns.every((run) => run.timings.frameMs.p95 <= cpuBudgetMs),
      webglControlStable:
        beforeWebglControl.palettePath === "texture" &&
        afterWebglControl.palettePath === "texture" &&
        beforeWebglControl.submittedLabels === afterWebglControl.submittedLabels &&
        beforeWebglControl.submittedGlyphs === afterWebglControl.submittedGlyphs &&
        beforeWebglControl.selectionHash === afterWebglControl.selectionHash &&
        beforeWebglControl.accountingPassed &&
        afterWebglControl.accountingPassed,
    }),
  });
}

function summarizeRepeatabilityRenderer(
  renderer: "webgl" | "webgpu",
  runs: readonly Readonly<LabelCollisionRepeatabilityRun>[],
): Readonly<LabelCollisionRepeatabilityRendererSummary> {
  if (runs.length !== 3) {
    throw new RangeError(`Label collision repeatability ${renderer} requires exactly three runs`);
  }
  const frozenRuns = runs.map((run, index) => {
    if (run.index !== index + 1 || run.renderer !== renderer) {
      throw new TypeError(`Label collision repeatability ${renderer} run order is invalid`);
    }
    assertRepeatabilityRun(run);
    return Object.freeze({
      ...run,
      timings: Object.freeze({
        frameMs: Object.freeze({ ...run.timings.frameMs }),
        cpuMs: Object.freeze({ ...run.timings.cpuMs }),
        commitMs: Object.freeze({ ...run.timings.commitMs }),
        collisionMs: Object.freeze({ ...run.timings.collisionMs }),
      }),
    });
  });
  const aggregate = Object.freeze({
    frameP50Ms: metric(frozenRuns.map((run) => run.timings.frameMs.p50)),
    frameP95Ms: metric(frozenRuns.map((run) => run.timings.frameMs.p95)),
    cpuP50Ms: metric(frozenRuns.map((run) => run.timings.cpuMs.p50)),
    cpuP95Ms: metric(frozenRuns.map((run) => run.timings.cpuMs.p95)),
    commitP50Ms: metric(frozenRuns.map((run) => run.timings.commitMs.p50)),
    commitP95Ms: metric(frozenRuns.map((run) => run.timings.commitMs.p95)),
    collisionP50Ms: metric(frozenRuns.map((run) => run.timings.collisionMs.p50)),
    collisionP95Ms: metric(frozenRuns.map((run) => run.timings.collisionMs.p95)),
  });
  const firstHash = frozenRuns[0]?.selectionHash ?? 0;

  return Object.freeze({
    sourceCandidateArtifact: `browser-label-collision-${renderer}-candidate-1.2.0.json`,
    runs: Object.freeze(frozenRuns),
    aggregate,
    invariants: Object.freeze({
      submittedGlyphsMatchLabels: frozenRuns.every(
        (run) => run.submittedGlyphs === run.submittedLabels * 8,
      ),
      selectionHashStable:
        firstHash > 0 && frozenRuns.every((run) => run.selectionHash === firstHash),
      accountingPassed: frozenRuns.every((run) => run.accountingPassed),
      budgetsPassed: frozenRuns.every((run) => run.budgetPassed),
    }),
  });
}

function assertRepeatabilityRun(run: Readonly<LabelCollisionRepeatabilityRun>): void {
  for (const timing of Object.values(run.timings)) {
    if (
      !Number.isFinite(timing.p50) ||
      timing.p50 < 0 ||
      !Number.isFinite(timing.p95) ||
      timing.p95 < timing.p50
    ) {
      throw new TypeError("Label collision repeatability timings must be finite ordered values");
    }
  }
  if (!Number.isSafeInteger(run.submittedLabels) || run.submittedLabels < 0) {
    throw new TypeError(
      "Label collision repeatability submittedLabels must be a non-negative integer",
    );
  }
  if (!Number.isSafeInteger(run.submittedGlyphs) || run.submittedGlyphs < 0) {
    throw new TypeError(
      "Label collision repeatability submittedGlyphs must be a non-negative integer",
    );
  }
  if (
    !Number.isSafeInteger(run.selectionHash) ||
    run.selectionHash < 0 ||
    run.selectionHash > 0xffff_ffff
  ) {
    throw new TypeError("Label collision repeatability selectionHash must be a uint32");
  }
}

function normalizeActiveScatterRun(
  run: Readonly<LabelCollisionActiveScatterRun>,
  expectedIndex: number,
): Readonly<LabelCollisionActiveScatterRun> {
  if (run.index !== expectedIndex) {
    throw new TypeError("Label collision active scatter run order is invalid");
  }
  if (Number.isNaN(Date.parse(run.capturedAt))) {
    throw new TypeError("Label collision active scatter run capturedAt must be an ISO timestamp");
  }
  assertSubmittedState(run);
  if (!Number.isSafeInteger(run.gpuTimestampSamples) || run.gpuTimestampSamples < 0) {
    throw new TypeError("Label collision GPU timestamp samples must be a non-negative integer");
  }
  return Object.freeze({
    ...run,
    timings: normalizeDetailedTimings(run.timings),
  });
}

function normalizePhaseDiagnostic(
  diagnostic: Readonly<LabelCollisionPhaseDiagnostic>,
  renderer: "webgl" | "webgpu",
): Readonly<LabelCollisionPhaseDiagnostic> {
  if (diagnostic.renderer !== renderer) {
    throw new TypeError(`Label collision phase diagnostic must use ${renderer}`);
  }
  if (!Number.isSafeInteger(diagnostic.sampleFrames) || diagnostic.sampleFrames <= 0) {
    throw new TypeError("Label collision diagnostic sampleFrames must be a positive integer");
  }
  assertSubmittedState(diagnostic);
  if (
    !Number.isSafeInteger(diagnostic.gpuTimestampSamples) ||
    diagnostic.gpuTimestampSamples < diagnostic.sampleFrames
  ) {
    throw new TypeError("Label collision diagnostic must include every GPU timestamp sample");
  }
  return Object.freeze({
    ...diagnostic,
    timings: normalizeDetailedTimings(diagnostic.timings),
  });
}

function normalizeDetailedTimings(
  timings: Readonly<LabelCollisionDetailedTimings>,
): Readonly<LabelCollisionDetailedTimings> {
  const normalize = (
    timing: Readonly<LabelCollisionRepeatabilityTiming>,
  ): Readonly<LabelCollisionRepeatabilityTiming> => {
    if (
      !Number.isFinite(timing.p50) ||
      timing.p50 < 0 ||
      !Number.isFinite(timing.p95) ||
      timing.p95 < timing.p50
    ) {
      throw new TypeError("Label collision detailed timings must be finite ordered values");
    }
    return Object.freeze({ p50: round6(timing.p50), p95: round6(timing.p95) });
  };
  return Object.freeze({
    frameMs: normalize(timings.frameMs),
    cpuMs: normalize(timings.cpuMs),
    commitMs: normalize(timings.commitMs),
    collisionMs: normalize(timings.collisionMs),
    visibilitySelectionMs: normalize(timings.visibilitySelectionMs),
    renderPreparationMs: normalize(timings.renderPreparationMs),
    renderCoordinatorMs: normalize(timings.renderCoordinatorMs),
    surfaceApplyMs: normalize(timings.surfaceApplyMs),
    uploadMs: normalize(timings.uploadMs),
    uploadBytes: normalize(timings.uploadBytes),
  });
}

function assertSubmittedState(
  state: Readonly<{
    submittedLabels: number;
    submittedGlyphs: number;
    selectionHash: number;
  }>,
): void {
  if (!Number.isSafeInteger(state.submittedLabels) || state.submittedLabels < 0) {
    throw new TypeError("Label collision submittedLabels must be a non-negative integer");
  }
  if (!Number.isSafeInteger(state.submittedGlyphs) || state.submittedGlyphs < 0) {
    throw new TypeError("Label collision submittedGlyphs must be a non-negative integer");
  }
  if (
    !Number.isSafeInteger(state.selectionHash) ||
    state.selectionHash < 0 ||
    state.selectionHash > 0xffff_ffff
  ) {
    throw new TypeError("Label collision selectionHash must be a uint32");
  }
}

function beforeAfterMetric(
  before: readonly number[],
  after: readonly number[],
): Readonly<LabelCollisionBeforeAfterMetric> {
  const beforeMetric = metric(before);
  const afterMetric = metric(after);
  const delta = afterMetric.mean - beforeMetric.mean;
  return Object.freeze({
    before: Object.freeze(before.map(round6)),
    after: Object.freeze(after.map(round6)),
    beforeMean: beforeMetric.mean,
    afterMean: afterMetric.mean,
    delta: round6(delta),
    reductionRatio: beforeMetric.mean === 0 ? 0 : round6(-delta / beforeMetric.mean),
  });
}

function metric(values: readonly number[]): Readonly<LabelCollisionRepeatabilityMetric> {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const variance =
    values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length;
  return Object.freeze({
    mean: round6(mean),
    min: round6(min),
    max: round6(max),
    range: round6(max - min),
    coefficientOfVariation: mean === 0 ? 0 : round6(Math.sqrt(variance) / mean),
  });
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Label collision benchmark ${name} must be a positive safe integer`);
  }
}

function assertFinitePositive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`Label collision benchmark ${name} must be a finite positive number`);
  }
}
