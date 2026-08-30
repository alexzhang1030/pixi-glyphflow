import type {
  BrowserBenchmarkConfiguration,
  BrowserBenchmarkCounters,
  ReadableBrowserBenchmarkArtifact,
} from "./schema";

export interface GpuSceneResidentTruthConfiguration {
  readonly labelCount: number;
  readonly mutationCount: number;
  readonly warmupFrames: number;
  readonly sampleFrames: number;
  readonly width: number;
  readonly height: number;
}

export interface GpuSceneResidentOutputIdentity {
  readonly submittedGlyphs: number;
  readonly submittedGlyphsSource: "gpu-indirect-readback";
  readonly submittedGlyphsHash: number;
  readonly submittedGlyphsHashSource: "gpu-instances-out-readback";
  readonly renderedPixelHash: number;
  readonly nonTransparentPixels: number;
}

export interface GpuSceneResidentTruthTelemetry {
  readonly frameTransactionSubmissions: number;
  readonly frameTransactionFusedSubmissions: number;
  readonly frameTransactionStandaloneSubmissions: number;
  readonly diagnosticReadbackSubmissions: number;
  readonly timestampReadbackSubmissions: number;
  readonly fusedTimestampResolves: number;
  readonly standaloneTimestampSubmissions: number;
  readonly gpuTiming: Readonly<{
    renderer: "webgpu";
    method: "timestamp-query";
    gpuTimeSource: "gpu-timestamp";
    quality: "valid";
    supported: true;
    timerQuery: false;
    timestampWrites: true;
    resolveQuerySet: true;
    readback: true;
    disjoint: false;
    samples: number;
    validSamples: number;
    fallbackSamples: number;
    fusedTimestampResolves: number;
    standaloneTimestampSubmissions: number;
  }>;
}

export type GpuSceneResidentTruthProvenanceSource = Readonly<
  | {
      kind: "source-candidate-artifact";
      artifact: string;
      sha256: string;
    }
  | {
      kind: "benchmark-contract";
      contract: "browser-smoke" | "sustained-600";
    }
>;

export interface GpuSceneResidentTruthProvenance {
  readonly configuration: GpuSceneResidentTruthProvenanceSource;
  readonly output: GpuSceneResidentTruthProvenanceSource;
  readonly telemetry: GpuSceneResidentTruthProvenanceSource;
}

export interface GpuSceneResidentTruthSnapshot {
  readonly configuration: Readonly<GpuSceneResidentTruthConfiguration>;
  readonly output: Readonly<GpuSceneResidentOutputIdentity>;
  readonly telemetry: Readonly<GpuSceneResidentTruthTelemetry>;
  readonly provenance: Readonly<GpuSceneResidentTruthProvenance>;
}

export interface GpuSceneResidentCanonicalTruth {
  readonly sourceCandidate: Readonly<{
    artifact: string;
    packageVersion: string;
    sha256: string;
  }>;
  readonly formal: Readonly<GpuSceneResidentTruthSnapshot>;
  readonly sustained600: Readonly<GpuSceneResidentTruthSnapshot>;
  readonly browserSmoke: Readonly<GpuSceneResidentTruthSnapshot>;
}

const FORMAL_OUTPUT: Readonly<GpuSceneResidentOutputIdentity> = Object.freeze({
  submittedGlyphs: 50_000,
  submittedGlyphsSource: "gpu-indirect-readback",
  submittedGlyphsHash: 0x45cf_d045,
  submittedGlyphsHashSource: "gpu-instances-out-readback",
  renderedPixelHash: 0xa8ad_90b4,
  nonTransparentPixels: 302_457,
});

const SOURCE_CANDIDATE = Object.freeze({
  artifact: "browser-gpu-scene-resident-webgpu-canonical-source-1.2.0.json",
  packageVersion: "1.2.0",
  sha256: "e8149d863b2d75af2e2ac997114597f5ab8ae4a3ca2746cf54c92f7672d69f7c",
});
const SOURCE_CANDIDATE_PROVENANCE: GpuSceneResidentTruthProvenanceSource = Object.freeze({
  kind: "source-candidate-artifact",
  artifact: SOURCE_CANDIDATE.artifact,
  sha256: SOURCE_CANDIDATE.sha256,
});
const SUSTAINED_600_CONTRACT_PROVENANCE: GpuSceneResidentTruthProvenanceSource = Object.freeze({
  kind: "benchmark-contract",
  contract: "sustained-600",
});
const BROWSER_SMOKE_CONTRACT_PROVENANCE: GpuSceneResidentTruthProvenanceSource = Object.freeze({
  kind: "benchmark-contract",
  contract: "browser-smoke",
});

export const GPU_SCENE_RESIDENT_CANONICAL_TRUTH: Readonly<GpuSceneResidentCanonicalTruth> =
  Object.freeze({
    sourceCandidate: SOURCE_CANDIDATE,
    formal: snapshot(
      {
        labelCount: 1_000_000,
        mutationCount: 100_000,
        warmupFrames: 10,
        sampleFrames: 120,
        width: 1_280,
        height: 800,
      },
      FORMAL_OUTPUT,
      260,
      sourceProvenance(SOURCE_CANDIDATE_PROVENANCE),
    ),
    sustained600: snapshot(
      {
        labelCount: 1_000_000,
        mutationCount: 100_000,
        warmupFrames: 10,
        sampleFrames: 600,
        width: 1_280,
        height: 800,
      },
      FORMAL_OUTPUT,
      1_220,
      sourceProvenance(
        SUSTAINED_600_CONTRACT_PROVENANCE,
        SOURCE_CANDIDATE_PROVENANCE,
        SUSTAINED_600_CONTRACT_PROVENANCE,
      ),
    ),
    browserSmoke: snapshot(
      {
        labelCount: 100_000,
        mutationCount: 10_000,
        warmupFrames: 1,
        sampleFrames: 2,
        width: 320,
        height: 180,
      },
      {
        submittedGlyphs: 5_000,
        submittedGlyphsSource: "gpu-indirect-readback",
        submittedGlyphsHash: 0xd5fa_04c5,
        submittedGlyphsHashSource: "gpu-instances-out-readback",
        renderedPixelHash: 0xb154_a32f,
        nonTransparentPixels: 21_684,
      },
      6,
      sourceProvenance(BROWSER_SMOKE_CONTRACT_PROVENANCE),
    ),
  });

export interface GpuSceneResidentOutputTruthEvaluation {
  readonly knownConfiguration: boolean;
  readonly submittedIdentity: boolean;
  readonly renderedPixelHash: boolean;
  readonly nonTransparentPixels: boolean;
  readonly repeatable: boolean;
  readonly exactOutputIdentity: boolean;
}

export interface GpuSceneResidentCanonicalSourceCheck {
  readonly name: string;
  readonly actual: boolean | number | string;
  readonly expected: boolean | number | string;
  readonly passed: boolean;
}

export interface GpuSceneResidentCanonicalSourceBinding {
  readonly passed: boolean;
  readonly checks: readonly Readonly<GpuSceneResidentCanonicalSourceCheck>[];
  readonly failures: readonly string[];
}

export function evaluateGpuSceneResidentCanonicalSourceBinding(
  artifact: Readonly<ReadableBrowserBenchmarkArtifact>,
  expected: Readonly<GpuSceneResidentTruthSnapshot> = GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal,
): Readonly<GpuSceneResidentCanonicalSourceBinding> {
  const sample = artifact.samples[0];
  const configuration = sample?.configuration;
  const counters = sample?.counters;
  const gpuTiming = sample?.timings.gpuTiming;
  const telemetry = expected.telemetry;
  const checks = [
    sourceCheck("sample-count", artifact.samples.length, 1),
    sourceCheck("label-count", configuration?.labelCount, expected.configuration.labelCount),
    sourceCheck(
      "mutation-count",
      configuration?.mutationCount,
      expected.configuration.mutationCount,
    ),
    sourceCheck("warmup-frames", configuration?.warmupFrames, expected.configuration.warmupFrames),
    sourceCheck("sample-frames", configuration?.sampleFrames, expected.configuration.sampleFrames),
    sourceCheck("width", configuration?.width, expected.configuration.width),
    sourceCheck("height", configuration?.height, expected.configuration.height),
    sourceCheck("submitted-glyphs", counters?.submittedGlyphs, expected.output.submittedGlyphs),
    sourceCheck("submitted-labels", counters?.submittedLabels, expected.output.submittedGlyphs),
    sourceCheck(
      "submitted-glyphs-source",
      counters?.submittedGlyphsSource,
      expected.output.submittedGlyphsSource,
    ),
    sourceCheck(
      "submitted-glyphs-hash",
      counters?.submittedGlyphsHash,
      expected.output.submittedGlyphsHash,
    ),
    sourceCheck(
      "submitted-glyphs-hash-source",
      counters?.submittedGlyphsHashSource,
      expected.output.submittedGlyphsHashSource,
    ),
    sourceCheck(
      "rendered-pixel-hash",
      counters?.renderedPixelHash,
      expected.output.renderedPixelHash,
    ),
    sourceCheck(
      "rendered-pixel-hash-repeat",
      counters?.renderedPixelHashRepeat,
      expected.output.renderedPixelHash,
    ),
    sourceCheck(
      "non-transparent-pixels",
      counters?.nonTransparentPixels,
      expected.output.nonTransparentPixels,
    ),
    sourceCheck(
      "non-transparent-pixels-repeat",
      counters?.nonTransparentPixelsRepeat,
      expected.output.nonTransparentPixels,
    ),
    sourceCheck(
      "frame-transaction-submissions",
      counters?.frameTransactionSubmissions,
      telemetry.frameTransactionSubmissions,
    ),
    sourceCheck(
      "frame-transaction-fused-submissions",
      counters?.frameTransactionFusedSubmissions,
      telemetry.frameTransactionFusedSubmissions,
    ),
    sourceCheck(
      "frame-transaction-standalone-submissions",
      counters?.frameTransactionStandaloneSubmissions,
      telemetry.frameTransactionStandaloneSubmissions,
    ),
    sourceCheck(
      "diagnostic-readback-submissions",
      counters?.diagnosticReadbackSubmissions,
      telemetry.diagnosticReadbackSubmissions,
    ),
    sourceCheck(
      "timestamp-readback-submissions",
      counters?.timestampReadbackSubmissions,
      telemetry.timestampReadbackSubmissions,
    ),
    sourceCheck(
      "timestamp-fused-resolves",
      counters?.timestampFusedResolves,
      telemetry.fusedTimestampResolves,
    ),
    sourceCheck(
      "timestamp-standalone-submissions",
      counters?.timestampStandaloneSubmissions,
      telemetry.standaloneTimestampSubmissions,
    ),
    sourceCheck("gpu-timing-renderer", gpuTiming?.renderer, telemetry.gpuTiming.renderer),
    sourceCheck("gpu-timing-method", gpuTiming?.method, telemetry.gpuTiming.method),
    sourceCheck("gpu-time-source", gpuTiming?.gpuTimeSource, telemetry.gpuTiming.gpuTimeSource),
    sourceCheck("gpu-timing-quality", gpuTiming?.quality, telemetry.gpuTiming.quality),
    sourceCheck("gpu-timing-supported", gpuTiming?.supported, telemetry.gpuTiming.supported),
    sourceCheck("gpu-timing-timer-query", gpuTiming?.timerQuery, telemetry.gpuTiming.timerQuery),
    sourceCheck(
      "gpu-timing-timestamp-writes",
      gpuTiming?.timestampWrites,
      telemetry.gpuTiming.timestampWrites,
    ),
    sourceCheck(
      "gpu-timing-resolve-query-set",
      gpuTiming?.resolveQuerySet,
      telemetry.gpuTiming.resolveQuerySet,
    ),
    sourceCheck("gpu-timing-readback", gpuTiming?.readback, telemetry.gpuTiming.readback),
    sourceCheck("gpu-timing-disjoint", gpuTiming?.disjoint, telemetry.gpuTiming.disjoint),
    sourceCheck("gpu-timing-samples", gpuTiming?.samples, telemetry.gpuTiming.samples),
    sourceCheck(
      "gpu-timing-valid-samples",
      gpuTiming?.validSamples,
      telemetry.gpuTiming.validSamples,
    ),
    sourceCheck(
      "gpu-timing-fallback-samples",
      gpuTiming?.fallbackSamples,
      telemetry.gpuTiming.fallbackSamples,
    ),
    sourceCheck(
      "gpu-timing-fused-resolves",
      gpuTiming?.fusedTimestampResolves,
      telemetry.gpuTiming.fusedTimestampResolves,
    ),
    sourceCheck(
      "gpu-timing-standalone-submissions",
      gpuTiming?.standaloneTimestampSubmissions,
      telemetry.gpuTiming.standaloneTimestampSubmissions,
    ),
  ];
  const failures = checks.filter((check) => !check.passed).map((check) => check.name);
  return Object.freeze({
    passed: failures.length === 0,
    checks: Object.freeze(checks),
    failures: Object.freeze(failures),
  });
}

export function resolveGpuSceneResidentOutputTruth(
  configuration: Pick<
    BrowserBenchmarkConfiguration,
    "height" | "labelCount" | "mutationCount" | "sampleFrames" | "warmupFrames" | "width"
  >,
): Readonly<GpuSceneResidentTruthSnapshot> | undefined {
  for (const expected of [
    GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal,
    GPU_SCENE_RESIDENT_CANONICAL_TRUTH.sustained600,
    GPU_SCENE_RESIDENT_CANONICAL_TRUTH.browserSmoke,
  ]) {
    if (sameConfiguration(configuration, expected.configuration)) return expected;
  }
  return undefined;
}

export function evaluateGpuSceneResidentOutputTruth(
  configuration: Pick<
    BrowserBenchmarkConfiguration,
    "height" | "labelCount" | "mutationCount" | "sampleFrames" | "warmupFrames" | "width"
  >,
  counters: Pick<
    BrowserBenchmarkCounters,
    | "nonTransparentPixels"
    | "nonTransparentPixelsRepeat"
    | "renderedPixelHash"
    | "renderedPixelHashRepeat"
    | "submittedGlyphs"
    | "submittedGlyphsHash"
  >,
): Readonly<GpuSceneResidentOutputTruthEvaluation> {
  const expected = resolveGpuSceneResidentOutputTruth(configuration);
  const submittedIdentity =
    expected !== undefined &&
    counters.submittedGlyphs === expected.output.submittedGlyphs &&
    counters.submittedGlyphsHash === expected.output.submittedGlyphsHash;
  const renderedPixelHash =
    expected !== undefined && counters.renderedPixelHash === expected.output.renderedPixelHash;
  const nonTransparentPixels =
    expected !== undefined &&
    counters.nonTransparentPixels === expected.output.nonTransparentPixels;
  const repeatable =
    counters.renderedPixelHash !== undefined &&
    counters.renderedPixelHashRepeat === counters.renderedPixelHash &&
    counters.nonTransparentPixels !== undefined &&
    counters.nonTransparentPixelsRepeat === counters.nonTransparentPixels;

  return Object.freeze({
    knownConfiguration: expected !== undefined,
    submittedIdentity,
    renderedPixelHash,
    nonTransparentPixels,
    repeatable,
    exactOutputIdentity:
      submittedIdentity && renderedPixelHash && nonTransparentPixels && repeatable,
  });
}

function snapshot(
  configuration: GpuSceneResidentTruthConfiguration,
  output: GpuSceneResidentOutputIdentity,
  fusedTimestampResolves: number,
  provenance: Readonly<GpuSceneResidentTruthProvenance>,
): Readonly<GpuSceneResidentTruthSnapshot> {
  return Object.freeze({
    configuration: Object.freeze(configuration),
    output: Object.freeze(output),
    telemetry: Object.freeze({
      frameTransactionSubmissions: fusedTimestampResolves,
      frameTransactionFusedSubmissions: fusedTimestampResolves,
      frameTransactionStandaloneSubmissions: 0,
      diagnosticReadbackSubmissions: 2,
      timestampReadbackSubmissions: fusedTimestampResolves,
      fusedTimestampResolves,
      standaloneTimestampSubmissions: 0,
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
        samples: fusedTimestampResolves,
        validSamples: fusedTimestampResolves,
        fallbackSamples: 0,
        fusedTimestampResolves,
        standaloneTimestampSubmissions: 0,
      }),
    }),
    provenance,
  });
}

function sourceProvenance(
  configuration: GpuSceneResidentTruthProvenanceSource,
  output: GpuSceneResidentTruthProvenanceSource = configuration,
  telemetry: GpuSceneResidentTruthProvenanceSource = configuration,
): Readonly<GpuSceneResidentTruthProvenance> {
  return Object.freeze({ configuration, output, telemetry });
}

function sourceCheck(
  name: string,
  actual: unknown,
  expected: boolean | number | string,
): Readonly<GpuSceneResidentCanonicalSourceCheck> {
  return Object.freeze({
    name,
    actual:
      typeof actual === "boolean" || typeof actual === "number" || typeof actual === "string"
        ? actual
        : String(actual),
    expected,
    passed: actual === expected,
  });
}

function sameConfiguration(
  actual: Pick<
    BrowserBenchmarkConfiguration,
    "height" | "labelCount" | "mutationCount" | "sampleFrames" | "warmupFrames" | "width"
  >,
  expected: Readonly<GpuSceneResidentTruthConfiguration>,
): boolean {
  return (
    actual.labelCount === expected.labelCount &&
    actual.mutationCount === expected.mutationCount &&
    actual.warmupFrames === expected.warmupFrames &&
    actual.sampleFrames === expected.sampleFrames &&
    actual.width === expected.width &&
    actual.height === expected.height
  );
}
