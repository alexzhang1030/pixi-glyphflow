import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BROWSER_BENCHMARK_HARNESS_PATHS,
  browserBenchmarkBuildFingerprintSha256,
  browserBenchmarkEvidenceSha256,
  browserBenchmarkHarnessFingerprintSha256,
  createBrowserBenchmarkArtifact,
  createBrowserBenchmarkBuildManifest,
  createBrowserBenchmarkHarnessManifest,
} from "../benchmarks/artifacts";
import {
  LABEL_COLLISION_BENCHMARK_DEFAULTS,
  LABEL_COLLISION_ACTIVE_SCATTER_SCHEMA_VERSION,
  LABEL_COLLISION_REPEATABILITY_SCHEMA_VERSION,
  createLabelCollisionActiveScatterArtifact,
  createLabelCollisionRepeatabilityArtifact,
  createLabelCollisionBenchmarkSpecs,
  summarizeLabelCollisionWorkload,
  type LabelCollisionActiveScatterArtifact,
  type LabelCollisionActiveScatterRun,
  type LabelCollisionDetailedTimings,
  type LabelCollisionPhaseDiagnostic,
  type LabelCollisionRepeatabilityArtifact,
} from "../benchmarks/label-collision";
import { evaluateLabelCollisionBudget } from "../benchmarks/label-collision-budget";
import {
  LABEL_COLLISION_FORMAL_REPEATABILITY_SCHEMA_VERSION,
  aggregateLabelCollisionRepeatability,
  type LabelCollisionFormalRepeatabilityArtifact,
  type LabelCollisionRawCandidateInput,
} from "../benchmarks/label-collision-repeatability";
import {
  BENCHMARK_SCHEMA_VERSION,
  type BrowserBenchmarkArtifact,
  type BrowserBenchmarkArtifactPayload,
  type BrowserBenchmarkBuildManifestEntry,
  type BrowserBenchmarkHarnessManifestEntry,
  type BrowserBenchmarkRenderer,
} from "../benchmarks/schema";

interface CollisionManifests {
  readonly buildManifest: readonly Readonly<BrowserBenchmarkBuildManifestEntry>[];
  readonly harnessManifest: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[];
}

const COLLISION_AGGREGATED_AT = "2026-08-30T00:01:00.000Z";
const COLLISION_BUILD_MANIFEST: readonly Readonly<BrowserBenchmarkBuildManifestEntry>[] =
  Object.freeze([Object.freeze({ path: "assets/benchmark.js", bytes: 4, sha256: "1".repeat(64) })]);
const COLLISION_ALTERNATE_BUILD_MANIFEST: readonly Readonly<BrowserBenchmarkBuildManifestEntry>[] =
  Object.freeze([Object.freeze({ path: "assets/benchmark.js", bytes: 4, sha256: "2".repeat(64) })]);
const COLLISION_HARNESS_MANIFEST: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[] =
  Object.freeze(
    BROWSER_BENCHMARK_HARNESS_PATHS.map((path, index) =>
      Object.freeze({
        path,
        bytes: index + 1,
        sha256: (index + 1).toString(16).padStart(64, "0"),
      }),
    ),
  );
const COLLISION_ALTERNATE_HARNESS_MANIFEST: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[] =
  Object.freeze(
    COLLISION_HARNESS_MANIFEST.map((entry, index) =>
      index === 0 ? Object.freeze({ ...entry, sha256: "f".repeat(64) }) : entry,
    ),
  );
const COLLISION_CURRENT_IDENTITY = Object.freeze({
  buildFingerprintSha256: browserBenchmarkBuildFingerprintSha256(COLLISION_BUILD_MANIFEST),
  harnessFingerprintSha256: browserBenchmarkHarnessFingerprintSha256(COLLISION_HARNESS_MANIFEST),
});

describe("label collision benchmark helper", () => {
  test("builds one million high-overlap labels in bounded chunks", () => {
    const specs = createLabelCollisionBenchmarkSpecs(1_023, 2);

    expect(LABEL_COLLISION_BENCHMARK_DEFAULTS).toMatchObject({
      labelCount: 1_000_000,
      overlapGroupSize: 1_024,
      collision: { enabled: true, maxVisible: 512 },
    });
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({ x: 0, y: 0, priority: 998_977 });
    expect(specs[1]).toMatchObject({ x: 64, y: 0, priority: 998_976 });
  });

  test("records submitted reduction and collision CPU cost", () => {
    expect(
      summarizeLabelCollisionWorkload(
        {
          labelCount: 1_000_000,
          visibleLabelCount: 512,
          collisionCandidateCount: 1_000_000,
          collisionCulledLabelCount: 499_488,
          densityCulledLabelCount: 500_000,
          lastCollisionMs: 23.5,
          collisionSelectionHash: 0x1234_5678,
        },
        25,
      ),
    ).toEqual({
      residentLabels: 1_000_000,
      candidateLabels: 1_000_000,
      submittedLabels: 512,
      submittedReduction: 999_488,
      submittedReductionRatio: 0.999488,
      collisionCulledLabels: 499_488,
      densityCulledLabels: 500_000,
      cpuMs: 25,
      collisionCpuMs: 23.5,
      selectionHash: 0x1234_5678,
    });
  });

  test("summarizes three repeatability runs per renderer with stable selection hashes", () => {
    const run = (index: number, renderer: "webgl" | "webgpu", cpuP95: number) => ({
      index,
      renderer,
      timings: {
        frameMs: { p50: 18, p95: 24 + index },
        cpuMs: { p50: 13, p95: cpuP95 },
        commitMs: { p50: 12.9, p95: cpuP95 - 0.1 },
        collisionMs: { p50: 5.2, p95: 6.2 + index * 0.1 },
      },
      submittedLabels: 512,
      submittedGlyphs: 4_096,
      selectionHash: 1_628_931_525,
      accountingPassed: true,
      budgetPassed: cpuP95 <= 16.67,
    });
    const artifact = createLabelCollisionRepeatabilityArtifact({
      capturedAt: "2026-08-29T00:00:00.000Z",
      runtime: { bun: "1.4.0", cpu: "Apple M1 Pro", platform: "darwin", architecture: "arm64" },
      webgl: [run(1, "webgl", 15.4), run(2, "webgl", 15.6), run(3, "webgl", 15.5)],
      webgpu: [run(1, "webgpu", 19.9), run(2, "webgpu", 18.6), run(3, "webgpu", 18.5)],
    });

    expect(artifact.schemaVersion).toBe(LABEL_COLLISION_REPEATABILITY_SCHEMA_VERSION);
    expect(artifact.renderers.webgl.aggregate.cpuP95Ms).toEqual({
      mean: 15.5,
      min: 15.4,
      max: 15.6,
      range: 0.2,
      coefficientOfVariation: 0.005268,
    });
    expect(artifact.renderers.webgpu.aggregate.cpuP95Ms).toEqual({
      mean: 19,
      min: 18.5,
      max: 19.9,
      range: 1.4,
      coefficientOfVariation: 0.033563,
    });
    expect(artifact.renderers.webgl.invariants).toEqual({
      submittedGlyphsMatchLabels: true,
      selectionHashStable: true,
      accountingPassed: true,
      budgetsPassed: true,
    });
    expect(artifact.renderers.webgpu.invariants.budgetsPassed).toBe(false);
  });

  test("keeps the committed repeatability artifact schema and selection hash reproducible", async () => {
    const artifact = (await Bun.file(
      new URL(
        "../benchmarks/results/browser-label-collision-repeatability-legacy-schema1-1.2.0.json",
        import.meta.url,
      ),
    ).json()) as LabelCollisionRepeatabilityArtifact;
    const rebuilt = createLabelCollisionRepeatabilityArtifact({
      capturedAt: artifact.capturedAt,
      runtime: artifact.runtime,
      webgl: artifact.renderers.webgl.runs,
      webgpu: artifact.renderers.webgpu.runs,
    });

    expect(artifact).toEqual(rebuilt);
    expect(
      new Set(
        [...artifact.renderers.webgl.runs, ...artifact.renderers.webgpu.runs].map(
          (run) => run.selectionHash,
        ),
      ),
    ).toEqual(new Set([1_628_931_525]));
  });

  test("byte-locks the current schema 2 collision repeatability decision", async () => {
    const path = new URL(
      "../benchmarks/results/browser-label-collision-repeatability-1.2.0.json",
      import.meta.url,
    );
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    const artifact = JSON.parse(
      new TextDecoder().decode(bytes),
    ) as Readonly<LabelCollisionFormalRepeatabilityArtifact>;

    expect(sha256(bytes)).toBe("b501181208e39884e3cae5a589a540e5e783ec9d621df927b30f140ff42184a1");
    expect(artifact).toMatchObject({
      schemaVersion: LABEL_COLLISION_FORMAL_REPEATABILITY_SCHEMA_VERSION,
      gate: { status: "GO", reasons: [] },
      invariants: {
        exactlySixRuns: true,
        everyRunCurrentCandidate: true,
        everyRunProvenanceValid: true,
        selectionHashStable: true,
        submittedStateStable: true,
        webgpuWholeFrameBudgetPassed: true,
      },
    });
  });

  test("records active scatter before/after phase reductions and budget decisions", async () => {
    const before = (await Bun.file(
      new URL(
        "../benchmarks/results/browser-label-collision-repeatability-legacy-schema1-1.2.0.json",
        import.meta.url,
      ),
    ).json()) as LabelCollisionRepeatabilityArtifact;
    const artifact = createLabelCollisionActiveScatterArtifact({
      capturedAt: "2026-08-29T09:01:28.832Z",
      runtime: before.runtime,
      beforeFormalRuns: before.renderers.webgpu.runs,
      beforeWebgpuDiagnostic: phaseDiagnostic("webgpu", "storage", 19.8, 3.8, 16_810_240),
      afterFormalRuns: [
        activeScatterRun(1, 16.1, 18, 6.7, 0.5),
        activeScatterRun(2, 16.4, 18.1, 6.8, 0.6),
        activeScatterRun(3, 16.1, 18, 6.8, 0.6),
      ],
      beforeWebglControl: phaseDiagnostic("webgl", "texture", 15.9, 1.9, 1_081_344),
      afterWebglControl: phaseDiagnostic("webgl", "texture", 15.7, 1.8, 1_081_344),
    });

    expect(artifact.schemaVersion).toBe(LABEL_COLLISION_ACTIVE_SCATTER_SCHEMA_VERSION);
    expect(artifact.comparison.cpuP95Ms).toEqual({
      before: [19.9, 18.6, 18.5],
      after: [16.1, 16.4, 16.1],
      beforeMean: 19,
      afterMean: 16.2,
      delta: -2.8,
      reductionRatio: 0.147368,
    });
    expect(artifact.comparison.uploadP95Bytes.reductionRatio).toBeGreaterThan(0.99);
    expect(artifact.invariants).toMatchObject({
      formalSelectionHashStable: true,
      afterBudgetsPassed: true,
      afterCpuBudgetPassed: true,
      afterCollisionBudgetPassed: true,
      afterWholeFrameBudgetPassed: false,
      webglControlStable: true,
    });
  });

  test("keeps the active scatter artifact schema and hashes reproducible", async () => {
    const artifact = (await Bun.file(
      new URL(
        "../benchmarks/results/browser-label-collision-webgpu-active-scatter-repeatability-1.2.0.json",
        import.meta.url,
      ),
    ).json()) as LabelCollisionActiveScatterArtifact;
    const rebuilt = createLabelCollisionActiveScatterArtifact({
      capturedAt: artifact.capturedAt,
      runtime: artifact.runtime,
      beforeFormalRuns: artifact.before.formalRuns,
      beforeWebgpuDiagnostic: artifact.before.webgpuPhaseDiagnostic,
      afterFormalRuns: artifact.after.formalRuns,
      beforeWebglControl: artifact.before.webglControl,
      afterWebglControl: artifact.after.webglControl,
    });

    expect(artifact).toEqual(rebuilt);
    expect(new Set(artifact.after.formalRuns.map((run) => run.selectionHash))).toEqual(
      new Set([1_628_931_525]),
    );
  });
});

describe("label collision formal repeatability", () => {
  test("keeps the frozen runner bootstrap paths synchronized with the launcher manifest", async () => {
    const runnerSource = await Bun.file(new URL("../benchmarks/run.ts", import.meta.url)).text();
    const bootstrapBlock = runnerSource.match(
      /const BOOTSTRAP_HARNESS_PATHS:[\s\S]+?Object\.freeze\(\[([\s\S]+?)\]\);/,
    )?.[1];
    const bootstrapPaths = Array.from(
      bootstrapBlock?.matchAll(/^\s*"([^"]+)",$/gm) ?? [],
      (match) => match[1],
    );

    expect(bootstrapPaths).toEqual([...BROWSER_BENCHMARK_HARNESS_PATHS]);
    expect(bootstrapPaths).toContain("benchmarks/label-collision-repeatability.ts");
  });

  test("aggregates six isolated current candidates into a GO artifact", async () => {
    const inputs = await collisionRawCandidates();

    const artifact = aggregateCollisionCandidates(inputs);

    expect(artifact).toMatchObject({
      schemaVersion: LABEL_COLLISION_FORMAL_REPEATABILITY_SCHEMA_VERSION,
      kind: "pixi-glyphflow-label-collision-repeatability",
      packageVersion: "1.2.0",
      configuration: {
        residentLabels: 1_000_000,
        warmupFrames: 5,
        sampleFrames: 120,
        runsPerRenderer: 3,
      },
      invariants: {
        exactlySixRuns: true,
        isolatedCandidateArtifacts: true,
        everyRunCurrentCandidate: true,
        everyRunProvenanceValid: true,
        uniqueRunIds: true,
        uniqueEvidenceSha256: true,
        uniqueCapturedAt: true,
        buildFingerprintStable: true,
        harnessFingerprintStable: true,
        runtimeFingerprintStable: true,
        everyRunBudgetPassed: true,
        webgpuWholeFrameBudgetPassed: true,
        allPassed: true,
      },
      gate: { status: "GO", reasons: [] },
    });
    expect(artifact.renderers.webgpu.runs[0]).toMatchObject({
      index: 1,
      renderer: "webgpu",
      artifactFile: "browser-label-collision-webgpu-formal-1-1.2.0.json",
      candidateSha256: "4".padStart(64, "0"),
      timings: {
        frameMs: { p50: 16, p95: 16 },
        cpuMs: { p50: 12, p95: 12 },
        commitMs: { p50: 11, p95: 11 },
        collisionMs: { p50: 5, p95: 5 },
      },
      submittedLabels: 512,
      submittedGlyphs: 4_096,
      selectionHash: 1_628_931_525,
      accountingPassed: true,
      budgetPassed: true,
      wholeFrameBudgetPassed: true,
    });
    expect(artifact.renderers.webgl.sourceCandidateArtifacts).toEqual(
      inputs.slice(0, 3).map((input) => ({
        artifactFile: input.artifactFile,
        sha256: input.candidateSha256,
      })),
    );
  });

  test("pauses when one raw candidate is tampered after evidence sealing", async () => {
    const inputs = await collisionRawCandidates();
    const tampered = structuredClone(inputs[0]!.artifact) as BrowserBenchmarkArtifact;
    (tampered.samples[0]!.timings.cpuMs as number[])[0] = 13;
    inputs[0] = { ...inputs[0]!, artifact: tampered };

    const artifact = aggregateCollisionCandidates(inputs);

    expect(artifact.invariants.everyRunProvenanceValid).toBe(false);
    expect(artifact.renderers.webgl.runs[0]).toMatchObject({
      provenanceValid: false,
      failures: expect.arrayContaining(["provenance"]),
    });
    expect(artifact.gate).toEqual({ status: "PAUSE", reasons: ["provenance"] });
  });

  test("pauses duplicate raw files and globally reused run identities", async () => {
    const inputs = await collisionRawCandidates();
    inputs[5] = inputs[4]!;

    const artifact = aggregateCollisionCandidates(inputs);

    expect(artifact.invariants).toMatchObject({
      exactlySixRuns: true,
      isolatedCandidateArtifacts: false,
      uniqueRunIds: false,
      uniqueEvidenceSha256: false,
      uniqueCapturedAt: false,
      uniqueSampleCapturedAt: false,
      allPassed: false,
    });
    expect(artifact.gate).toEqual({
      status: "PAUSE",
      reasons: ["candidate-artifacts", "run-identity"],
    });
  });

  test("pauses a sealed candidate from a stale package version", async () => {
    const inputs = await collisionRawCandidates();
    const stale = structuredClone(inputs[2]!.artifact) as BrowserBenchmarkArtifact;
    (stale as unknown as { packageVersion: string }).packageVersion = "1.1.0";
    inputs[2] = { ...inputs[2]!, artifact: resealCollisionArtifact(stale) };

    const artifact = aggregateCollisionCandidates(inputs);

    expect(artifact.invariants).toMatchObject({
      everyRunCurrentCandidate: false,
      everyRunProvenanceValid: true,
      allPassed: false,
    });
    expect(artifact.renderers.webgl.runs[2]).toMatchObject({
      currentCandidate: false,
      failures: expect.arrayContaining(["current-candidate"]),
    });
    expect(artifact.gate).toEqual({ status: "PAUSE", reasons: ["current-candidate"] });
  });

  test("pauses six stable sealed candidates from a stale build and harness", async () => {
    const inputs = await collisionRawCandidates();
    for (let index = 0; index < inputs.length; index += 1) {
      inputs[index] = {
        ...inputs[index]!,
        artifact: resealCollisionArtifact(inputs[index]!.artifact, {
          buildManifest: COLLISION_ALTERNATE_BUILD_MANIFEST,
          harnessManifest: COLLISION_ALTERNATE_HARNESS_MANIFEST,
        }),
      };
    }

    const artifact = aggregateCollisionCandidates(inputs);

    expect(artifact.invariants).toMatchObject({
      everyRunCurrentCandidate: false,
      everyRunProvenanceValid: true,
      buildFingerprintStable: true,
      harnessFingerprintStable: true,
      allPassed: false,
    });
    expect(artifact.gate).toEqual({ status: "PAUSE", reasons: ["current-candidate"] });
  });

  test("pauses a resealed candidate whose embedded budget decision is stale", async () => {
    const inputs = await collisionRawCandidates();
    const staleBudget = structuredClone(inputs[1]!.artifact) as BrowserBenchmarkArtifact;
    (staleBudget.samples[0]!.timings.cpuMs as number[]).fill(13);
    inputs[1] = { ...inputs[1]!, artifact: resealCollisionArtifact(staleBudget) };

    const artifact = aggregateCollisionCandidates(inputs);

    expect(artifact.renderers.webgl.runs[1]).toMatchObject({
      provenanceValid: true,
      currentCandidate: true,
      budgetSealValid: false,
      budgetPassed: false,
      failures: expect.arrayContaining(["budget-seal"]),
    });
    expect(artifact.gate).toEqual({ status: "PAUSE", reasons: ["budget"] });
  });

  test("pauses intrinsically sealed evidence from an older harness manifest", async () => {
    const inputs = await collisionRawCandidates();
    const olderHarness = structuredClone(inputs[0]!.artifact) as BrowserBenchmarkArtifact;
    const provenance = olderHarness.provenance as unknown as {
      harnessManifest: BrowserBenchmarkHarnessManifestEntry[];
      harnessFingerprintSha256: string;
      evidenceSha256: string;
    };
    provenance.harnessManifest = provenance.harnessManifest.filter(
      (entry) => entry.path !== "benchmarks/label-collision-repeatability.ts",
    );
    provenance.harnessFingerprintSha256 = browserBenchmarkHarnessFingerprintSha256(
      provenance.harnessManifest,
    );
    provenance.evidenceSha256 = browserBenchmarkEvidenceSha256(olderHarness);
    inputs[0] = { ...inputs[0]!, artifact: olderHarness };

    const artifact = aggregateCollisionCandidates(inputs);

    expect(artifact.renderers.webgl.runs[0]).toMatchObject({
      provenanceValid: true,
      currentCandidate: false,
      failures: expect.arrayContaining(["current-candidate"]),
    });
    expect(artifact.gate).toEqual({
      status: "PAUSE",
      reasons: ["current-candidate", "harness-fingerprint"],
    });
  });

  test("pauses candidates from mismatched build, harness, and runtime fingerprints", async () => {
    const inputs = await collisionRawCandidates();
    inputs[4] = {
      ...inputs[4]!,
      artifact: resealCollisionArtifact(inputs[4]!.artifact, {
        buildManifest: COLLISION_ALTERNATE_BUILD_MANIFEST,
      }),
    };
    const runtimeMismatch = structuredClone(inputs[5]!.artifact) as BrowserBenchmarkArtifact;
    (runtimeMismatch.runtime as unknown as { cpu: string }).cpu = "Different benchmark host";
    inputs[5] = {
      ...inputs[5]!,
      artifact: resealCollisionArtifact(runtimeMismatch, {
        harnessManifest: COLLISION_ALTERNATE_HARNESS_MANIFEST,
      }),
    };

    const artifact = aggregateCollisionCandidates(inputs);

    expect(artifact.invariants).toMatchObject({
      everyRunProvenanceValid: true,
      buildFingerprintStable: false,
      harnessFingerprintStable: false,
      runtimeFingerprintStable: false,
      allPassed: false,
    });
    expect(artifact.gate).toEqual({
      status: "PAUSE",
      reasons: [
        "current-candidate",
        "build-fingerprint",
        "harness-fingerprint",
        "runtime-fingerprint",
      ],
    });
  });

  test("pauses workload, renderer, status, and candidate-role mismatches", async () => {
    const mutations: Array<(artifact: BrowserBenchmarkArtifact) => void> = [
      (artifact) => {
        (artifact as unknown as { workload: string }).workload = "million-live";
      },
      (artifact) => {
        (artifact as unknown as { renderer: BrowserBenchmarkRenderer }).renderer = "webgl";
      },
      (artifact) => {
        (artifact as unknown as { status: string }).status = "capacity-limit";
      },
      (artifact) => {
        (artifact as unknown as { artifactRole: string }).artifactRole = "baseline";
      },
    ];

    for (const mutate of mutations) {
      const inputs = await collisionRawCandidates();
      const mismatched = structuredClone(inputs[5]!.artifact) as BrowserBenchmarkArtifact;
      mutate(mismatched);
      inputs[5] = { ...inputs[5]!, artifact: resealCollisionArtifact(mismatched) };
      const artifact = aggregateCollisionCandidates(inputs);

      expect(artifact.invariants.everyRunCurrentCandidate).toBe(false);
      expect(artifact.gate.status).toBe("PAUSE");
      expect(artifact.gate.reasons).toContain("current-candidate");
    }
  });

  test("pauses when one WebGPU run exceeds the whole-frame budget", async () => {
    const inputs = await collisionRawCandidates();
    const overrun = structuredClone(inputs[5]!.artifact) as BrowserBenchmarkArtifact;
    (overrun.samples[0]!.timings.frameMs as number[]).fill(17);
    (overrun as unknown as { budget: unknown }).budget = evaluateLabelCollisionBudget(
      overrun.samples,
      "webgpu",
    );
    inputs[5] = { ...inputs[5]!, artifact: resealCollisionArtifact(overrun) };

    const artifact = aggregateCollisionCandidates(inputs);

    expect(artifact.renderers.webgpu.runs[2]).toMatchObject({
      timings: { frameMs: { p50: 17, p95: 17 } },
      budgetSealValid: true,
      budgetPassed: false,
      wholeFrameBudgetPassed: false,
      failures: expect.arrayContaining(["budget", "webgpu-whole-frame"]),
    });
    expect(artifact.invariants).toMatchObject({
      everyRunBudgetPassed: false,
      webgpuWholeFrameBudgetPassed: false,
      allPassed: false,
    });
    expect(artifact.gate).toEqual({
      status: "PAUSE",
      reasons: ["budget", "webgpu-whole-frame"],
    });
  });

  test("CLI writes the formal artifact and exits zero for GO", async () => {
    const inputs = await currentCollisionRawCandidates();
    const result = await runCollisionRepeatabilityCli(inputs);

    expect(result).toMatchObject({ exitCode: 0 });
    expect(result.artifact).toMatchObject({
      schemaVersion: LABEL_COLLISION_FORMAL_REPEATABILITY_SCHEMA_VERSION,
      gate: { status: "GO", reasons: [] },
    });
    expect(result.artifact.renderers.webgpu.sourceCandidateArtifacts).toHaveLength(3);
    expect(result.artifact.renderers.webgl.sourceCandidateArtifacts[0]).toEqual({
      artifactFile: inputs[0]!.artifactFile,
      sha256: result.firstRawSha256,
    });
  });

  test("CLI writes PAUSE and exits one for a WebGPU whole-frame failure", async () => {
    const inputs = await currentCollisionRawCandidates();
    const overrun = structuredClone(inputs[5]!.artifact) as BrowserBenchmarkArtifact;
    (overrun.samples[0]!.timings.frameMs as number[]).fill(17);
    (overrun as unknown as { budget: unknown }).budget = evaluateLabelCollisionBudget(
      overrun.samples,
      "webgpu",
    );
    inputs[5] = { ...inputs[5]!, artifact: resealCollisionArtifact(overrun) };

    const result = await runCollisionRepeatabilityCli(inputs);

    expect(result).toMatchObject({ exitCode: 1, stderr: "" });
    expect(result.artifact.gate).toEqual({
      status: "PAUSE",
      reasons: ["budget", "webgpu-whole-frame"],
    });
  });
});

function activeScatterRun(
  index: number,
  cpuP95: number,
  frameP95: number,
  collisionP95: number,
  surfaceP95: number,
): LabelCollisionActiveScatterRun {
  return {
    index,
    capturedAt: `2026-08-29T09:01:${String(index * 10).padStart(2, "0")}.000Z`,
    timings: detailedTimings(cpuP95, frameP95, collisionP95, surfaceP95, 65_552),
    submittedLabels: 512,
    submittedGlyphs: 4_096,
    selectionHash: 1_628_931_525,
    accountingPassed: true,
    gpuTimestampSamples: 125,
    budgetPassed: true,
  };
}

function phaseDiagnostic(
  renderer: "webgl" | "webgpu",
  palettePath: "texture" | "storage",
  cpuP95: number,
  surfaceP95: number,
  uploadBytesP95: number,
): LabelCollisionPhaseDiagnostic {
  return {
    renderer,
    sampleFrames: 30,
    palettePath,
    timings: detailedTimings(cpuP95, cpuP95 + 5, 7.7, surfaceP95, uploadBytesP95),
    submittedLabels: 512,
    submittedGlyphs: 4_096,
    selectionHash: 934_053_317,
    accountingPassed: true,
    gpuTimestampSamples: 35,
  };
}

function detailedTimings(
  cpuP95: number,
  frameP95: number,
  collisionP95: number,
  surfaceP95: number,
  uploadBytesP95: number,
): LabelCollisionDetailedTimings {
  return {
    frameMs: { p50: 16, p95: frameP95 },
    cpuMs: { p50: 14, p95: cpuP95 },
    commitMs: { p50: 13.9, p95: cpuP95 - 0.1 },
    collisionMs: { p50: 5.6, p95: collisionP95 },
    visibilitySelectionMs: { p50: 13.8, p95: Math.min(cpuP95, 15.7) },
    renderPreparationMs: { p50: 0.1, p95: 0.5 },
    renderCoordinatorMs: { p50: 0, p95: 0.4 },
    surfaceApplyMs: { p50: 0, p95: surfaceP95 },
    uploadMs: { p50: 0, p95: surfaceP95 },
    uploadBytes: { p50: 0, p95: uploadBytesP95 },
  };
}

async function collisionRawCandidates(
  manifests: CollisionManifests = {
    buildManifest: COLLISION_BUILD_MANIFEST,
    harnessManifest: COLLISION_HARNESS_MANIFEST,
  },
): Promise<LabelCollisionRawCandidateInput[]> {
  const [webgl, webgpu] = (await Promise.all([
    Bun.file(
      new URL(
        "../benchmarks/results/browser-label-collision-webgl-candidate-1.2.0.json",
        import.meta.url,
      ),
    ).json(),
    Bun.file(
      new URL(
        "../benchmarks/results/browser-label-collision-webgpu-candidate-1.2.0.json",
        import.meta.url,
      ),
    ).json(),
  ])) as [BrowserBenchmarkArtifact, BrowserBenchmarkArtifact];
  const inputs: LabelCollisionRawCandidateInput[] = [];
  for (const renderer of ["webgl", "webgpu"] as const) {
    const source = renderer === "webgl" ? webgl : webgpu;
    for (let run = 1; run <= 3; run += 1) {
      const ordinal = inputs.length + 1;
      inputs.push({
        artifactFile: `browser-label-collision-${renderer}-formal-${String(run)}-1.2.0.json`,
        candidateSha256: String(ordinal).padStart(64, "0"),
        artifact: sealCollisionCandidate(source, renderer, ordinal, manifests),
      });
    }
  }
  return inputs;
}

function sealCollisionCandidate(
  source: Readonly<BrowserBenchmarkArtifact>,
  renderer: BrowserBenchmarkRenderer,
  ordinal: number,
  manifests: Readonly<{
    buildManifest: readonly Readonly<BrowserBenchmarkBuildManifestEntry>[];
    harnessManifest: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[];
  }>,
): Readonly<BrowserBenchmarkArtifact> {
  const clone = structuredClone(source) as BrowserBenchmarkArtifact;
  delete (clone as unknown as { provenance?: unknown }).provenance;
  (clone as unknown as { schemaVersion: number }).schemaVersion = BENCHMARK_SCHEMA_VERSION;
  (clone as unknown as { packageVersion: string }).packageVersion = "1.2.0";
  (clone as unknown as { capturedAt: string }).capturedAt = collisionCapturedAt(ordinal);
  (clone as unknown as { renderer: BrowserBenchmarkRenderer }).renderer = renderer;
  (clone as unknown as { workload: string }).workload = "label-collision";
  (clone as unknown as { status: string }).status = "complete";
  (clone as unknown as { artifactRole: string }).artifactRole = "candidate";
  const sample = clone.samples[0]! as unknown as {
    schemaVersion: number;
    capturedAt: string;
    configuration: {
      fixture: string;
      workload: string;
      renderer: BrowserBenchmarkRenderer;
      labelCount: number;
      warmupFrames: number;
      sampleFrames: number;
    };
    timings: {
      frameMs: number[];
      cpuMs: number[];
      commitMs: number[];
      cullingMs: number[];
    };
    counters: {
      rendererAdapter: BrowserBenchmarkRenderer;
    };
  };
  sample.schemaVersion = BENCHMARK_SCHEMA_VERSION;
  sample.capturedAt = collisionCapturedAt(ordinal);
  sample.configuration.fixture = "glyphflow";
  sample.configuration.workload = "label-collision";
  sample.configuration.renderer = renderer;
  sample.configuration.labelCount = 1_000_000;
  sample.configuration.warmupFrames = 5;
  sample.configuration.sampleFrames = 120;
  sample.counters.rendererAdapter = renderer;
  sample.timings.frameMs = Array.from({ length: 120 }, () => (renderer === "webgpu" ? 16 : 20));
  sample.timings.cpuMs = Array.from({ length: 120 }, () => 12);
  sample.timings.commitMs = Array.from({ length: 120 }, () => 11);
  sample.timings.cullingMs = Array.from({ length: 120 }, () => 5);
  (clone as unknown as { budget: unknown }).budget = evaluateLabelCollisionBudget(
    clone.samples,
    renderer,
  );
  return createBrowserBenchmarkArtifact(clone as unknown as BrowserBenchmarkArtifactPayload, {
    runId: collisionRunId(ordinal),
    buildManifest: manifests.buildManifest,
    harnessManifest: manifests.harnessManifest,
  });
}

let currentCollisionManifestsPromise: Promise<CollisionManifests> | undefined;

async function currentCollisionRawCandidates(): Promise<LabelCollisionRawCandidateInput[]> {
  currentCollisionManifestsPromise ??= Promise.all([
    createBrowserBenchmarkBuildManifest(fileURLToPath(new URL("../", import.meta.url))),
    createBrowserBenchmarkHarnessManifest(fileURLToPath(new URL("../", import.meta.url))),
  ]).then(([buildManifest, harnessManifest]) => Object.freeze({ buildManifest, harnessManifest }));
  return collisionRawCandidates(await currentCollisionManifestsPromise);
}

function resealCollisionArtifact(
  artifact: Readonly<BrowserBenchmarkArtifact>,
  options: Partial<CollisionManifests> = {},
): Readonly<BrowserBenchmarkArtifact> {
  const clone = structuredClone(artifact) as BrowserBenchmarkArtifact;
  const provenance = clone.provenance;
  delete (clone as unknown as { provenance?: unknown }).provenance;
  return createBrowserBenchmarkArtifact(clone as unknown as BrowserBenchmarkArtifactPayload, {
    runId: provenance.runId,
    buildManifest: options.buildManifest ?? provenance.buildManifest,
    harnessManifest: options.harnessManifest ?? provenance.harnessManifest,
  });
}

function collisionRunId(ordinal: number): string {
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}

function collisionCapturedAt(ordinal: number): string {
  return `2026-08-29T00:00:${String(ordinal).padStart(2, "0")}.000Z`;
}

async function writeCollisionRawCandidates(
  directory: string,
  inputs: readonly Readonly<LabelCollisionRawCandidateInput>[],
): Promise<string[]> {
  const paths: string[] = [];
  for (const input of inputs) {
    const path = resolve(directory, input.artifactFile);
    await Bun.write(path, `${JSON.stringify(input.artifact, undefined, 2)}\n`);
    paths.push(path);
  }
  return paths;
}

function aggregateCollisionCandidates(inputs: readonly LabelCollisionRawCandidateInput[]) {
  return aggregateLabelCollisionRepeatability(
    inputs,
    COLLISION_AGGREGATED_AT,
    COLLISION_CURRENT_IDENTITY,
  );
}

async function runCollisionRepeatabilityCli(
  inputs: readonly Readonly<LabelCollisionRawCandidateInput>[],
): Promise<{
  readonly artifact: LabelCollisionFormalRepeatabilityArtifact;
  readonly exitCode: number;
  readonly firstRawSha256: string;
  readonly stderr: string;
}> {
  const directory = await mkdtemp(resolve(tmpdir(), "pixi-glyphflow-collision-repeatability-"));
  try {
    const paths = await writeCollisionRawCandidates(directory, inputs);
    const output = resolve(directory, "browser-label-collision-repeatability-1.2.0.json");
    const subprocess = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../benchmarks/label-collision-repeatability.ts", import.meta.url)),
        ...paths,
        "--output",
        output,
      ],
      { stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stderr).text(),
      new Response(subprocess.stdout).text(),
    ]);
    const [artifact, firstRawBytes] = await Promise.all([
      Bun.file(output).json() as Promise<LabelCollisionFormalRepeatabilityArtifact>,
      Bun.file(paths[0]!).bytes(),
    ]);

    return { artifact, exitCode, firstRawSha256: sha256(firstRawBytes), stderr };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
