import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  BROWSER_BENCHMARK_HARNESS_PATHS,
  createCurrentBrowserBenchmarkArtifactIdentity,
  verifyBrowserBenchmarkArtifactEvidence,
  type CurrentBrowserBenchmarkArtifactIdentity,
} from "./artifacts";
import {
  type LabelCollisionRepeatabilityMetric,
  type LabelCollisionRepeatabilityRendererSummary,
  type LabelCollisionRepeatabilityRun,
  type LabelCollisionRepeatabilityTiming,
} from "./label-collision";
import {
  evaluateLabelCollisionBudget,
  LABEL_COLLISION_WHOLE_FRAME_BUDGET_MS,
} from "./label-collision-budget";
import {
  BENCHMARK_SCHEMA_VERSION,
  summarize,
  type BenchmarkRuntime,
  type BrowserBenchmarkArtifact,
  type BrowserBenchmarkRenderer,
} from "./schema";

export const LABEL_COLLISION_FORMAL_REPEATABILITY_SCHEMA_VERSION = 2;
export const LABEL_COLLISION_REPEATABILITY_RUNS_PER_RENDERER = 3;

const LABEL_COLLISION_PACKAGE_VERSION = "1.2.0";
const SHA256 = /^[0-9a-f]{64}$/;

export interface LabelCollisionRawCandidateInput {
  readonly artifactFile: string;
  readonly candidateSha256: string;
  readonly artifact: Readonly<BrowserBenchmarkArtifact>;
}

export interface LabelCollisionFormalRepeatabilityRun extends LabelCollisionRepeatabilityRun {
  readonly artifactFile: string;
  readonly candidateSha256: string;
  readonly capturedAt: string;
  readonly sampleCapturedAt: string | null;
  readonly runId: string | null;
  readonly buildFingerprintSha256: string | null;
  readonly harnessFingerprintSha256: string | null;
  readonly evidenceSha256: string | null;
  readonly runtimeFingerprintSha256: string | null;
  readonly provenanceValid: boolean;
  readonly currentCandidate: boolean;
  readonly budgetSealValid: boolean;
  readonly wholeFrameBudgetPassed: boolean;
  readonly failures: readonly string[];
  readonly eligible: boolean;
}

export interface LabelCollisionFormalRepeatabilityRendererSummary {
  /** Legacy report field retained while provenance moves to the plural collection. */
  readonly sourceCandidateArtifact: string;
  readonly sourceCandidateArtifacts: readonly Readonly<{
    artifactFile: string;
    sha256: string;
  }>[];
  readonly runs: readonly Readonly<LabelCollisionFormalRepeatabilityRun>[];
  readonly aggregate: LabelCollisionRepeatabilityRendererSummary["aggregate"];
  readonly invariants: Readonly<{
    exactlyThreeRuns: boolean;
    isolatedCandidateArtifacts: boolean;
    everyRunCurrentCandidate: boolean;
    everyRunProvenanceValid: boolean;
    submittedGlyphsMatchLabels: boolean;
    selectionHashStable: boolean;
    accountingPassed: boolean;
    budgetsPassed: boolean;
    wholeFrameBudgetPassed: boolean;
  }>;
}

export interface LabelCollisionFormalRepeatabilityArtifact {
  readonly schemaVersion: typeof LABEL_COLLISION_FORMAL_REPEATABILITY_SCHEMA_VERSION;
  readonly kind: "pixi-glyphflow-label-collision-repeatability";
  readonly capturedAt: string;
  readonly packageVersion: typeof LABEL_COLLISION_PACKAGE_VERSION;
  readonly workload: "label-collision";
  readonly runtime: Readonly<BenchmarkRuntime>;
  readonly configuration: Readonly<{
    residentLabels: 1_000_000;
    warmupFrames: 5;
    sampleFrames: 120;
    runsPerRenderer: 3;
    wholeFrameBudgetMs: 16.67;
  }>;
  readonly provenance: Readonly<{
    buildFingerprintSha256: string | null;
    harnessFingerprintSha256: string | null;
    runtimeFingerprintSha256: string | null;
  }>;
  readonly renderers: Readonly<{
    webgl: Readonly<LabelCollisionFormalRepeatabilityRendererSummary>;
    webgpu: Readonly<LabelCollisionFormalRepeatabilityRendererSummary>;
  }>;
  readonly invariants: Readonly<{
    exactlySixRuns: boolean;
    isolatedCandidateArtifacts: boolean;
    everyRunCurrentCandidate: boolean;
    everyRunProvenanceValid: boolean;
    uniqueRunIds: boolean;
    uniqueEvidenceSha256: boolean;
    uniqueCapturedAt: boolean;
    uniqueSampleCapturedAt: boolean;
    buildFingerprintStable: boolean;
    harnessFingerprintStable: boolean;
    runtimeFingerprintStable: boolean;
    selectionHashStable: boolean;
    submittedStateStable: boolean;
    everyRunAccountingPassed: boolean;
    everyRunBudgetPassed: boolean;
    webgpuWholeFrameBudgetPassed: boolean;
    allPassed: boolean;
  }>;
  readonly gate: Readonly<{
    status: "GO" | "PAUSE";
    reasons: readonly string[];
  }>;
}

/** Aggregate six independently sealed schema 7 candidates into the formal repeatability gate. */
export function aggregateLabelCollisionRepeatability(
  inputs: readonly Readonly<LabelCollisionRawCandidateInput>[],
  capturedAt: string,
  currentIdentity: Readonly<CurrentBrowserBenchmarkArtifactIdentity>,
): Readonly<LabelCollisionFormalRepeatabilityArtifact> {
  assertCanonicalAggregateTimestamp(inputs, capturedAt);
  const summarized = inputs.map((input) => summarizeRawCandidate(input, currentIdentity));
  const webgl = summarizeFormalRenderer(
    "webgl",
    summarized.filter((run) => run.renderer === "webgl"),
  );
  const webgpu = summarizeFormalRenderer(
    "webgpu",
    summarized.filter((run) => run.renderer === "webgpu"),
  );
  const runs = [...webgl.runs, ...webgpu.runs];
  const exactlySixRuns =
    runs.length === LABEL_COLLISION_REPEATABILITY_RUNS_PER_RENDERER * 2 &&
    webgl.invariants.exactlyThreeRuns &&
    webgpu.invariants.exactlyThreeRuns;
  const isolatedCandidateArtifacts =
    exactlySixRuns &&
    uniquePresent(runs.map((run) => run.artifactFile)) &&
    uniquePresent(runs.map((run) => run.candidateSha256)) &&
    runs.every((run) => SHA256.test(run.candidateSha256));
  const everyRunCurrentCandidate = runs.every((run) => run.currentCandidate);
  const everyRunProvenanceValid = runs.every((run) => run.provenanceValid);
  const uniqueRunIds = uniquePresent(runs.map((run) => run.runId));
  const uniqueEvidenceSha256 = uniquePresent(runs.map((run) => run.evidenceSha256));
  const uniqueCapturedAt = uniquePresent(runs.map((run) => run.capturedAt));
  const uniqueSampleCapturedAt = uniquePresent(runs.map((run) => run.sampleCapturedAt));
  const buildFingerprintSha256 = runs[0]?.buildFingerprintSha256 ?? null;
  const buildFingerprintStable = stableFingerprint(
    runs.map((run) => run.buildFingerprintSha256),
    exactlySixRuns,
  );
  const harnessFingerprintSha256 = runs[0]?.harnessFingerprintSha256 ?? null;
  const harnessFingerprintStable = stableFingerprint(
    runs.map((run) => run.harnessFingerprintSha256),
    exactlySixRuns,
  );
  const runtimeFingerprintSha256 = runs[0]?.runtimeFingerprintSha256 ?? null;
  const runtimeFingerprintStable = stableFingerprint(
    runs.map((run) => run.runtimeFingerprintSha256),
    exactlySixRuns,
  );
  const firstRun = runs[0];
  const selectionHashStable =
    exactlySixRuns &&
    firstRun !== undefined &&
    firstRun.selectionHash > 0 &&
    runs.every((run) => run.selectionHash === firstRun.selectionHash);
  const submittedStateStable =
    exactlySixRuns &&
    firstRun !== undefined &&
    runs.every(
      (run) =>
        run.submittedLabels === firstRun.submittedLabels &&
        run.submittedGlyphs === firstRun.submittedGlyphs,
    );
  const everyRunAccountingPassed = runs.every((run) => run.accountingPassed);
  const everyRunBudgetPassed = runs.every((run) => run.budgetPassed);
  const webgpuWholeFrameBudgetPassed = webgpu.invariants.wholeFrameBudgetPassed;
  const baseInvariants = {
    exactlySixRuns,
    isolatedCandidateArtifacts,
    everyRunCurrentCandidate,
    everyRunProvenanceValid,
    uniqueRunIds,
    uniqueEvidenceSha256,
    uniqueCapturedAt,
    uniqueSampleCapturedAt,
    buildFingerprintStable,
    harnessFingerprintStable,
    runtimeFingerprintStable,
    selectionHashStable,
    submittedStateStable,
    everyRunAccountingPassed,
    everyRunBudgetPassed,
    webgpuWholeFrameBudgetPassed,
  } as const;
  const allPassed = Object.values(baseInvariants).every(Boolean);
  const reasons: string[] = [];
  if (!exactlySixRuns) reasons.push("six-runs");
  if (!isolatedCandidateArtifacts) reasons.push("candidate-artifacts");
  if (!everyRunCurrentCandidate) reasons.push("current-candidate");
  if (!everyRunProvenanceValid) reasons.push("provenance");
  if (!uniqueRunIds || !uniqueEvidenceSha256 || !uniqueCapturedAt || !uniqueSampleCapturedAt) {
    reasons.push("run-identity");
  }
  if (!buildFingerprintStable) reasons.push("build-fingerprint");
  if (!harnessFingerprintStable) reasons.push("harness-fingerprint");
  if (!runtimeFingerprintStable) reasons.push("runtime-fingerprint");
  if (!selectionHashStable || !submittedStateStable) reasons.push("output-identity");
  if (!everyRunAccountingPassed) reasons.push("accounting");
  if (!everyRunBudgetPassed) reasons.push("budget");
  if (!webgpuWholeFrameBudgetPassed) reasons.push("webgpu-whole-frame");

  return Object.freeze({
    schemaVersion: LABEL_COLLISION_FORMAL_REPEATABILITY_SCHEMA_VERSION,
    kind: "pixi-glyphflow-label-collision-repeatability",
    capturedAt,
    packageVersion: LABEL_COLLISION_PACKAGE_VERSION,
    workload: "label-collision",
    runtime: Object.freeze({ ...(inputs[0]?.artifact.runtime ?? emptyBenchmarkRuntime()) }),
    configuration: Object.freeze({
      residentLabels: 1_000_000,
      warmupFrames: 5,
      sampleFrames: 120,
      runsPerRenderer: LABEL_COLLISION_REPEATABILITY_RUNS_PER_RENDERER,
      wholeFrameBudgetMs: LABEL_COLLISION_WHOLE_FRAME_BUDGET_MS,
    }),
    provenance: Object.freeze({
      buildFingerprintSha256: buildFingerprintStable ? buildFingerprintSha256 : null,
      harnessFingerprintSha256: harnessFingerprintStable ? harnessFingerprintSha256 : null,
      runtimeFingerprintSha256: runtimeFingerprintStable ? runtimeFingerprintSha256 : null,
    }),
    renderers: Object.freeze({ webgl, webgpu }),
    invariants: Object.freeze({ ...baseInvariants, allPassed }),
    gate: Object.freeze({
      status: allPassed ? "GO" : "PAUSE",
      reasons: Object.freeze(reasons),
    }),
  });
}

function summarizeRawCandidate(
  input: Readonly<LabelCollisionRawCandidateInput>,
  currentIdentity: Readonly<CurrentBrowserBenchmarkArtifactIdentity>,
): Readonly<Omit<LabelCollisionFormalRepeatabilityRun, "index">> {
  const artifact = input.artifact;
  const sample = artifact.samples[0];
  const renderer = artifact.renderer;
  const provenanceValid = verifyBrowserBenchmarkArtifactEvidence(artifact);
  const currentBudget = evaluateLabelCollisionBudget(artifact.samples, renderer);
  const budgetSealValid =
    artifact.budget !== undefined &&
    JSON.stringify(artifact.budget) === JSON.stringify(currentBudget);
  const accountingPassed =
    sample?.invariants.collisionAccountingExact === true &&
    currentBudget.checks.some((check) => check.name === "candidate-accounting" && check.passed);
  const wholeFrameBudgetPassed =
    renderer === "webgl" ||
    (sample !== undefined &&
      sample.timings.frameMs.length === 120 &&
      summarize(sample.timings.frameMs, "ms").p95 <= LABEL_COLLISION_WHOLE_FRAME_BUDGET_MS);
  const capturedAtValid = canonicalIsoTimestamp(artifact.capturedAt);
  const sampleCapturedAt = sample?.capturedAt ?? null;
  const sampleCapturedAtValid = canonicalIsoTimestamp(sampleCapturedAt);
  const sampleCapturedAtOrdered =
    capturedAtValid &&
    sampleCapturedAtValid &&
    Date.parse(sampleCapturedAt ?? "") <= Date.parse(artifact.capturedAt);
  const currentHarnessManifest =
    artifact.provenance.harnessManifest.length === BROWSER_BENCHMARK_HARNESS_PATHS.length &&
    artifact.provenance.harnessManifest.every(
      (entry, index) => entry.path === BROWSER_BENCHMARK_HARNESS_PATHS[index],
    );
  const currentCandidate =
    artifact.schemaVersion === BENCHMARK_SCHEMA_VERSION &&
    artifact.packageVersion === LABEL_COLLISION_PACKAGE_VERSION &&
    artifact.workload === "label-collision" &&
    artifact.status === "complete" &&
    artifact.artifactRole === "candidate" &&
    artifact.exploratory !== true &&
    currentHarnessManifest &&
    artifact.provenance.buildFingerprintSha256 === currentIdentity.buildFingerprintSha256 &&
    artifact.provenance.harnessFingerprintSha256 === currentIdentity.harnessFingerprintSha256 &&
    artifact.samples.length === 1 &&
    sample?.schemaVersion === BENCHMARK_SCHEMA_VERSION &&
    sample.configuration.fixture === "glyphflow" &&
    sample.configuration.workload === "label-collision" &&
    sample.configuration.renderer === renderer &&
    sample.configuration.labelCount === 1_000_000 &&
    sample.configuration.warmupFrames === 5 &&
    sample.configuration.sampleFrames === 120 &&
    sample.timings.frameMs.length === 120 &&
    sample.timings.cpuMs?.length === 120 &&
    sample.timings.commitMs?.length === 120 &&
    sample.timings.cullingMs?.length === 120 &&
    capturedAtValid &&
    sampleCapturedAtValid &&
    sampleCapturedAtOrdered;
  const frameMs = timingSummary(sample?.timings.frameMs);
  const cpuMs = timingSummary(sample?.timings.cpuMs);
  const commitMs = timingSummary(sample?.timings.commitMs);
  const collisionMs = timingSummary(sample?.timings.cullingMs);
  const submittedLabels = sample?.counters.submittedLabels ?? -1;
  const submittedGlyphs = sample?.counters.submittedGlyphs ?? -1;
  const selectionHash = sample?.counters.collisionSelectionHash ?? -1;
  const budgetPassed = budgetSealValid && currentBudget.passed;
  const failures: string[] = [];
  if (!provenanceValid) failures.push("provenance");
  if (!currentCandidate) failures.push("current-candidate");
  if (!budgetSealValid) failures.push("budget-seal");
  if (!currentBudget.passed) failures.push("budget");
  if (!accountingPassed) failures.push("accounting");
  if (!wholeFrameBudgetPassed) failures.push("webgpu-whole-frame");
  const run: Omit<LabelCollisionFormalRepeatabilityRun, "index"> = {
    renderer,
    artifactFile: input.artifactFile,
    candidateSha256: input.candidateSha256,
    capturedAt: artifact.capturedAt,
    sampleCapturedAt,
    runId: artifact.provenance?.runId ?? null,
    buildFingerprintSha256: artifact.provenance?.buildFingerprintSha256 ?? null,
    harnessFingerprintSha256: artifact.provenance?.harnessFingerprintSha256 ?? null,
    evidenceSha256: artifact.provenance?.evidenceSha256 ?? null,
    runtimeFingerprintSha256: runtimeFingerprint(artifact),
    provenanceValid,
    currentCandidate,
    budgetSealValid,
    timings: Object.freeze({ frameMs, cpuMs, commitMs, collisionMs }),
    submittedLabels,
    submittedGlyphs,
    selectionHash,
    accountingPassed,
    budgetPassed,
    wholeFrameBudgetPassed,
    failures: Object.freeze(failures),
    eligible:
      provenanceValid &&
      currentCandidate &&
      budgetPassed &&
      accountingPassed &&
      wholeFrameBudgetPassed,
  };
  assertFormalRun({ ...run, index: 1 });
  return Object.freeze(run);
}

function summarizeFormalRenderer(
  renderer: BrowserBenchmarkRenderer,
  candidates: readonly Readonly<Omit<LabelCollisionFormalRepeatabilityRun, "index">>[],
): Readonly<LabelCollisionFormalRepeatabilityRendererSummary> {
  const runs = Object.freeze(
    candidates.map((candidate, index) => Object.freeze({ ...candidate, index: index + 1 })),
  );
  const exactlyThreeRuns =
    runs.length === LABEL_COLLISION_REPEATABILITY_RUNS_PER_RENDERER &&
    runs.every((run) => run.renderer === renderer);
  const isolatedCandidateArtifacts =
    exactlyThreeRuns &&
    uniquePresent(runs.map((run) => run.artifactFile)) &&
    uniquePresent(runs.map((run) => run.candidateSha256)) &&
    runs.every((run) => SHA256.test(run.candidateSha256));
  const firstHash = runs[0]?.selectionHash ?? 0;
  const wholeFrameBudgetPassed = runs.every((run) => run.wholeFrameBudgetPassed);
  const values = (read: (run: Readonly<LabelCollisionFormalRepeatabilityRun>) => number) =>
    runs.map(read);
  return Object.freeze({
    sourceCandidateArtifact: runs[0]?.artifactFile ?? "",
    sourceCandidateArtifacts: Object.freeze(
      runs.map((run) =>
        Object.freeze({ artifactFile: run.artifactFile, sha256: run.candidateSha256 }),
      ),
    ),
    runs,
    aggregate: Object.freeze({
      frameP50Ms: metric(values((run) => run.timings.frameMs.p50)),
      frameP95Ms: metric(values((run) => run.timings.frameMs.p95)),
      cpuP50Ms: metric(values((run) => run.timings.cpuMs.p50)),
      cpuP95Ms: metric(values((run) => run.timings.cpuMs.p95)),
      commitP50Ms: metric(values((run) => run.timings.commitMs.p50)),
      commitP95Ms: metric(values((run) => run.timings.commitMs.p95)),
      collisionP50Ms: metric(values((run) => run.timings.collisionMs.p50)),
      collisionP95Ms: metric(values((run) => run.timings.collisionMs.p95)),
    }),
    invariants: Object.freeze({
      exactlyThreeRuns,
      isolatedCandidateArtifacts,
      everyRunCurrentCandidate: runs.every((run) => run.currentCandidate),
      everyRunProvenanceValid: runs.every((run) => run.provenanceValid),
      submittedGlyphsMatchLabels: runs.every(
        (run) => run.submittedGlyphs === run.submittedLabels * 8,
      ),
      selectionHashStable: firstHash > 0 && runs.every((run) => run.selectionHash === firstHash),
      accountingPassed: runs.every((run) => run.accountingPassed),
      budgetsPassed: runs.every((run) => run.budgetPassed),
      wholeFrameBudgetPassed,
    }),
  });
}

function assertFormalRun(run: Readonly<LabelCollisionFormalRepeatabilityRun>): void {
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

function timingSummary(
  values: readonly number[] | undefined,
): Readonly<LabelCollisionRepeatabilityTiming> {
  if (values === undefined || values.length === 0) return Object.freeze({ p50: -1, p95: -1 });
  const distribution = summarize(values, "ms");
  return Object.freeze({ p50: round6(distribution.p50), p95: round6(distribution.p95) });
}

function runtimeFingerprint(artifact: Readonly<BrowserBenchmarkArtifact>): string | null {
  const sample = artifact.samples[0];
  const runtime = artifact.runtime;
  if (
    sample === undefined ||
    sample.userAgent.trim().length === 0 ||
    Object.values(runtime).some((value) => value.trim().length === 0)
  ) {
    return null;
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        bun: runtime.bun,
        cpu: runtime.cpu,
        platform: runtime.platform,
        release: runtime.release,
        architecture: runtime.architecture,
        userAgent: sample.userAgent,
      }),
    )
    .digest("hex");
}

function stableFingerprint(values: readonly (string | null)[], exactCount: boolean): boolean {
  const first = values[0];
  return (
    exactCount && first !== undefined && first !== null && values.every((value) => value === first)
  );
}

function uniquePresent(values: readonly (string | null)[]): boolean {
  return (
    values.length > 0 &&
    values.every((value) => value !== null && value.length > 0) &&
    new Set(values).size === values.length
  );
}

function canonicalIsoTimestamp(value: string | null): boolean {
  if (value === null) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function assertCanonicalAggregateTimestamp(
  inputs: readonly Readonly<LabelCollisionRawCandidateInput>[],
  capturedAt: string,
): void {
  if (!canonicalIsoTimestamp(capturedAt)) {
    throw new TypeError(
      "Label collision repeatability capturedAt must be a canonical ISO timestamp",
    );
  }
  const capturedTime = Date.parse(capturedAt);
  if (inputs.some((input) => Date.parse(input.artifact.capturedAt) > capturedTime)) {
    throw new RangeError(
      "Label collision repeatability capturedAt must follow every input artifact",
    );
  }
}

function emptyBenchmarkRuntime(): BenchmarkRuntime {
  return { bun: "", cpu: "", platform: "", release: "", architecture: "" };
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

export async function runLabelCollisionRepeatabilityCli(
  rawArgs: readonly string[] = Bun.argv.slice(2),
): Promise<Readonly<LabelCollisionFormalRepeatabilityArtifact>> {
  const args = [...rawArgs];
  const outputIndex = args.indexOf("--output");
  const output = outputIndex < 0 ? undefined : args[outputIndex + 1];
  if (outputIndex >= 0) {
    if (output === undefined || output.startsWith("--")) {
      throw new TypeError("Label collision repeatability --output requires a path");
    }
    args.splice(outputIndex, 2);
  }
  if (args.some((argument) => argument.startsWith("--"))) {
    throw new TypeError("Label collision repeatability received an unknown option");
  }
  const expectedInputs = LABEL_COLLISION_REPEATABILITY_RUNS_PER_RENDERER * 2;
  if (args.length !== expectedInputs) {
    throw new RangeError(
      `Label collision repeatability requires exactly ${String(expectedInputs)} raw candidate artifacts`,
    );
  }

  const inputs: LabelCollisionRawCandidateInput[] = [];
  for (const path of args) {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    inputs.push({
      artifactFile: basename(path),
      candidateSha256: createHash("sha256").update(bytes).digest("hex"),
      artifact: JSON.parse(new TextDecoder().decode(bytes)) as BrowserBenchmarkArtifact,
    });
  }
  const currentIdentity = await createCurrentBrowserBenchmarkArtifactIdentity(
    resolve(import.meta.dir, ".."),
  );
  const artifact = aggregateLabelCollisionRepeatability(
    inputs,
    new Date().toISOString(),
    currentIdentity,
  );
  const outputPath = resolve(
    output ??
      `benchmarks/results/browser-label-collision-repeatability-${artifact.packageVersion}.json`,
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  console.log(
    JSON.stringify({
      outputPath,
      status: artifact.gate.status,
      reasons: artifact.gate.reasons,
    }),
  );
  if (artifact.gate.status !== "GO") process.exitCode = 1;
  return artifact;
}

if (import.meta.main) await runLabelCollisionRepeatabilityCli();
