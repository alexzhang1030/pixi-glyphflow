import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { verifyBrowserBenchmarkArtifactEvidence } from "./artifacts";
import {
  GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES,
  evaluateGpuSceneResidentBudget,
  evaluateGpuSceneResidentSustained600Budget,
} from "./gpu-scene-resident-budget";
import {
  GPU_SCENE_RESIDENT_CANONICAL_TRUTH,
  evaluateGpuSceneResidentOutputTruth,
  resolveGpuSceneResidentOutputTruth,
} from "./gpu-scene-resident-truth";
import {
  BENCHMARK_SCHEMA_VERSION,
  browserGpuAdapterIdentityEqual,
  isCompleteBrowserGpuAdapterIdentity,
  summarize,
  type BrowserBenchmarkArtifact,
  type BrowserBenchmarkPhaseTimings,
  type BrowserGpuAdapterIdentity,
} from "./schema";

export const GPU_SCENE_RESIDENT_REPEATABILITY_SCHEMA_VERSION: number = 4;
export const GPU_SCENE_RESIDENT_PROMOTION_RUNS: number = 5;
const FRAME_BUDGET_MS = 16.67;
const SHA256 = /^[0-9a-f]{64}$/;

export interface GpuSceneResidentRepeatabilityInput {
  readonly run: number;
  readonly artifactFile: string;
  readonly candidateSha256: string;
  readonly artifact: Readonly<BrowserBenchmarkArtifact>;
}

export interface GpuSceneResidentSustainedInput {
  readonly artifactFile: string;
  readonly candidateSha256: string;
  readonly artifact: Readonly<BrowserBenchmarkArtifact>;
}

export interface GpuSceneResidentPhaseSummary {
  readonly samples: number;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly maxMs: number | null;
  readonly overBudgetCount: number;
  readonly overBudgetRatio: number;
}

export interface GpuSceneResidentTimestampSummary {
  readonly readbackSubmissions: number;
  readonly fusedTimestampResolves: number;
  readonly standaloneTimestampSubmissions: number;
  readonly timingSamples: number;
  readonly timingFusedTimestampResolves: number;
  readonly timingStandaloneTimestampSubmissions: number;
  readonly validSamples: number;
  readonly segmentedSamples: number;
  readonly validSegmentedSamples: number;
  readonly segmentedFallbackSamples: number;
  readonly segments: Readonly<GpuSceneResidentTimestampSegments>;
  readonly segmentedExact: boolean;
}

export interface GpuSceneResidentTimestampSegmentSummary {
  readonly samples: number;
  readonly validSamples: number;
  readonly arraySamples: number;
  readonly arrayValidSamples: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}

export interface GpuSceneResidentTimestampSegments {
  readonly palette: Readonly<GpuSceneResidentTimestampSegmentSummary>;
  readonly cull: Readonly<GpuSceneResidentTimestampSegmentSummary>;
  readonly sceneRender: Readonly<GpuSceneResidentTimestampSegmentSummary>;
}

export interface GpuSceneResidentRuntimeFingerprint {
  readonly sha256: string;
  readonly bun: string;
  readonly cpu: string;
  readonly platform: string;
  readonly release: string;
  readonly architecture: string;
  readonly userAgent: string;
  readonly gpuAdapter: Readonly<BrowserGpuAdapterIdentity>;
}

interface GpuSceneResidentProvenanceIdentity {
  readonly runId: string | null;
  readonly buildFingerprintSha256: string | null;
  readonly harnessFingerprintSha256: string | null;
  readonly evidenceSha256: string | null;
}

interface GpuSceneResidentSustainedTruthContext {
  readonly runtimeFingerprint: Readonly<GpuSceneResidentRuntimeFingerprint> | null;
  readonly buildFingerprintSha256: string | null;
  readonly harnessFingerprintSha256: string | null;
  readonly runIds: ReadonlySet<string>;
  readonly capturedAt: ReadonlySet<string>;
  readonly sampleCapturedAt: ReadonlySet<string>;
  readonly evidenceSha256: ReadonlySet<string>;
}

export interface GpuSceneResidentRepeatabilityRun {
  readonly run: number;
  readonly artifactFile: string;
  readonly candidateSha256: string;
  readonly capturedAt: string;
  readonly capturedAtValid: boolean;
  readonly sampleCapturedAt: string | null;
  readonly sampleCapturedAtValid: boolean;
  readonly sampleCapturedAtNotAfterArtifact: boolean;
  readonly runId: string | null;
  readonly buildFingerprintSha256: string | null;
  readonly harnessFingerprintSha256: string | null;
  readonly evidenceSha256: string | null;
  readonly provenanceValid: boolean;
  readonly packageVersion: string;
  readonly packageVersionExact: boolean;
  readonly runtimeFingerprint: Readonly<GpuSceneResidentRuntimeFingerprint> | null;
  readonly runtimeFingerprintComplete: boolean;
  readonly budgetPassed: boolean;
  readonly budgetFailures: readonly string[];
  readonly exactFormalArtifact: boolean;
  readonly exactCanonicalOutput: boolean;
  readonly outputIdentity: Readonly<{
    submittedGlyphs: number;
    submittedGlyphsHash: number;
    submittedGlyphsHashSource: string;
    renderedPixelHash: number;
    nonTransparentPixels: number;
  }>;
  readonly camera: Readonly<GpuSceneResidentPhaseSummary>;
  readonly positionMutation: Readonly<GpuSceneResidentPhaseSummary>;
  readonly timestamps: Readonly<GpuSceneResidentTimestampSummary>;
  readonly failures: readonly string[];
  readonly eligible: boolean;
}

export interface GpuSceneResidentSustainedEvaluation {
  readonly artifactFile: string;
  readonly candidateSha256: string;
  readonly capturedAt: string;
  readonly capturedAtValid: boolean;
  readonly sampleCapturedAt: string | null;
  readonly sampleCapturedAtValid: boolean;
  readonly sampleCapturedAtNotAfterArtifact: boolean;
  readonly sampleCapturedAtDistinctFromTruthRuns: boolean;
  readonly runId: string | null;
  readonly buildFingerprintSha256: string | null;
  readonly harnessFingerprintSha256: string | null;
  readonly evidenceSha256: string | null;
  readonly provenanceValid: boolean;
  readonly buildFingerprintMatchesTruthRuns: boolean;
  readonly harnessFingerprintMatchesTruthRuns: boolean;
  readonly runIdentityDistinctFromTruthRuns: boolean;
  readonly packageVersion: string;
  readonly packageVersionExact: boolean;
  readonly runtimeFingerprint: Readonly<GpuSceneResidentRuntimeFingerprint> | null;
  readonly runtimeFingerprintComplete: boolean;
  readonly runtimeFingerprintMatchesTruthRuns: boolean;
  readonly exactSustainedArtifact: boolean;
  readonly budgetPassed: boolean;
  readonly budgetFailures: readonly string[];
  readonly exactCanonicalOutput: boolean;
  readonly outputIdentity: Readonly<{
    submittedGlyphs: number;
    submittedGlyphsHash: number;
    submittedGlyphsHashSource: string;
    renderedPixelHash: number;
    nonTransparentPixels: number;
  }>;
  readonly camera: Readonly<GpuSceneResidentPhaseSummary>;
  readonly positionMutation: Readonly<GpuSceneResidentPhaseSummary>;
  readonly uploads: Readonly<{
    cameraTransformMaxBytes: number;
    cameraCullRecordMaxBytes: number;
    positionTransformMinBytes: number;
    positionTransformMaxBytes: number;
    positionTransformExactSamples: number;
    positionCullRecordMaxBytes: number;
  }>;
  readonly timestamps: Readonly<GpuSceneResidentTimestampSummary>;
  readonly failures: readonly string[];
  readonly eligible: boolean;
}

export interface GpuSceneResidentRepeatabilityArtifact {
  readonly schemaVersion: typeof GPU_SCENE_RESIDENT_REPEATABILITY_SCHEMA_VERSION;
  readonly kind: "pixi-glyphflow-gpu-scene-resident-repeatability";
  readonly capturedAt: string;
  readonly packageVersion: string;
  readonly workload: "gpu-scene-resident";
  readonly renderer: "webgpu";
  readonly canonicalCandidate: Readonly<{
    artifact: string;
    packageVersion: string;
    sha256: string;
  }>;
  readonly configuration: Readonly<{
    labelCount: number;
    mutationCount: number;
    warmupFrames: number;
    cameraSampleFrames: number;
    positionSampleFrames: number;
    width: number;
    height: number;
  }>;
  readonly canonicalOutputIdentity: Readonly<{
    submittedGlyphs: number;
    submittedGlyphsHash: number;
    renderedPixelHash: number;
    nonTransparentPixels: number;
  }>;
  readonly runtimeFingerprint: Readonly<GpuSceneResidentRuntimeFingerprint> | null;
  readonly buildFingerprintSha256: string | null;
  readonly harnessFingerprintSha256: string | null;
  readonly runs: readonly Readonly<GpuSceneResidentRepeatabilityRun>[];
  readonly sustained600?: Readonly<GpuSceneResidentSustainedEvaluation>;
  readonly summary: Readonly<{
    runCount: number;
    uniqueCandidateShaCount: number;
    outputIdentityStable: boolean;
    camera: Readonly<GpuSceneResidentPhaseSummary>;
    positionMutation: Readonly<GpuSceneResidentPhaseSummary>;
    timestamps: Readonly<{
      readbackSubmissions: number;
      fusedTimestampResolves: number;
      standaloneTimestampSubmissions: number;
      timingSamples: number;
      timingFusedTimestampResolves: number;
      timingStandaloneTimestampSubmissions: number;
      validSamples: number;
      segmentedSamples: number;
      validSegmentedSamples: number;
      segmentedFallbackSamples: number;
      segments: Readonly<GpuSceneResidentTimestampSegments>;
      segmentedExact: boolean;
    }>;
  }>;
  readonly invariants: Readonly<{
    exactlyFiveRuns: boolean;
    isolatedCandidateArtifacts: boolean;
    everyRunProvenanceValid: boolean;
    uniqueRunIds: boolean;
    uniqueCapturedAt: boolean;
    everyRunCapturedAtValid: boolean;
    everyRunSampleCapturedAtValid: boolean;
    everyRunSampleCapturedAtNotAfterArtifact: boolean;
    uniqueSampleCapturedAt: boolean;
    uniqueEvidenceSha256: boolean;
    buildFingerprintStable: boolean;
    harnessFingerprintStable: boolean;
    everyRunPackageVersionExact: boolean;
    everyRunRuntimeFingerprintComplete: boolean;
    runtimeFingerprintStable: boolean;
    everyRunFormal: boolean;
    everyRunBudgetPassed: boolean;
    everyRunCanonicalOutput: boolean;
    outputIdentityStable: boolean;
    everyRunTimingComplete: boolean;
    everyRunTimestampExact: boolean;
    everyRunSegmentedTimestampExact: boolean;
    truthRepeatabilityReady: boolean;
    formalPerformanceReady: boolean;
    sustained600Ready: boolean;
    promotionReady: boolean;
  }>;
  readonly truthRepeatability: Readonly<{
    status: "GO" | "PAUSE";
    reasons: readonly string[];
  }>;
  readonly promotion: Readonly<{
    status: "GO" | "PAUSE";
    reasons: readonly string[];
  }>;
}

export function aggregateGpuSceneResidentRepeatability(
  inputs: readonly Readonly<GpuSceneResidentRepeatabilityInput>[],
  capturedAt: string,
  sustainedInput?: Readonly<GpuSceneResidentSustainedInput>,
): Readonly<GpuSceneResidentRepeatabilityArtifact> {
  assertRepeatabilityCapturedAt(inputs, capturedAt, sustainedInput);
  const ordered = [...inputs].sort((left, right) => left.run - right.run);
  const runs = ordered.map((input) => summarizeRun(input));
  const uniqueCandidateShaCount = new Set(runs.map((run) => run.candidateSha256)).size;
  const exactlyFiveRuns = runs.length === GPU_SCENE_RESIDENT_PROMOTION_RUNS;
  const isolatedCandidateArtifacts =
    exactlyFiveRuns &&
    uniqueCandidateShaCount === GPU_SCENE_RESIDENT_PROMOTION_RUNS &&
    runs.every((run) => SHA256.test(run.candidateSha256));
  const everyRunProvenanceValid = runs.every((run) => run.provenanceValid);
  const uniqueRunIds = uniqueRunIdentity(runs.map((run) => run.runId));
  const uniqueCapturedAt = uniqueRunIdentity(runs.map((run) => run.capturedAt));
  const everyRunCapturedAtValid = runs.every((run) => run.capturedAtValid);
  const everyRunSampleCapturedAtValid = runs.every((run) => run.sampleCapturedAtValid);
  const everyRunSampleCapturedAtNotAfterArtifact = runs.every(
    (run) => run.sampleCapturedAtNotAfterArtifact,
  );
  const uniqueSampleCapturedAt = uniqueRunIdentity(runs.map((run) => run.sampleCapturedAt));
  const uniqueEvidenceSha256 = uniqueRunIdentity(runs.map((run) => run.evidenceSha256));
  const buildFingerprintSha256 = runs[0]?.buildFingerprintSha256 ?? null;
  const buildFingerprintStable =
    exactlyFiveRuns &&
    buildFingerprintSha256 !== null &&
    runs.every((run) => run.buildFingerprintSha256 === buildFingerprintSha256);
  const harnessFingerprintSha256 = runs[0]?.harnessFingerprintSha256 ?? null;
  const harnessFingerprintStable =
    exactlyFiveRuns &&
    harnessFingerprintSha256 !== null &&
    runs.every((run) => run.harnessFingerprintSha256 === harnessFingerprintSha256);
  const everyRunPackageVersionExact = runs.every((run) => run.packageVersionExact);
  const everyRunRuntimeFingerprintComplete = runs.every((run) => run.runtimeFingerprintComplete);
  const runtimeFingerprint = runs[0]?.runtimeFingerprint ?? null;
  const runtimeFingerprintStable =
    exactlyFiveRuns &&
    runtimeFingerprint !== null &&
    runs.every((run) => run.runtimeFingerprint?.sha256 === runtimeFingerprint.sha256);
  const everyRunFormal = runs.every((run) => run.exactFormalArtifact);
  const everyRunBudgetPassed = runs.every((run) => run.budgetPassed);
  const everyRunCanonicalOutput = runs.every((run) => run.exactCanonicalOutput);
  const outputIdentityStable = stableOutputIdentity(runs);
  const everyRunTimingComplete = runs.every(
    (run) => run.camera.samples === 120 && run.positionMutation.samples === 120,
  );
  const everyRunTimestampExact = runs.every((run) => timestampExact(run.timestamps));
  const everyRunSegmentedTimestampExact = runs.every((run) => run.timestamps.segmentedExact);
  const truthReasons: string[] = [];
  if (!exactlyFiveRuns) truthReasons.push("five-runs");
  if (!isolatedCandidateArtifacts) truthReasons.push("candidate-sha");
  if (!everyRunPackageVersionExact) truthReasons.push("package-version");
  if (!everyRunRuntimeFingerprintComplete || !runtimeFingerprintStable) {
    truthReasons.push("runtime-fingerprint");
  }
  if (!everyRunProvenanceValid) truthReasons.push("provenance");
  if (
    !uniqueRunIds ||
    !uniqueCapturedAt ||
    !everyRunCapturedAtValid ||
    !everyRunSampleCapturedAtValid ||
    !everyRunSampleCapturedAtNotAfterArtifact ||
    !uniqueSampleCapturedAt ||
    !uniqueEvidenceSha256
  ) {
    truthReasons.push("run-identity");
  }
  if (!buildFingerprintStable) truthReasons.push("build-fingerprint");
  if (!harnessFingerprintStable) truthReasons.push("harness-fingerprint");
  if (!everyRunFormal || !everyRunTimingComplete || !everyRunTimestampExact) {
    truthReasons.push("run-gates");
  }
  if (!everyRunSegmentedTimestampExact) truthReasons.push("timestamp-segments");
  if (!everyRunCanonicalOutput || !outputIdentityStable) truthReasons.push("output-identity");
  const truthRepeatabilityReady = truthReasons.length === 0;
  const formalPerformanceReady = everyRunBudgetPassed;
  const sustained600 =
    sustainedInput === undefined
      ? undefined
      : summarizeSustained600(sustainedInput, {
          runtimeFingerprint: runtimeFingerprintStable ? runtimeFingerprint : null,
          buildFingerprintSha256: buildFingerprintStable ? buildFingerprintSha256 : null,
          harnessFingerprintSha256: harnessFingerprintStable ? harnessFingerprintSha256 : null,
          runIds: presentValueSet(runs.map((run) => run.runId)),
          capturedAt: presentValueSet(runs.map((run) => run.capturedAt)),
          sampleCapturedAt: presentValueSet(runs.map((run) => run.sampleCapturedAt)),
          evidenceSha256: presentValueSet(runs.map((run) => run.evidenceSha256)),
        });
  const sustained600Ready = sustained600?.eligible === true;
  const promotionReasons: string[] = [];
  if (!truthRepeatabilityReady) promotionReasons.push("truth-repeatability");
  if (!formalPerformanceReady) promotionReasons.push("formal-performance");
  if (!sustained600Ready) promotionReasons.push("sustained-600");
  const promotionReady = promotionReasons.length === 0;
  const cameraFrames = phaseFrames(ordered, "camera");
  const positionFrames = phaseFrames(ordered, "positionMutation");
  const formal = GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal;

  return Object.freeze({
    schemaVersion: GPU_SCENE_RESIDENT_REPEATABILITY_SCHEMA_VERSION,
    kind: "pixi-glyphflow-gpu-scene-resident-repeatability",
    capturedAt,
    packageVersion: GPU_SCENE_RESIDENT_CANONICAL_TRUTH.sourceCandidate.packageVersion,
    workload: "gpu-scene-resident",
    renderer: "webgpu",
    canonicalCandidate: GPU_SCENE_RESIDENT_CANONICAL_TRUTH.sourceCandidate,
    configuration: Object.freeze({
      labelCount: formal.configuration.labelCount,
      mutationCount: formal.configuration.mutationCount,
      warmupFrames: formal.configuration.warmupFrames,
      cameraSampleFrames: formal.configuration.sampleFrames,
      positionSampleFrames: formal.configuration.sampleFrames,
      width: formal.configuration.width,
      height: formal.configuration.height,
    }),
    canonicalOutputIdentity: formal.output,
    runtimeFingerprint,
    buildFingerprintSha256,
    harnessFingerprintSha256,
    runs: Object.freeze(runs),
    ...(sustained600 === undefined ? {} : { sustained600 }),
    summary: Object.freeze({
      runCount: runs.length,
      uniqueCandidateShaCount,
      outputIdentityStable,
      camera: summarizePhaseSamples(cameraFrames),
      positionMutation: summarizePhaseSamples(positionFrames),
      timestamps: Object.freeze({
        readbackSubmissions: sum(runs, (run) => run.timestamps.readbackSubmissions),
        fusedTimestampResolves: sum(runs, (run) => run.timestamps.fusedTimestampResolves),
        standaloneTimestampSubmissions: sum(
          runs,
          (run) => run.timestamps.standaloneTimestampSubmissions,
        ),
        timingFusedTimestampResolves: sum(
          runs,
          (run) => run.timestamps.timingFusedTimestampResolves,
        ),
        timingSamples: sum(runs, (run) => run.timestamps.timingSamples),
        timingStandaloneTimestampSubmissions: sum(
          runs,
          (run) => run.timestamps.timingStandaloneTimestampSubmissions,
        ),
        validSamples: sum(runs, (run) => run.timestamps.validSamples),
        segmentedSamples: sum(runs, (run) => run.timestamps.segmentedSamples),
        validSegmentedSamples: sum(runs, (run) => run.timestamps.validSegmentedSamples),
        segmentedFallbackSamples: sum(runs, (run) => run.timestamps.segmentedFallbackSamples),
        segments: summarizeAggregateTimestampSegments(runs, ordered),
        segmentedExact: everyRunSegmentedTimestampExact,
      }),
    }),
    invariants: Object.freeze({
      exactlyFiveRuns,
      isolatedCandidateArtifacts,
      everyRunProvenanceValid,
      uniqueRunIds,
      uniqueCapturedAt,
      everyRunCapturedAtValid,
      everyRunSampleCapturedAtValid,
      everyRunSampleCapturedAtNotAfterArtifact,
      uniqueSampleCapturedAt,
      uniqueEvidenceSha256,
      buildFingerprintStable,
      harnessFingerprintStable,
      everyRunPackageVersionExact,
      everyRunRuntimeFingerprintComplete,
      runtimeFingerprintStable,
      everyRunFormal,
      everyRunBudgetPassed,
      everyRunCanonicalOutput,
      outputIdentityStable,
      everyRunTimingComplete,
      everyRunTimestampExact,
      everyRunSegmentedTimestampExact,
      truthRepeatabilityReady,
      formalPerformanceReady,
      sustained600Ready,
      promotionReady,
    }),
    truthRepeatability: Object.freeze({
      status: truthRepeatabilityReady ? "GO" : "PAUSE",
      reasons: Object.freeze(truthReasons),
    }),
    promotion: Object.freeze({
      status: promotionReady ? "GO" : "PAUSE",
      reasons: Object.freeze(promotionReasons),
    }),
  });
}

function assertRepeatabilityCapturedAt(
  inputs: readonly Readonly<GpuSceneResidentRepeatabilityInput>[],
  capturedAt: string,
  sustainedInput: Readonly<GpuSceneResidentSustainedInput> | undefined,
): void {
  if (!isCanonicalIsoTimestamp(capturedAt)) {
    throw new TypeError("Repeatability capturedAt must be a canonical ISO timestamp");
  }
  const capturedTimestamp = Date.parse(capturedAt);
  const inputArtifactTimestamps = [
    ...inputs.map((input) => input.artifact.capturedAt),
    ...(sustainedInput === undefined ? [] : [sustainedInput.artifact.capturedAt]),
  ];
  if (
    inputArtifactTimestamps.some(
      (inputCapturedAt) =>
        isCanonicalIsoTimestamp(inputCapturedAt) && Date.parse(inputCapturedAt) > capturedTimestamp,
    )
  ) {
    throw new RangeError(
      "Repeatability capturedAt must be at or after every input artifact timestamp",
    );
  }
}

function summarizeRun(
  input: Readonly<GpuSceneResidentRepeatabilityInput>,
): Readonly<GpuSceneResidentRepeatabilityRun> {
  const sample = input.artifact.samples[0];
  const phases = sample?.timings.phases;
  const camera = summarizePhase(phases?.camera);
  const positionMutation = summarizePhase(phases?.positionMutation);
  const truth =
    sample === undefined
      ? undefined
      : evaluateGpuSceneResidentOutputTruth(sample.configuration, sample.counters);
  const currentBudget = evaluateGpuSceneResidentBudget(input.artifact.samples);
  const provenance = readProvenanceIdentity(input.artifact);
  const provenanceValid = verifyBrowserBenchmarkArtifactEvidence(input.artifact);
  const capturedAtValid = isCanonicalIsoTimestamp(input.artifact.capturedAt);
  const sampleCapturedAt = presentString(sample?.capturedAt) ?? null;
  const sampleCapturedAtValid = isCanonicalIsoTimestamp(sampleCapturedAt);
  const sampleCapturedAtNotAfterArtifact = timestampNotAfter(
    sampleCapturedAt,
    input.artifact.capturedAt,
  );
  const packageVersionExact =
    input.artifact.packageVersion ===
    GPU_SCENE_RESIDENT_CANONICAL_TRUTH.sourceCandidate.packageVersion;
  const runtimeFingerprint = createRuntimeFingerprint(input.artifact, sample);
  const runtimeFingerprintComplete = runtimeFingerprint !== null;
  const exactFormalArtifact =
    sample !== undefined &&
    input.artifact.schemaVersion === BENCHMARK_SCHEMA_VERSION &&
    provenanceValid &&
    capturedAtValid &&
    sampleCapturedAtValid &&
    sampleCapturedAtNotAfterArtifact &&
    input.artifact.benchmark === "browser-workloads" &&
    input.artifact.workload === "gpu-scene-resident" &&
    input.artifact.renderer === "webgpu" &&
    input.artifact.artifactRole === "candidate" &&
    input.artifact.status === "complete" &&
    input.artifact.exploratory !== true &&
    packageVersionExact &&
    runtimeFingerprintComplete &&
    input.artifact.failures.length === 0 &&
    input.artifact.samples.length === 1 &&
    sample.configuration.fixture === "glyphflow" &&
    sample.configuration.workload === "gpu-scene-resident" &&
    sample.configuration.renderer === "webgpu" &&
    resolveGpuSceneResidentOutputTruth(sample.configuration) ===
      GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal;
  const expectedTimestampResolves =
    GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal.telemetry.fusedTimestampResolves;
  const timestamps = timestampSummary(sample, expectedTimestampResolves);
  const failures: string[] = [];
  if (!SHA256.test(input.candidateSha256)) failures.push("candidate-sha256");
  if (!packageVersionExact) failures.push("package-version");
  if (!runtimeFingerprintComplete) failures.push("runtime-fingerprint");
  if (!provenanceValid) failures.push("provenance");
  if (!capturedAtValid) failures.push("captured-at");
  if (!sampleCapturedAtValid) failures.push("sample-captured-at");
  if (!sampleCapturedAtNotAfterArtifact) failures.push("sample-captured-at-order");
  if (!exactFormalArtifact) failures.push("formal-artifact");
  if (!currentBudget.passed) failures.push("budget");
  if (truth?.exactOutputIdentity !== true) failures.push("canonical-output-identity");
  if (camera.samples !== 120 || positionMutation.samples !== 120) {
    failures.push("phase-samples");
  }
  if (!timestampExact(timestamps)) failures.push("timestamp-counters");
  if (!timestamps.segmentedExact) failures.push("timestamp-segments");

  return Object.freeze({
    run: input.run,
    artifactFile: input.artifactFile,
    candidateSha256: input.candidateSha256,
    capturedAt: input.artifact.capturedAt,
    capturedAtValid,
    sampleCapturedAt,
    sampleCapturedAtValid,
    sampleCapturedAtNotAfterArtifact,
    runId: provenance.runId,
    buildFingerprintSha256: provenance.buildFingerprintSha256,
    harnessFingerprintSha256: provenance.harnessFingerprintSha256,
    evidenceSha256: provenance.evidenceSha256,
    provenanceValid,
    packageVersion: input.artifact.packageVersion,
    packageVersionExact,
    runtimeFingerprint,
    runtimeFingerprintComplete,
    budgetPassed: currentBudget.passed,
    budgetFailures: Object.freeze(
      currentBudget.checks.filter((check) => !check.passed).map((check) => check.name),
    ),
    exactFormalArtifact,
    exactCanonicalOutput: truth?.exactOutputIdentity === true,
    outputIdentity: Object.freeze({
      submittedGlyphs: sample?.counters.submittedGlyphs ?? -1,
      submittedGlyphsHash: sample?.counters.submittedGlyphsHash ?? -1,
      submittedGlyphsHashSource: sample?.counters.submittedGlyphsHashSource ?? "missing",
      renderedPixelHash: sample?.counters.renderedPixelHash ?? -1,
      nonTransparentPixels: sample?.counters.nonTransparentPixels ?? -1,
    }),
    camera,
    positionMutation,
    timestamps,
    failures: Object.freeze(failures),
    eligible: failures.length === 0,
  });
}

function summarizeSustained600(
  input: Readonly<GpuSceneResidentSustainedInput>,
  truthContext: Readonly<GpuSceneResidentSustainedTruthContext>,
): Readonly<GpuSceneResidentSustainedEvaluation> {
  const sample = input.artifact.samples[0];
  const phases = sample?.timings.phases;
  const camera = summarizePhase(phases?.camera);
  const positionMutation = summarizePhase(phases?.positionMutation);
  const truth =
    sample === undefined
      ? undefined
      : evaluateGpuSceneResidentOutputTruth(sample.configuration, sample.counters);
  const currentBudget = evaluateGpuSceneResidentSustained600Budget(input.artifact.samples);
  const provenance = readProvenanceIdentity(input.artifact);
  const provenanceValid = verifyBrowserBenchmarkArtifactEvidence(input.artifact);
  const capturedAtValid = isCanonicalIsoTimestamp(input.artifact.capturedAt);
  const sampleCapturedAt = presentString(sample?.capturedAt) ?? null;
  const sampleCapturedAtValid = isCanonicalIsoTimestamp(sampleCapturedAt);
  const sampleCapturedAtNotAfterArtifact = timestampNotAfter(
    sampleCapturedAt,
    input.artifact.capturedAt,
  );
  const sampleCapturedAtDistinctFromTruthRuns =
    sampleCapturedAtValid && !truthContext.sampleCapturedAt.has(sampleCapturedAt);
  const buildFingerprintMatchesTruthRuns =
    provenance.buildFingerprintSha256 !== null &&
    truthContext.buildFingerprintSha256 !== null &&
    provenance.buildFingerprintSha256 === truthContext.buildFingerprintSha256;
  const harnessFingerprintMatchesTruthRuns =
    provenance.harnessFingerprintSha256 !== null &&
    truthContext.harnessFingerprintSha256 !== null &&
    provenance.harnessFingerprintSha256 === truthContext.harnessFingerprintSha256;
  const runIdentityDistinctFromTruthRuns =
    provenance.runId !== null &&
    !truthContext.runIds.has(provenance.runId) &&
    capturedAtValid &&
    sampleCapturedAtNotAfterArtifact &&
    !truthContext.capturedAt.has(input.artifact.capturedAt) &&
    sampleCapturedAtDistinctFromTruthRuns &&
    provenance.evidenceSha256 !== null &&
    !truthContext.evidenceSha256.has(provenance.evidenceSha256);
  const packageVersionExact =
    input.artifact.packageVersion ===
    GPU_SCENE_RESIDENT_CANONICAL_TRUTH.sourceCandidate.packageVersion;
  const runtimeFingerprint = createRuntimeFingerprint(input.artifact, sample);
  const runtimeFingerprintComplete = runtimeFingerprint !== null;
  const runtimeFingerprintMatchesTruthRuns =
    runtimeFingerprint !== null &&
    truthContext.runtimeFingerprint !== null &&
    runtimeFingerprint.sha256 === truthContext.runtimeFingerprint.sha256;
  const exactSustainedArtifact =
    sample !== undefined &&
    input.artifact.schemaVersion === BENCHMARK_SCHEMA_VERSION &&
    provenanceValid &&
    capturedAtValid &&
    sampleCapturedAtValid &&
    sampleCapturedAtNotAfterArtifact &&
    input.artifact.benchmark === "browser-workloads" &&
    input.artifact.workload === "gpu-scene-resident" &&
    input.artifact.renderer === "webgpu" &&
    input.artifact.artifactRole === "candidate" &&
    input.artifact.status === "complete" &&
    input.artifact.exploratory === true &&
    packageVersionExact &&
    runtimeFingerprintComplete &&
    input.artifact.failures.length === 0 &&
    input.artifact.samples.length === 1 &&
    sample.configuration.fixture === "glyphflow" &&
    sample.configuration.workload === "gpu-scene-resident" &&
    sample.configuration.renderer === "webgpu" &&
    resolveGpuSceneResidentOutputTruth(sample.configuration) ===
      GPU_SCENE_RESIDENT_CANONICAL_TRUTH.sustained600;
  const expectedTimestampResolves =
    GPU_SCENE_RESIDENT_CANONICAL_TRUTH.sustained600.telemetry.fusedTimestampResolves;
  const timestamps = timestampSummary(sample, expectedTimestampResolves);
  const cameraTransformMaxBytes = maximumRecorded(phases?.camera.transformUploadBytes);
  const cameraCullRecordMaxBytes = maximumRecorded(phases?.camera.cullRecordUploadBytes);
  const positionTransformMinBytes = minimumRecorded(phases?.positionMutation.transformUploadBytes);
  const positionTransformMaxBytes = maximumRecorded(phases?.positionMutation.transformUploadBytes);
  const positionTransformExactSamples =
    phases?.positionMutation.transformUploadBytes?.filter(
      (bytes) => bytes === GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES,
    ).length ?? 0;
  const positionCullRecordMaxBytes = maximumRecorded(
    phases?.positionMutation.cullRecordUploadBytes,
  );
  const uploads = Object.freeze({
    cameraTransformMaxBytes,
    cameraCullRecordMaxBytes,
    positionTransformMinBytes,
    positionTransformMaxBytes,
    positionTransformExactSamples,
    positionCullRecordMaxBytes,
  });
  const uploadExact =
    cameraTransformMaxBytes === 0 &&
    cameraCullRecordMaxBytes === 0 &&
    positionTransformMinBytes === GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES &&
    positionTransformMaxBytes === GPU_SCENE_RESIDENT_POSITION_UPLOAD_MAX_BYTES &&
    positionTransformExactSamples === 600 &&
    positionCullRecordMaxBytes === 0;
  const failures: string[] = [];
  if (!SHA256.test(input.candidateSha256)) failures.push("candidate-sha256");
  if (!packageVersionExact) failures.push("package-version");
  if (!runtimeFingerprintComplete || !runtimeFingerprintMatchesTruthRuns) {
    failures.push("runtime-fingerprint");
  }
  if (!provenanceValid) failures.push("provenance");
  if (!buildFingerprintMatchesTruthRuns) failures.push("build-fingerprint");
  if (!harnessFingerprintMatchesTruthRuns) failures.push("harness-fingerprint");
  if (!capturedAtValid) failures.push("captured-at");
  if (!sampleCapturedAtValid) failures.push("sample-captured-at");
  if (!sampleCapturedAtNotAfterArtifact) failures.push("sample-captured-at-order");
  if (!runIdentityDistinctFromTruthRuns) failures.push("run-identity");
  if (!exactSustainedArtifact) failures.push("sustained-artifact");
  if (!currentBudget.passed) failures.push("sustained-budget");
  if (truth?.exactOutputIdentity !== true) failures.push("canonical-output-identity");
  if (!sustainedTailPassed(camera)) failures.push("camera-tail");
  if (!sustainedTailPassed(positionMutation)) failures.push("position-tail");
  if (!timestampExact(timestamps, expectedTimestampResolves)) {
    failures.push("timestamp-counters");
  }
  if (!timestamps.segmentedExact) failures.push("timestamp-segments");
  if (!uploadExact) failures.push("upload-invariants");
  if (
    !phaseSubmissionsExact(phases?.camera) ||
    !phaseSubmissionsExact(phases?.positionMutation) ||
    sample?.counters.frameTransactionSubmissions !== 1_220 ||
    sample.counters.frameTransactionFusedSubmissions !== 1_220 ||
    sample.counters.frameTransactionStandaloneSubmissions !== 0 ||
    sample.counters.diagnosticReadbackSubmissions !== 2
  ) {
    failures.push("product-submissions");
  }

  return Object.freeze({
    artifactFile: input.artifactFile,
    candidateSha256: input.candidateSha256,
    capturedAt: input.artifact.capturedAt,
    capturedAtValid,
    sampleCapturedAt,
    sampleCapturedAtValid,
    sampleCapturedAtNotAfterArtifact,
    sampleCapturedAtDistinctFromTruthRuns,
    runId: provenance.runId,
    buildFingerprintSha256: provenance.buildFingerprintSha256,
    harnessFingerprintSha256: provenance.harnessFingerprintSha256,
    evidenceSha256: provenance.evidenceSha256,
    provenanceValid,
    buildFingerprintMatchesTruthRuns,
    harnessFingerprintMatchesTruthRuns,
    runIdentityDistinctFromTruthRuns,
    packageVersion: input.artifact.packageVersion,
    packageVersionExact,
    runtimeFingerprint,
    runtimeFingerprintComplete,
    runtimeFingerprintMatchesTruthRuns,
    exactSustainedArtifact,
    budgetPassed: currentBudget.passed,
    budgetFailures: Object.freeze(
      currentBudget.checks.filter((check) => !check.passed).map((check) => check.name),
    ),
    exactCanonicalOutput: truth?.exactOutputIdentity === true,
    outputIdentity: Object.freeze({
      submittedGlyphs: sample?.counters.submittedGlyphs ?? -1,
      submittedGlyphsHash: sample?.counters.submittedGlyphsHash ?? -1,
      submittedGlyphsHashSource: sample?.counters.submittedGlyphsHashSource ?? "missing",
      renderedPixelHash: sample?.counters.renderedPixelHash ?? -1,
      nonTransparentPixels: sample?.counters.nonTransparentPixels ?? -1,
    }),
    camera,
    positionMutation,
    uploads,
    timestamps,
    failures: Object.freeze(failures),
    eligible: failures.length === 0,
  });
}

function createRuntimeFingerprint(
  artifact: Readonly<BrowserBenchmarkArtifact>,
  sample: Readonly<BrowserBenchmarkArtifact["samples"][number]> | undefined,
): Readonly<GpuSceneResidentRuntimeFingerprint> | null {
  const bun = presentString(artifact.runtime?.bun);
  const cpu = presentString(artifact.runtime?.cpu);
  const platform = presentString(artifact.runtime?.platform);
  const release = presentString(artifact.runtime?.release);
  const architecture = presentString(artifact.runtime?.architecture);
  const userAgent = presentString(sample?.userAgent);
  const artifactGpuAdapter = artifact.gpuAdapter;
  const sampleGpuAdapter = sample?.gpuAdapter;
  if (
    bun === undefined ||
    cpu === undefined ||
    platform === undefined ||
    release === undefined ||
    architecture === undefined ||
    userAgent === undefined ||
    !isCompleteBrowserGpuAdapterIdentity(artifactGpuAdapter) ||
    !isCompleteBrowserGpuAdapterIdentity(sampleGpuAdapter) ||
    !browserGpuAdapterIdentityEqual(artifactGpuAdapter, sampleGpuAdapter)
  ) {
    return null;
  }
  const fingerprintFields = [
    bun,
    cpu,
    platform,
    release,
    architecture,
    userAgent,
    artifactGpuAdapter,
  ];
  return Object.freeze({
    sha256: createHash("sha256").update(JSON.stringify(fingerprintFields)).digest("hex"),
    bun,
    cpu,
    platform,
    release,
    architecture,
    userAgent,
    gpuAdapter: artifactGpuAdapter,
  });
}

function readProvenanceIdentity(artifact: unknown): Readonly<GpuSceneResidentProvenanceIdentity> {
  const record =
    typeof artifact === "object" && artifact !== null
      ? (artifact as Readonly<Record<string, unknown>>)
      : undefined;
  const provenance =
    typeof record?.provenance === "object" && record.provenance !== null
      ? (record.provenance as Readonly<Record<string, unknown>>)
      : undefined;
  return Object.freeze({
    runId: presentString(provenance?.runId) ?? null,
    buildFingerprintSha256: presentString(provenance?.buildFingerprintSha256) ?? null,
    harnessFingerprintSha256: presentString(provenance?.harnessFingerprintSha256) ?? null,
    evidenceSha256: presentString(provenance?.evidenceSha256) ?? null,
  });
}

function uniqueRunIdentity(values: readonly (string | null)[]): boolean {
  return (
    values.length === GPU_SCENE_RESIDENT_PROMOTION_RUNS &&
    values.every((value) => presentString(value) !== undefined) &&
    new Set(values).size === GPU_SCENE_RESIDENT_PROMOTION_RUNS
  );
}

function presentValueSet(values: readonly (string | null)[]): ReadonlySet<string> {
  return new Set(values.filter((value): value is string => presentString(value) !== undefined));
}

function presentString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function timestampNotAfter(earlier: unknown, later: unknown): boolean {
  return (
    isCanonicalIsoTimestamp(earlier) &&
    isCanonicalIsoTimestamp(later) &&
    Date.parse(earlier) <= Date.parse(later)
  );
}

function summarizePhase(
  phase: Readonly<BrowserBenchmarkPhaseTimings> | undefined,
): Readonly<GpuSceneResidentPhaseSummary> {
  return summarizePhaseSamples(phase?.frameMs ?? []);
}

function summarizePhaseSamples(samples: readonly number[]): Readonly<GpuSceneResidentPhaseSummary> {
  const overBudgetCount = samples.filter((sample) => sample > FRAME_BUDGET_MS).length;
  if (samples.length === 0) {
    return Object.freeze({
      samples: 0,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
      overBudgetCount,
      overBudgetRatio: 0,
    });
  }
  const distribution = summarize(samples, "ms");
  return Object.freeze({
    samples: samples.length,
    p95Ms: distribution.p95,
    p99Ms: distribution.p99,
    maxMs: distribution.max,
    overBudgetCount,
    overBudgetRatio: overBudgetCount / samples.length,
  });
}

function sustainedTailPassed(summary: Readonly<GpuSceneResidentPhaseSummary>): boolean {
  return (
    summary.samples === 600 &&
    summary.p99Ms !== null &&
    summary.p99Ms <= FRAME_BUDGET_MS &&
    summary.overBudgetCount <= 6
  );
}

function maximumRecorded(samples: readonly number[] | undefined): number {
  if (samples === undefined || samples.length === 0) return -1;
  let maximum = 0;
  for (const sample of samples) maximum = Math.max(maximum, sample);
  return maximum;
}

function minimumRecorded(samples: readonly number[] | undefined): number {
  if (samples === undefined || samples.length === 0) return -1;
  let minimum = Number.POSITIVE_INFINITY;
  for (const sample of samples) minimum = Math.min(minimum, sample);
  return minimum;
}

function phaseSubmissionsExact(phase: Readonly<BrowserBenchmarkPhaseTimings> | undefined): boolean {
  return (
    phase?.frameTransactionSubmissionDeltas?.length === 600 &&
    phase.frameTransactionSubmissionDeltas.every((count) => count === 1) &&
    phase.frameTransactionFusedSubmissionDeltas?.length === 600 &&
    phase.frameTransactionFusedSubmissionDeltas.every((count) => count === 1) &&
    phase.frameTransactionStandaloneSubmissionDeltas?.length === 600 &&
    phase.frameTransactionStandaloneSubmissionDeltas.every((count) => count === 0)
  );
}

function timestampSummary(
  sample: Readonly<BrowserBenchmarkArtifact["samples"][number]> | undefined,
  expectedTimestampResolves: number,
): Readonly<GpuSceneResidentTimestampSummary> {
  const timing = sample?.timings.gpuTiming;
  const segments = Object.freeze({
    palette: summarizeTimestampSegment(
      timing?.segmentedSamples ?? -1,
      timing?.validPaletteSamples ?? -1,
      sample?.timings.paletteGpuTimestampMs,
    ),
    cull: summarizeTimestampSegment(
      timing?.segmentedSamples ?? -1,
      timing?.validCullSamples ?? -1,
      sample?.timings.cullGpuTimestampMs,
    ),
    sceneRender: summarizeTimestampSegment(
      timing?.segmentedSamples ?? -1,
      timing?.validSceneRenderSamples ?? -1,
      sample?.timings.sceneRenderGpuTimestampMs,
    ),
  });
  return Object.freeze({
    readbackSubmissions: sample?.counters.timestampReadbackSubmissions ?? -1,
    fusedTimestampResolves: sample?.counters.timestampFusedResolves ?? -1,
    standaloneTimestampSubmissions: sample?.counters.timestampStandaloneSubmissions ?? -1,
    timingSamples: timing?.samples ?? -1,
    timingFusedTimestampResolves: timing?.fusedTimestampResolves ?? -1,
    timingStandaloneTimestampSubmissions: timing?.standaloneTimestampSubmissions ?? -1,
    validSamples: timing?.validSamples ?? -1,
    segmentedSamples: timing?.segmentedSamples ?? -1,
    validSegmentedSamples: timing?.validSegmentedSamples ?? -1,
    segmentedFallbackSamples: timing?.segmentedFallbackSamples ?? -1,
    segments,
    segmentedExact: timestampSegmentsExact(sample, expectedTimestampResolves),
  });
}

function summarizeTimestampSegment(
  samples: number,
  validSamples: number,
  values: readonly (number | null)[] | undefined,
): Readonly<GpuSceneResidentTimestampSegmentSummary> {
  const validValues = values?.filter(isFiniteNonnegativeTimestamp) ?? [];
  const distribution = validValues.length === 0 ? undefined : summarize(validValues, "ms");
  return Object.freeze({
    samples,
    validSamples,
    arraySamples: values?.length ?? 0,
    arrayValidSamples: validValues.length,
    p50Ms: distribution?.p50 ?? null,
    p95Ms: distribution?.p95 ?? null,
  });
}

function summarizeAggregateTimestampSegments(
  runs: readonly Readonly<GpuSceneResidentRepeatabilityRun>[],
  inputs: readonly Readonly<GpuSceneResidentRepeatabilityInput>[],
): Readonly<GpuSceneResidentTimestampSegments> {
  return Object.freeze({
    palette: summarizeTimestampSegment(
      sum(runs, (run) => run.timestamps.segments.palette.samples),
      sum(runs, (run) => run.timestamps.segments.palette.validSamples),
      inputs.flatMap((input) => input.artifact.samples[0]?.timings.paletteGpuTimestampMs ?? []),
    ),
    cull: summarizeTimestampSegment(
      sum(runs, (run) => run.timestamps.segments.cull.samples),
      sum(runs, (run) => run.timestamps.segments.cull.validSamples),
      inputs.flatMap((input) => input.artifact.samples[0]?.timings.cullGpuTimestampMs ?? []),
    ),
    sceneRender: summarizeTimestampSegment(
      sum(runs, (run) => run.timestamps.segments.sceneRender.samples),
      sum(runs, (run) => run.timestamps.segments.sceneRender.validSamples),
      inputs.flatMap((input) => input.artifact.samples[0]?.timings.sceneRenderGpuTimestampMs ?? []),
    ),
  });
}

function timestampSegmentsExact(
  sample: Readonly<BrowserBenchmarkArtifact["samples"][number]> | undefined,
  expectedTimestampResolves: number,
): boolean {
  if (sample === undefined) return false;
  const timing = sample.timings.gpuTiming;
  const counters = sample.counters;
  return (
    timing?.segmentedTimestampWrites === true &&
    timing.timestampQueriesPerFrame === 6 &&
    timing.segmentedSamples === expectedTimestampResolves &&
    timing.validSegmentedSamples === expectedTimestampResolves &&
    timing.segmentedFallbackSamples === 0 &&
    timing.validPaletteSamples === expectedTimestampResolves &&
    timing.validCullSamples === expectedTimestampResolves &&
    timing.validSceneRenderSamples === expectedTimestampResolves &&
    counters.timestampQueriesPerFrame === 6 &&
    counters.timestampSegmentedSamples === expectedTimestampResolves &&
    counters.timestampValidSegmentedSamples === expectedTimestampResolves &&
    counters.timestampSegmentedFallbackSamples === 0 &&
    counters.timestampValidPaletteSamples === expectedTimestampResolves &&
    counters.timestampValidCullSamples === expectedTimestampResolves &&
    counters.timestampValidSceneRenderSamples === expectedTimestampResolves &&
    sample.invariants.timestampSegmentedExact === true &&
    sample.invariants.timestampSegmentsValid === true &&
    timestampSegmentArraysExact(sample)
  );
}

function timestampSegmentArraysExact(
  sample: Readonly<BrowserBenchmarkArtifact["samples"][number]>,
): boolean {
  const phases = sample.timings.phases;
  const total = sample.timings.gpuTimestampMs;
  const palette = sample.timings.paletteGpuTimestampMs;
  const cull = sample.timings.cullGpuTimestampMs;
  const sceneRender = sample.timings.sceneRenderGpuTimestampMs;
  if (
    phases === undefined ||
    total === undefined ||
    palette === undefined ||
    cull === undefined ||
    sceneRender === undefined
  ) {
    return false;
  }
  const expectedPhaseSamples = sample.configuration.sampleFrames;
  const expectedArraySamples = expectedPhaseSamples * 2;
  return (
    total.length === expectedArraySamples &&
    palette.length === expectedArraySamples &&
    cull.length === expectedArraySamples &&
    sceneRender.length === expectedArraySamples &&
    phaseTimestampSegmentsExact(phases.camera, expectedPhaseSamples) &&
    phaseTimestampSegmentsExact(phases.positionMutation, expectedPhaseSamples) &&
    timestampArraysEqual(total, [
      ...phases.camera.gpuTimestampMs,
      ...phases.positionMutation.gpuTimestampMs,
    ]) &&
    timestampArraysEqual(palette, [
      ...(phases.camera.paletteGpuTimestampMs ?? []),
      ...(phases.positionMutation.paletteGpuTimestampMs ?? []),
    ]) &&
    timestampArraysEqual(cull, [
      ...(phases.camera.cullGpuTimestampMs ?? []),
      ...(phases.positionMutation.cullGpuTimestampMs ?? []),
    ]) &&
    timestampArraysEqual(sceneRender, [
      ...(phases.camera.sceneRenderGpuTimestampMs ?? []),
      ...(phases.positionMutation.sceneRenderGpuTimestampMs ?? []),
    ])
  );
}

function phaseTimestampSegmentsExact(
  phase: Readonly<BrowserBenchmarkPhaseTimings>,
  expectedSamples: number,
): boolean {
  const total = phase.gpuTimestampMs;
  const palette = phase.paletteGpuTimestampMs;
  const cull = phase.cullGpuTimestampMs;
  const sceneRender = phase.sceneRenderGpuTimestampMs;
  if (
    total.length !== expectedSamples ||
    palette?.length !== expectedSamples ||
    cull?.length !== expectedSamples ||
    sceneRender?.length !== expectedSamples
  ) {
    return false;
  }
  for (let index = 0; index < expectedSamples; index += 1) {
    const totalMs = total[index];
    const paletteMs = palette[index];
    const cullMs = cull[index];
    const sceneRenderMs = sceneRender[index];
    if (
      !isFiniteNonnegativeTimestamp(totalMs) ||
      !isFiniteNonnegativeTimestamp(paletteMs) ||
      !isFiniteNonnegativeTimestamp(cullMs) ||
      !isFiniteNonnegativeTimestamp(sceneRenderMs) ||
      paletteMs + cullMs + sceneRenderMs > totalMs + 1e-12
    ) {
      return false;
    }
  }
  return true;
}

function timestampArraysEqual(
  left: readonly (number | null)[],
  right: readonly (number | null)[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => {
      const expected = right[index];
      return (
        isFiniteNonnegativeTimestamp(value) &&
        isFiniteNonnegativeTimestamp(expected) &&
        Math.abs(value - expected) <= 1e-12
      );
    })
  );
}

function isFiniteNonnegativeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function timestampExact(
  timestamps: Readonly<GpuSceneResidentTimestampSummary>,
  expectedFusedResolves = GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal.telemetry
    .fusedTimestampResolves,
): boolean {
  return (
    timestamps.readbackSubmissions === expectedFusedResolves &&
    timestamps.fusedTimestampResolves === expectedFusedResolves &&
    timestamps.standaloneTimestampSubmissions === 0 &&
    timestamps.timingSamples === expectedFusedResolves &&
    timestamps.timingFusedTimestampResolves === expectedFusedResolves &&
    timestamps.timingStandaloneTimestampSubmissions === 0 &&
    timestamps.validSamples === expectedFusedResolves
  );
}

function stableOutputIdentity(
  runs: readonly Readonly<GpuSceneResidentRepeatabilityRun>[],
): boolean {
  const first = runs[0]?.outputIdentity;
  return (
    runs.length === GPU_SCENE_RESIDENT_PROMOTION_RUNS &&
    first !== undefined &&
    runs.every(
      (run) =>
        run.outputIdentity.submittedGlyphs === first.submittedGlyphs &&
        run.outputIdentity.submittedGlyphsHash === first.submittedGlyphsHash &&
        run.outputIdentity.submittedGlyphsHashSource === first.submittedGlyphsHashSource &&
        run.outputIdentity.renderedPixelHash === first.renderedPixelHash &&
        run.outputIdentity.nonTransparentPixels === first.nonTransparentPixels,
    )
  );
}

function phaseFrames(
  inputs: readonly Readonly<GpuSceneResidentRepeatabilityInput>[],
  phase: "camera" | "positionMutation",
): readonly number[] {
  return Object.freeze(
    inputs.flatMap((input) => input.artifact.samples[0]?.timings.phases?.[phase].frameMs ?? []),
  );
}

function sum<T>(values: readonly T[], read: (value: T) => number): number {
  return values.reduce((total, value) => total + read(value), 0);
}

async function runCli(): Promise<void> {
  const args = Bun.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const output = outputIndex < 0 ? undefined : args[outputIndex + 1];
  if (outputIndex >= 0) args.splice(outputIndex, 2);
  const sustainedIndex = args.indexOf("--sustained");
  const sustainedPath = sustainedIndex < 0 ? undefined : args[sustainedIndex + 1];
  if (sustainedIndex >= 0) args.splice(sustainedIndex, 2);
  if (args.length !== GPU_SCENE_RESIDENT_PROMOTION_RUNS) {
    throw new RangeError(
      `Expected ${String(GPU_SCENE_RESIDENT_PROMOTION_RUNS)} isolated candidate artifact paths`,
    );
  }
  const inputs: GpuSceneResidentRepeatabilityInput[] = [];
  for (const [index, path] of args.entries()) {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    inputs.push({
      run: index + 1,
      artifactFile: basename(path),
      candidateSha256: createHash("sha256").update(bytes).digest("hex"),
      artifact: JSON.parse(new TextDecoder().decode(bytes)) as BrowserBenchmarkArtifact,
    });
  }
  const sustainedInput =
    sustainedPath === undefined ? undefined : await loadSustainedInput(sustainedPath);
  const artifact = aggregateGpuSceneResidentRepeatability(
    inputs,
    new Date().toISOString(),
    sustainedInput,
  );
  const outputPath = resolve(
    output ??
      `benchmarks/results/browser-gpu-scene-resident-webgpu-promotion-repeatability-${artifact.packageVersion}.json`,
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  console.log(JSON.stringify({ outputPath, promotion: artifact.promotion }));
  if (artifact.promotion.status !== "GO") process.exitCode = 1;
}

async function loadSustainedInput(path: string): Promise<GpuSceneResidentSustainedInput> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return {
    artifactFile: basename(path),
    candidateSha256: createHash("sha256").update(bytes).digest("hex"),
    artifact: JSON.parse(new TextDecoder().decode(bytes)) as BrowserBenchmarkArtifact,
  };
}

if (import.meta.main) await runCli();
