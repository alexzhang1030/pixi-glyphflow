import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BROWSER_BENCHMARK_HARNESS_PATHS,
  createBrowserBenchmarkArtifact,
} from "../benchmarks/artifacts";
import { captureBrowserGpuAdapterIdentity } from "../benchmarks/browser/gpu-identity";
import {
  aggregateGpuSceneResidentRepeatability,
  type GpuSceneResidentRepeatabilityInput,
  type GpuSceneResidentSustainedInput,
} from "../benchmarks/gpu-scene-resident-repeatability";
import {
  BENCHMARK_SCHEMA_VERSION,
  isCompleteBrowserGpuAdapterIdentity,
  type BrowserBenchmarkArtifact,
  type BrowserBenchmarkArtifactPayload,
  type BrowserBenchmarkBuildManifestEntry,
  type BrowserBenchmarkHarnessManifestEntry,
  type BrowserBenchmarkPhaseTimings,
} from "../benchmarks/schema";

const candidatePath = new URL(
  "../benchmarks/results/browser-gpu-scene-resident-webgpu-candidate-1.2.0.json",
  import.meta.url,
);

async function readCandidateArtifact(): Promise<BrowserBenchmarkArtifact> {
  return (await Bun.file(candidatePath).json()) as BrowserBenchmarkArtifact;
}

const repeatabilityCliPath = fileURLToPath(
  new URL("../benchmarks/gpu-scene-resident-repeatability.ts", import.meta.url),
);
const BUILD_MANIFEST: readonly Readonly<BrowserBenchmarkBuildManifestEntry>[] = Object.freeze([
  Object.freeze({ path: "assets/benchmark.js", bytes: 4, sha256: "1".repeat(64) }),
]);
const ALTERNATE_BUILD_MANIFEST: readonly Readonly<BrowserBenchmarkBuildManifestEntry>[] =
  Object.freeze([Object.freeze({ path: "assets/benchmark.js", bytes: 4, sha256: "2".repeat(64) })]);
const HARNESS_MANIFEST: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[] = Object.freeze(
  BROWSER_BENCHMARK_HARNESS_PATHS.map((path, index) =>
    Object.freeze({
      path,
      bytes: index + 1,
      sha256: (index + 1).toString(16).padStart(64, "0"),
    }),
  ),
);
const ALTERNATE_HARNESS_MANIFEST: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[] =
  Object.freeze(
    HARNESS_MANIFEST.map((entry, index) =>
      index === 0 ? Object.freeze({ ...entry, sha256: "f".repeat(64) }) : entry,
    ),
  );
const GPU_ADAPTER = Object.freeze({
  vendor: "apple",
  architecture: "apple-gpu",
  device: "Apple M4",
  description: "Apple M4",
  timestampQuery: true,
  limits: Object.freeze({
    maxStorageBufferBindingSize: 4_294_967_296,
    maxBufferSize: 4_294_967_296,
    maxStorageBuffersPerShaderStage: 8,
    maxStorageBuffersInVertexStage: 8,
    maxComputeWorkgroupStorageSize: 32_768,
    maxComputeInvocationsPerWorkgroup: 1_024,
    maxComputeWorkgroupSizeX: 1_024,
    maxComputeWorkgroupSizeY: 1_024,
    maxComputeWorkgroupSizeZ: 64,
    maxComputeWorkgroupsPerDimension: 65_535,
  }),
});
const ALTERNATE_GPU_ADAPTER = Object.freeze({
  ...GPU_ADAPTER,
  device: "Apple M3",
  limits: Object.freeze({
    ...GPU_ADAPTER.limits,
    maxStorageBufferBindingSize: 2_147_483_648,
  }),
});

test("captures WebGPU adapter info, timestamp support, and device limits", () => {
  const identity = captureBrowserGpuAdapterIdentity({
    adapter: {
      info: {
        vendor: "apple",
        architecture: "apple-gpu",
        device: "Apple M4",
        description: "Apple M4",
      },
    },
    device: {
      features: new Set(["timestamp-query"]),
      limits: GPU_ADAPTER.limits,
    },
  } as never);

  expect(identity).toEqual(GPU_ADAPTER);
});

test("requires one disclosed adapter identity field while accepting partial redaction", () => {
  expect(
    isCompleteBrowserGpuAdapterIdentity({
      ...GPU_ADAPTER,
      architecture: "",
      device: "",
      description: "",
    }),
  ).toBe(true);
  expect(
    isCompleteBrowserGpuAdapterIdentity({
      ...GPU_ADAPTER,
      vendor: "",
      architecture: "",
      device: "",
      description: "",
    }),
  ).toBe(false);
});

describe("GPU-resident five-run promotion aggregation", () => {
  test("records five isolated candidates as truth-ready while release awaits sustained evidence", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      schemaVersion: 4,
      kind: "pixi-glyphflow-gpu-scene-resident-repeatability",
      summary: {
        runCount: 5,
        uniqueCandidateShaCount: 5,
        outputIdentityStable: true,
        camera: { samples: 600, overBudgetCount: 0 },
        positionMutation: { samples: 600, overBudgetCount: 0 },
        timestamps: {
          fusedTimestampResolves: 1_300,
          standaloneTimestampSubmissions: 0,
          segmentedSamples: 1_300,
          validSegmentedSamples: 1_300,
          segments: {
            palette: {
              samples: 1_300,
              validSamples: 1_300,
              arraySamples: 1_200,
              arrayValidSamples: 1_200,
              p50Ms: 0,
              p95Ms: 1,
            },
            cull: {
              samples: 1_300,
              validSamples: 1_300,
              arraySamples: 1_200,
              arrayValidSamples: 1_200,
              p50Ms: 1,
              p95Ms: 1,
            },
            sceneRender: {
              samples: 1_300,
              validSamples: 1_300,
              arraySamples: 1_200,
              arrayValidSamples: 1_200,
              p50Ms: 3,
              p95Ms: 4,
            },
          },
        },
      },
      invariants: {
        everyRunProvenanceValid: true,
        uniqueRunIds: true,
        uniqueCapturedAt: true,
        everyRunCapturedAtValid: true,
        everyRunSampleCapturedAtValid: true,
        everyRunSampleCapturedAtNotAfterArtifact: true,
        uniqueSampleCapturedAt: true,
        uniqueEvidenceSha256: true,
        buildFingerprintStable: true,
        harnessFingerprintStable: true,
        formalPerformanceReady: true,
        everyRunSegmentedTimestampExact: true,
      },
      truthRepeatability: { status: "GO", reasons: [] },
      promotion: { status: "PAUSE", reasons: ["sustained-600"] },
    });
    expect(result.runs.map((run) => run.candidateSha256)).toEqual(
      inputs.map((input) => input.candidateSha256),
    );
    expect(
      result.runs.every(
        (run) =>
          run.outputIdentity.renderedPixelHash === 0xa8ad_90b4 &&
          run.outputIdentity.nonTransparentPixels === 302_457 &&
          run.timestamps.fusedTimestampResolves === 260 &&
          run.timestamps.standaloneTimestampSubmissions === 0 &&
          run.timestamps.segmentedExact &&
          run.timestamps.segments.palette.samples === 260 &&
          run.timestamps.segments.palette.arraySamples === 240,
      ),
    ).toBe(true);
  });

  test("keeps truth repeatability ready while formal timing overruns pause promotion", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    for (const [index, input] of inputs.entries()) {
      const overrun = structuredClone(input.artifact) as BrowserBenchmarkArtifact;
      const phases = overrun.samples[0]!.timings.phases!;
      for (const phase of [phases.camera, phases.positionMutation]) {
        (phase.frameMs as number[]).fill(20);
        refreshTailTelemetry(phase as unknown as { frameMs: number[] });
      }
      inputs[index] = { ...input, artifact: resealArtifact(overrun) };
    }

    const result = aggregateGpuSceneResidentRepeatability(
      inputs,
      "2026-08-29T12:00:00.000Z",
      resealSustained(sustainedInput(candidate)),
    );

    expect(result).toMatchObject({
      invariants: {
        everyRunFormal: true,
        everyRunBudgetPassed: false,
        formalPerformanceReady: false,
        truthRepeatabilityReady: true,
        sustained600Ready: true,
        promotionReady: false,
      },
      truthRepeatability: { status: "GO", reasons: [] },
      promotion: { status: "PAUSE", reasons: ["formal-performance"] },
    });
    expect(
      result.runs.every(
        (run) =>
          run.camera.samples === 120 &&
          run.positionMutation.samples === 120 &&
          run.provenanceValid &&
          run.exactCanonicalOutput &&
          !run.budgetPassed,
      ),
    ).toBe(true);
  });

  test("pauses truth repeatability when a formal artifact omits a timestamp segment", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const missing = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    delete (missing.samples[0]!.timings as { paletteGpuTimestampMs?: unknown })
      .paletteGpuTimestampMs;
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(missing) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: {
        everyRunSegmentedTimestampExact: false,
        truthRepeatabilityReady: false,
      },
      truthRepeatability: { status: "PAUSE", reasons: ["timestamp-segments"] },
    });
    expect(result.runs[4]).toMatchObject({
      timestamps: {
        segmentedExact: false,
        segments: { palette: { arraySamples: 0, arrayValidSamples: 0 } },
      },
      failures: expect.arrayContaining(["timestamp-segments"]),
    });
  });

  test("pauses truth repeatability when a formal segment count differs from fused resolves", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const wrongCount = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    (
      wrongCount.samples[0]!.timings.gpuTiming as unknown as {
        validPaletteSamples: number;
      }
    ).validPaletteSamples = 259;
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(wrongCount) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: {
        everyRunSegmentedTimestampExact: false,
        truthRepeatabilityReady: false,
      },
      truthRepeatability: { status: "PAUSE", reasons: ["timestamp-segments"] },
    });
    expect(result.runs[4]).toMatchObject({
      timestamps: {
        segmentedExact: false,
        segments: { palette: { samples: 260, validSamples: 259 } },
      },
      failures: expect.arrayContaining(["timestamp-segments"]),
    });
  });

  test("pauses truth repeatability for reordered and over-total formal timestamp segments", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const reordered = structuredClone(inputs[3]!.artifact) as BrowserBenchmarkArtifact;
    (reordered.samples[0]!.timings.paletteGpuTimestampMs as number[])[0] = 1;
    inputs[3] = { ...inputs[3]!, artifact: resealArtifact(reordered) };

    const overTotal = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    const timings = overTotal.samples[0]!.timings;
    (timings.phases!.camera.paletteGpuTimestampMs as number[])[0] = 6;
    (timings.paletteGpuTimestampMs as number[])[0] = 6;
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(overTotal) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result.truthRepeatability).toEqual({
      status: "PAUSE",
      reasons: ["timestamp-segments"],
    });
    expect(result.runs[3]?.failures).toEqual(expect.arrayContaining(["timestamp-segments"]));
    expect(result.runs[4]?.failures).toEqual(expect.arrayContaining(["timestamp-segments"]));
  });

  test("returns a failing CLI exit code for missing and tampered timestamp segments", async () => {
    const candidate = await readCandidateArtifact();
    const directory = await mkdtemp(join(tmpdir(), "glyphflow-resident-repeatability-"));
    try {
      const formalPaths: string[] = [];
      for (const input of fiveInputs(candidate)) {
        const path = join(directory, input.artifactFile);
        await Bun.write(path, `${JSON.stringify(input.artifact)}\n`);
        formalPaths.push(path);
      }
      const sustainedPath = join(directory, "resident-sustained-600.json");
      await Bun.write(sustainedPath, `${JSON.stringify(sustainedInput(candidate).artifact)}\n`);

      expect(
        await repeatabilityCliExitCode(
          formalPaths,
          sustainedPath,
          join(directory, "exact-output.json"),
        ),
      ).toBe(0);

      const missing = structuredClone(
        fiveInputs(candidate)[4]!.artifact,
      ) as BrowserBenchmarkArtifact;
      delete (missing.samples[0]!.timings as { sceneRenderGpuTimestampMs?: unknown })
        .sceneRenderGpuTimestampMs;
      const missingPath = join(directory, "resident-repeat-missing.json");
      await Bun.write(missingPath, `${JSON.stringify(resealArtifact(missing))}\n`);
      expect(
        await repeatabilityCliExitCode(
          [...formalPaths.slice(0, 4), missingPath],
          sustainedPath,
          join(directory, "missing-output.json"),
        ),
      ).toBe(1);

      const tampered = structuredClone(
        fiveInputs(candidate)[4]!.artifact,
      ) as BrowserBenchmarkArtifact;
      const tamperedTimings = tampered.samples[0]!.timings;
      (tamperedTimings.phases!.camera.cullGpuTimestampMs as number[])[0] = 6;
      (tamperedTimings.cullGpuTimestampMs as number[])[0] = 6;
      const tamperedPath = join(directory, "resident-repeat-tampered.json");
      await Bun.write(tamperedPath, `${JSON.stringify(resealArtifact(tampered))}\n`);
      expect(
        await repeatabilityCliExitCode(
          [...formalPaths.slice(0, 4), tamperedPath],
          sustainedPath,
          join(directory, "tampered-output.json"),
        ),
      ).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects a non-canonical repeatability artifact timestamp", async () => {
    const candidate = await readCandidateArtifact();

    expect(() =>
      aggregateGpuSceneResidentRepeatability(fiveInputs(candidate), "repeatability-run"),
    ).toThrow("canonical ISO timestamp");
  });

  test("requires repeatability capturedAt at or after formal and sustained artifacts", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const sustained = sustainedInput(candidate);

    expect(() => aggregateGpuSceneResidentRepeatability(inputs, capturedAt(4))).toThrow(
      "at or after every input artifact timestamp",
    );
    expect(() => aggregateGpuSceneResidentRepeatability(inputs, capturedAt(5), sustained)).toThrow(
      "at or after every input artifact timestamp",
    );
    expect(
      aggregateGpuSceneResidentRepeatability(inputs, capturedAt(6), sustained).capturedAt,
    ).toBe(capturedAt(6));
  });

  test("pauses promotion when one repeated readback agrees with the wrong pixel identity", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const broken = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    const counters = broken.samples[0]!.counters as unknown as Record<string, unknown>;
    counters.renderedPixelHash = 0xa8ad_90b5;
    counters.renderedPixelHashRepeat = 0xa8ad_90b5;
    counters.nonTransparentPixels = 302_456;
    counters.nonTransparentPixelsRepeat = 302_456;
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(broken) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result.truthRepeatability).toEqual({
      status: "PAUSE",
      reasons: ["output-identity"],
    });
    expect(result.promotion).toEqual({
      status: "PAUSE",
      reasons: ["truth-repeatability", "formal-performance", "sustained-600"],
    });
    expect(result.runs[4]).toMatchObject({
      exactCanonicalOutput: false,
      failures: expect.arrayContaining(["canonical-output-identity"]),
    });
  });

  test("recomputes the current budget when embedded pass telemetry is stale", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const broken = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    const camera = broken.samples[0]!.timings.phases!.camera as unknown as {
      frameMs: number[];
    };
    camera.frameMs[0] = 1_000;
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(broken) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(broken.budget?.passed).toBe(true);
    expect(result.truthRepeatability).toEqual({ status: "GO", reasons: [] });
    expect(result.promotion).toEqual({
      status: "PAUSE",
      reasons: ["formal-performance", "sustained-600"],
    });
    expect(result.invariants.formalPerformanceReady).toBe(false);
    expect(result.runs[4]).toMatchObject({
      budgetPassed: false,
      failures: expect.arrayContaining(["budget"]),
    });
  });

  test("pauses truth repeatability when one 120-frame artifact comes from another package version", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const mixedVersion = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    (mixedVersion as unknown as { packageVersion: string }).packageVersion = "1.2.1";
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(mixedVersion) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      packageVersion: "1.2.0",
      invariants: { everyRunPackageVersionExact: false },
      truthRepeatability: { status: "PAUSE", reasons: ["package-version", "run-gates"] },
      promotion: {
        status: "PAUSE",
        reasons: ["truth-repeatability", "sustained-600"],
      },
    });
    expect(result.runs[4]).toMatchObject({
      packageVersion: "1.2.1",
      packageVersionExact: false,
      failures: expect.arrayContaining(["package-version"]),
    });
  });

  test("pauses truth repeatability when the five artifacts mix runtime fingerprints", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const mixedRuntime = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    (mixedRuntime.runtime as unknown as { cpu: string }).cpu = "Different benchmark host";
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(mixedRuntime) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: { everyRunRuntimeFingerprintComplete: true, runtimeFingerprintStable: false },
      truthRepeatability: { status: "PAUSE", reasons: ["runtime-fingerprint"] },
      promotion: {
        status: "PAUSE",
        reasons: ["truth-repeatability", "sustained-600"],
      },
    });
    expect(result.runs[4]).toMatchObject({
      runtimeFingerprintComplete: true,
      runtimeFingerprint: { cpu: "Different benchmark host" },
    });
  });

  test("pauses truth repeatability when the five artifacts mix GPU adapter limits", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const mixedAdapter = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    (mixedAdapter as unknown as { gpuAdapter: unknown }).gpuAdapter = ALTERNATE_GPU_ADAPTER;
    (mixedAdapter.samples[0] as unknown as { gpuAdapter: unknown }).gpuAdapter =
      ALTERNATE_GPU_ADAPTER;
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(mixedAdapter) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: { everyRunRuntimeFingerprintComplete: true, runtimeFingerprintStable: false },
      truthRepeatability: { status: "PAUSE", reasons: ["runtime-fingerprint"] },
    });
    expect(result.runs[4]).toMatchObject({
      runtimeFingerprintComplete: true,
      runtimeFingerprint: {
        gpuAdapter: { device: "Apple M3", limits: { maxStorageBufferBindingSize: 2_147_483_648 } },
      },
    });
  });

  test("pauses truth repeatability when a GPU adapter identity field is missing", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const incompleteAdapter = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    delete (incompleteAdapter.samples[0] as unknown as { gpuAdapter?: unknown }).gpuAdapter;
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(incompleteAdapter) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: { everyRunRuntimeFingerprintComplete: false, runtimeFingerprintStable: false },
      truthRepeatability: {
        status: "PAUSE",
        reasons: ["runtime-fingerprint", "run-gates"],
      },
    });
    expect(result.runs[4]).toMatchObject({
      runtimeFingerprint: null,
      runtimeFingerprintComplete: false,
      failures: expect.arrayContaining(["runtime-fingerprint"]),
    });
  });

  test("pauses truth repeatability when sample and artifact GPU identities diverge", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const divergent = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    (divergent.samples[0] as unknown as { gpuAdapter: unknown }).gpuAdapter = ALTERNATE_GPU_ADAPTER;
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(divergent) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: { everyRunRuntimeFingerprintComplete: false, runtimeFingerprintStable: false },
      truthRepeatability: { status: "PAUSE", reasons: ["runtime-fingerprint", "run-gates"] },
    });
    expect(result.runs[4]?.runtimeFingerprintComplete).toBe(false);
  });

  test("pauses truth repeatability when a runtime fingerprint field is missing", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const incompleteRuntime = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    delete (incompleteRuntime.samples[0] as unknown as { userAgent?: string }).userAgent;
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(incompleteRuntime) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: { everyRunRuntimeFingerprintComplete: false, runtimeFingerprintStable: false },
      truthRepeatability: {
        status: "PAUSE",
        reasons: ["runtime-fingerprint", "run-gates"],
      },
    });
    expect(result.runs[4]).toMatchObject({
      runtimeFingerprint: null,
      runtimeFingerprintComplete: false,
      failures: expect.arrayContaining(["runtime-fingerprint"]),
    });
  });

  test("pauses truth repeatability when a copied artifact changes only capturedAt", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const copied = structuredClone(inputs[3]!.artifact) as BrowserBenchmarkArtifact;
    (copied as unknown as { capturedAt: string }).capturedAt = inputs[4]!.artifact.capturedAt;
    (copied.samples[0] as unknown as { capturedAt: string }).capturedAt =
      inputs[4]!.artifact.samples[0]!.capturedAt;
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(copied) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: {
        everyRunProvenanceValid: true,
        uniqueRunIds: false,
        uniqueCapturedAt: true,
        uniqueEvidenceSha256: true,
      },
      truthRepeatability: { status: "PAUSE", reasons: ["run-identity"] },
    });
  });

  test("pauses truth repeatability when two sealed artifacts share capturedAt", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const duplicateCapturedAt = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    (duplicateCapturedAt as unknown as { capturedAt: string }).capturedAt =
      inputs[3]!.artifact.capturedAt;
    (duplicateCapturedAt.samples[0] as unknown as { capturedAt: string }).capturedAt =
      inputs[3]!.artifact.samples[0]!.capturedAt;
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(duplicateCapturedAt) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: {
        everyRunProvenanceValid: true,
        uniqueRunIds: true,
        uniqueCapturedAt: false,
        uniqueEvidenceSha256: true,
      },
      truthRepeatability: { status: "PAUSE", reasons: ["run-identity"] },
    });
  });

  test("pauses five sealed artifacts with unique non-ISO artifact timestamps", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    for (const [index, input] of inputs.entries()) {
      const invalidTimestamp = structuredClone(input.artifact) as BrowserBenchmarkArtifact;
      (invalidTimestamp as unknown as { capturedAt: string }).capturedAt =
        `formal-run-${String(index + 1)}`;
      inputs[index] = { ...input, artifact: resealArtifact(invalidTimestamp) };
    }

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: {
        everyRunProvenanceValid: true,
        uniqueCapturedAt: true,
        everyRunCapturedAtValid: false,
        everyRunSampleCapturedAtNotAfterArtifact: false,
      },
      truthRepeatability: {
        status: "PAUSE",
        reasons: ["run-identity", "run-gates"],
      },
    });
    expect(result.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capturedAtValid: false,
          sampleCapturedAtNotAfterArtifact: false,
          failures: expect.arrayContaining(["captured-at", "sample-captured-at-order"]),
        }),
      ]),
    );
  });

  test("pauses a sealed formal artifact whose sample timestamp follows its artifact timestamp", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const reversed = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    (reversed as unknown as { capturedAt: string }).capturedAt = "2026-08-29T11:58:59.000Z";
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(reversed) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: {
        everyRunProvenanceValid: true,
        uniqueCapturedAt: true,
        everyRunCapturedAtValid: true,
        everyRunSampleCapturedAtValid: true,
        everyRunSampleCapturedAtNotAfterArtifact: false,
      },
      truthRepeatability: {
        status: "PAUSE",
        reasons: ["run-identity", "run-gates"],
      },
    });
    expect(result.runs[4]).toMatchObject({
      capturedAtValid: true,
      sampleCapturedAtValid: true,
      sampleCapturedAtNotAfterArtifact: false,
      exactFormalArtifact: false,
      failures: expect.arrayContaining(["sample-captured-at-order", "formal-artifact"]),
    });
  });

  test("pauses five resealed clones that preserve one inner sample timestamp", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const sharedSampleCapturedAt = inputs[0]!.artifact.samples[0]!.capturedAt;
    for (const [index, input] of inputs.entries()) {
      const clone = structuredClone(input.artifact) as BrowserBenchmarkArtifact;
      (clone.samples[0] as unknown as { capturedAt: string }).capturedAt = sharedSampleCapturedAt;
      inputs[index] = { ...input, artifact: resealArtifact(clone) };
    }

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: {
        everyRunProvenanceValid: true,
        uniqueRunIds: true,
        uniqueCapturedAt: true,
        uniqueEvidenceSha256: true,
        everyRunSampleCapturedAtValid: true,
        uniqueSampleCapturedAt: false,
      },
      truthRepeatability: { status: "PAUSE", reasons: ["run-identity"] },
    });
    expect(result.runs.map((run) => run.sampleCapturedAt)).toEqual(
      Array.from({ length: 5 }, () => sharedSampleCapturedAt),
    );
  });

  test("pauses a sealed formal artifact with an invalid inner sample timestamp", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const invalidTimestamp = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    (invalidTimestamp.samples[0] as unknown as { capturedAt: string }).capturedAt =
      "2026-08-29T12:00:99.000Z";
    inputs[4] = { ...inputs[4]!, artifact: resealArtifact(invalidTimestamp) };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: {
        everyRunProvenanceValid: true,
        everyRunSampleCapturedAtValid: false,
        uniqueSampleCapturedAt: true,
      },
      truthRepeatability: {
        status: "PAUSE",
        reasons: ["run-identity", "run-gates"],
      },
    });
    expect(result.runs[4]).toMatchObject({
      sampleCapturedAt: "2026-08-29T12:00:99.000Z",
      sampleCapturedAtValid: false,
      exactFormalArtifact: false,
      failures: expect.arrayContaining(["sample-captured-at", "formal-artifact"]),
    });
  });

  test("pauses truth repeatability when evidence identity is duplicated", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const duplicateEvidence = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    (duplicateEvidence.provenance as unknown as { evidenceSha256: string }).evidenceSha256 =
      inputs[3]!.artifact.provenance.evidenceSha256;
    inputs[4] = { ...inputs[4]!, artifact: duplicateEvidence };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: {
        everyRunProvenanceValid: false,
        uniqueRunIds: true,
        uniqueCapturedAt: true,
        uniqueEvidenceSha256: false,
      },
      truthRepeatability: {
        status: "PAUSE",
        reasons: ["provenance", "run-identity", "run-gates"],
      },
    });
  });

  test("pauses truth repeatability when one formal artifact has another build fingerprint", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    inputs[4] = {
      ...inputs[4]!,
      artifact: resealArtifact(inputs[4]!.artifact, {
        buildManifest: ALTERNATE_BUILD_MANIFEST,
      }),
    };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: { everyRunProvenanceValid: true, buildFingerprintStable: false },
      truthRepeatability: { status: "PAUSE", reasons: ["build-fingerprint"] },
    });
  });

  test("pauses truth repeatability when the five artifacts mix harness fingerprints", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    inputs[4] = {
      ...inputs[4]!,
      artifact: resealArtifact(inputs[4]!.artifact, {
        harnessManifest: ALTERNATE_HARNESS_MANIFEST,
      }),
    };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: { everyRunProvenanceValid: true, harnessFingerprintStable: false },
      truthRepeatability: { status: "PAUSE", reasons: ["harness-fingerprint"] },
    });
  });

  test("pauses truth repeatability when artifact evidence is stale", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const tampered = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    (tampered as unknown as { capturedAt: string }).capturedAt = "2026-08-29T11:59:30.000Z";
    inputs[4] = { ...inputs[4]!, artifact: tampered };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: { everyRunProvenanceValid: false },
      truthRepeatability: {
        status: "PAUSE",
        reasons: ["provenance", "run-gates"],
      },
    });
    expect(result.runs[4]).toMatchObject({
      provenanceValid: false,
      failures: expect.arrayContaining(["provenance"]),
    });
  });

  test("pauses truth repeatability when the build manifest no longer matches its fingerprint", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const tampered = structuredClone(inputs[4]!.artifact) as BrowserBenchmarkArtifact;
    (
      tampered.provenance.buildManifest[0] as unknown as {
        bytes: number;
      }
    ).bytes = 5;
    inputs[4] = { ...inputs[4]!, artifact: tampered };

    const result = aggregateGpuSceneResidentRepeatability(inputs, "2026-08-29T12:00:00.000Z");

    expect(result).toMatchObject({
      invariants: { everyRunProvenanceValid: false, buildFingerprintStable: true },
      truthRepeatability: {
        status: "PAUSE",
        reasons: ["provenance", "run-gates"],
      },
    });
  });

  test("opens release promotion with one continuous 600+600 tail artifact", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained(sustained),
    );

    expect(result.truthRepeatability).toEqual({ status: "GO", reasons: [] });
    expect(result.sustained600).toMatchObject({
      eligible: true,
      provenanceValid: true,
      buildFingerprintMatchesTruthRuns: true,
      harnessFingerprintMatchesTruthRuns: true,
      capturedAtValid: true,
      sampleCapturedAtValid: true,
      sampleCapturedAtNotAfterArtifact: true,
      sampleCapturedAtDistinctFromTruthRuns: true,
      runIdentityDistinctFromTruthRuns: true,
      camera: { samples: 600, p99Ms: 10, maxMs: 10, overBudgetCount: 0 },
      positionMutation: { samples: 600, p99Ms: 14, maxMs: 14, overBudgetCount: 0 },
      timestamps: {
        fusedTimestampResolves: 1_220,
        standaloneTimestampSubmissions: 0,
        segmentedSamples: 1_220,
        validSegmentedSamples: 1_220,
        segmentedExact: true,
        segments: {
          palette: {
            samples: 1_220,
            validSamples: 1_220,
            arraySamples: 1_200,
            arrayValidSamples: 1_200,
            p50Ms: 0,
            p95Ms: 1,
          },
          cull: {
            samples: 1_220,
            validSamples: 1_220,
            arraySamples: 1_200,
            arrayValidSamples: 1_200,
            p50Ms: 1,
            p95Ms: 1,
          },
          sceneRender: {
            samples: 1_220,
            validSamples: 1_220,
            arraySamples: 1_200,
            arrayValidSamples: 1_200,
            p50Ms: 3,
            p95Ms: 4,
          },
        },
      },
    });
    expect(result.promotion).toEqual({ status: "GO", reasons: [] });
  });

  test("pauses sustained readiness when segmented timestamp evidence is incomplete", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    const missing = structuredClone(sustained.artifact) as BrowserBenchmarkArtifact;
    delete (missing.samples[0]!.timings as { cullGpuTimestampMs?: unknown }).cullGpuTimestampMs;

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      { ...sustained, artifact: resealArtifact(missing) },
    );

    expect(result).toMatchObject({
      invariants: { truthRepeatabilityReady: true, sustained600Ready: false },
      sustained600: {
        eligible: false,
        timestamps: {
          segmentedExact: false,
          segments: { cull: { arraySamples: 0, arrayValidSamples: 0 } },
        },
        failures: expect.arrayContaining(["timestamp-segments"]),
      },
      promotion: { status: "PAUSE", reasons: ["sustained-600"] },
    });
  });

  test("pauses release promotion when sustained artifact evidence is stale", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    const tampered = structuredClone(sustained.artifact) as BrowserBenchmarkArtifact;
    (tampered as unknown as { capturedAt: string }).capturedAt = "2026-08-29T11:59:40.000Z";

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      { ...sustained, artifact: tampered },
    );

    expect(result.sustained600).toMatchObject({
      provenanceValid: false,
      eligible: false,
      failures: expect.arrayContaining(["provenance", "sustained-artifact"]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("pauses sealed sustained evidence with a non-ISO artifact timestamp", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    const invalidTimestamp = structuredClone(sustained.artifact) as BrowserBenchmarkArtifact;
    (invalidTimestamp as unknown as { capturedAt: string }).capturedAt = "sustained-run";

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained({ ...sustained, artifact: invalidTimestamp }),
    );

    expect(result.sustained600).toMatchObject({
      provenanceValid: true,
      capturedAtValid: false,
      sampleCapturedAtValid: true,
      sampleCapturedAtNotAfterArtifact: false,
      runIdentityDistinctFromTruthRuns: false,
      exactSustainedArtifact: false,
      eligible: false,
      failures: expect.arrayContaining([
        "captured-at",
        "sample-captured-at-order",
        "run-identity",
        "sustained-artifact",
      ]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("pauses sealed sustained evidence whose sample timestamp follows its artifact timestamp", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    const reversed = structuredClone(sustained.artifact) as BrowserBenchmarkArtifact;
    (reversed as unknown as { capturedAt: string }).capturedAt = "2026-08-29T11:58:58.000Z";

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained({ ...sustained, artifact: reversed }),
    );

    expect(result.sustained600).toMatchObject({
      provenanceValid: true,
      capturedAtValid: true,
      sampleCapturedAtValid: true,
      sampleCapturedAtNotAfterArtifact: false,
      runIdentityDistinctFromTruthRuns: false,
      exactSustainedArtifact: false,
      eligible: false,
      failures: expect.arrayContaining([
        "sample-captured-at-order",
        "run-identity",
        "sustained-artifact",
      ]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("pauses sustained evidence that reuses a formal inner sample timestamp", async () => {
    const candidate = await readCandidateArtifact();
    const inputs = fiveInputs(candidate);
    const sustained = sustainedInput(candidate);
    const duplicateSampleTimestamp = structuredClone(
      sustained.artifact,
    ) as BrowserBenchmarkArtifact;
    (duplicateSampleTimestamp.samples[0] as unknown as { capturedAt: string }).capturedAt =
      inputs[4]!.artifact.samples[0]!.capturedAt;

    const result = aggregateGpuSceneResidentRepeatability(
      inputs,
      "2026-08-29T12:00:00.000Z",
      resealSustained({ ...sustained, artifact: duplicateSampleTimestamp }),
    );

    expect(result.truthRepeatability).toEqual({ status: "GO", reasons: [] });
    expect(result.sustained600).toMatchObject({
      sampleCapturedAt: inputs[4]!.artifact.samples[0]!.capturedAt,
      sampleCapturedAtValid: true,
      sampleCapturedAtDistinctFromTruthRuns: false,
      runIdentityDistinctFromTruthRuns: false,
      eligible: false,
      failures: expect.arrayContaining(["run-identity"]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("pauses sustained evidence with an invalid inner sample timestamp", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    const invalidTimestamp = structuredClone(sustained.artifact) as BrowserBenchmarkArtifact;
    (invalidTimestamp.samples[0] as unknown as { capturedAt: string }).capturedAt =
      "2026-08-29T12:00:99.000Z";

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained({ ...sustained, artifact: invalidTimestamp }),
    );

    expect(result.sustained600).toMatchObject({
      sampleCapturedAt: "2026-08-29T12:00:99.000Z",
      sampleCapturedAtValid: false,
      sampleCapturedAtDistinctFromTruthRuns: false,
      runIdentityDistinctFromTruthRuns: false,
      exactSustainedArtifact: false,
      eligible: false,
      failures: expect.arrayContaining([
        "sample-captured-at",
        "run-identity",
        "sustained-artifact",
      ]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("pauses release promotion when sustained evidence comes from another package version", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    const mixedVersion = structuredClone(sustained.artifact) as BrowserBenchmarkArtifact;
    (mixedVersion as unknown as { packageVersion: string }).packageVersion = "1.2.1";

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained({ ...sustained, artifact: mixedVersion }),
    );

    expect(result.sustained600).toMatchObject({
      packageVersion: "1.2.1",
      packageVersionExact: false,
      eligible: false,
      failures: expect.arrayContaining(["package-version"]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("pauses release promotion when sustained evidence comes from another runtime", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    (sustained.artifact.runtime as unknown as { release: string }).release = "different-release";

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained(sustained),
    );

    expect(result.sustained600).toMatchObject({
      runtimeFingerprintComplete: true,
      runtimeFingerprintMatchesTruthRuns: false,
      eligible: false,
      failures: expect.arrayContaining(["runtime-fingerprint"]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("pauses release promotion when sustained evidence has another GPU limit profile", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    const mixedAdapter = structuredClone(sustained.artifact) as BrowserBenchmarkArtifact;
    (mixedAdapter as unknown as { gpuAdapter: unknown }).gpuAdapter = ALTERNATE_GPU_ADAPTER;
    (mixedAdapter.samples[0] as unknown as { gpuAdapter: unknown }).gpuAdapter =
      ALTERNATE_GPU_ADAPTER;

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained({ ...sustained, artifact: mixedAdapter }),
    );

    expect(result.sustained600).toMatchObject({
      runtimeFingerprintComplete: true,
      runtimeFingerprintMatchesTruthRuns: false,
      eligible: false,
      failures: expect.arrayContaining(["runtime-fingerprint"]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("pauses release promotion when sustained evidence has another build fingerprint", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained(sustained, { buildManifest: ALTERNATE_BUILD_MANIFEST }),
    );

    expect(result.sustained600).toMatchObject({
      provenanceValid: true,
      buildFingerprintMatchesTruthRuns: false,
      eligible: false,
      failures: expect.arrayContaining(["build-fingerprint"]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("pauses release promotion when sustained evidence has another harness fingerprint", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained(sustained, { harnessManifest: ALTERNATE_HARNESS_MANIFEST }),
    );

    expect(result.sustained600).toMatchObject({
      provenanceValid: true,
      harnessFingerprintMatchesTruthRuns: false,
      eligible: false,
      failures: expect.arrayContaining(["harness-fingerprint"]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("records max as telemetry while the one-percent sustained tail still passes", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    const camera = sustained.artifact.samples[0]!.timings.phases!.camera as unknown as {
      frameMs: number[];
    };
    camera.frameMs[599] = 100;
    refreshTailTelemetry(camera);

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained(sustained),
    );

    expect(result.sustained600?.camera).toMatchObject({
      p99Ms: 10,
      maxMs: 100,
      overBudgetCount: 1,
    });
    expect(result.promotion).toEqual({ status: "GO", reasons: [] });
  });

  test("pauses sustained promotion for JSON null, negative, and fractional telemetry", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    const sample = sustained.artifact.samples[0]!;
    const camera = sample.timings.phases!.camera as unknown as {
      gpuTimestampMs: number[];
      uploadBytes: number[];
      offscreenInspectedLabels: number[];
    };
    const position = sample.timings.phases!.positionMutation as unknown as {
      commitMs: number[];
    };
    camera.gpuTimestampMs[0] = -1;
    camera.uploadBytes[1] = 0.5;
    camera.offscreenInspectedLabels[2] = 0.5;
    position.commitMs[0] = Number.NaN;
    (sample.timings as unknown as { setupMs: number }).setupMs = -1;
    (sample.counters as unknown as Record<string, unknown>).heapBytes = -1;
    const jsonSustained: GpuSceneResidentSustainedInput = {
      ...sustained,
      artifact: resealArtifact(
        JSON.parse(JSON.stringify(sustained.artifact)) as BrowserBenchmarkArtifact,
      ),
    };

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      jsonSustained,
    );

    expect(result.sustained600).toMatchObject({
      budgetPassed: false,
      eligible: false,
      budgetFailures: expect.arrayContaining([
        "setup-ms-domain",
        "heap-bytes-domain",
        "camera-gpu-timestamp-values",
        "camera-upload-bytes-values",
        "camera-offscreen-inspected-labels-values",
        "position-mutation-commit-values",
      ]),
      failures: expect.arrayContaining(["sustained-budget"]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("pauses release when the continuous tail exceeds six frames", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    const position = sustained.artifact.samples[0]!.timings.phases!.positionMutation as unknown as {
      frameMs: number[];
    };
    position.frameMs.splice(593, 7, ...Array.from({ length: 7 }, () => 20));
    refreshTailTelemetry(position);

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained(sustained),
    );

    expect(result.sustained600).toMatchObject({
      eligible: false,
      positionMutation: { overBudgetCount: 7, p99Ms: 20, maxMs: 20 },
      failures: expect.arrayContaining(["position-tail"]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("rejects a product submit hidden in sustained warmup totals", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    const counters = sustained.artifact.samples[0]!.counters as unknown as Record<string, unknown>;
    counters.frameTransactionSubmissions = 1_221;
    counters.frameTransactionStandaloneSubmissions = 1;

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained(sustained),
    );

    expect(result.sustained600).toMatchObject({
      eligible: false,
      failures: expect.arrayContaining(["product-submissions"]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("rejects sustained timestamp and position-upload drift", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    const sample = sustained.artifact.samples[0]!;
    const position = sample.timings.phases!.positionMutation as unknown as {
      transformUploadBytes: number[];
    };
    position.transformUploadBytes[599] = 1_200_000;
    (sample.timings.gpuTiming as unknown as Record<string, unknown>).fusedTimestampResolves = 1_219;

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained(sustained),
    );

    expect(result.sustained600).toMatchObject({
      eligible: false,
      failures: expect.arrayContaining(["timestamp-counters", "upload-invariants"]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("rejects sustained residency fallback even with matching output identity", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    const counters = sustained.artifact.samples[0]!.counters as unknown as Record<string, unknown>;
    counters.residencyActive = "viewport";
    counters.residencyFallbackReason = "renderer-unsupported";

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained(sustained),
    );

    expect(result.sustained600).toMatchObject({
      budgetPassed: false,
      budgetFailures: expect.arrayContaining(["residency-active", "residency-fallback"]),
      failures: expect.arrayContaining(["sustained-budget"]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });

  test("rejects sustained host CPU and commit regressions", async () => {
    const candidate = await readCandidateArtifact();
    const sustained = sustainedInput(candidate);
    const phases = sustained.artifact.samples[0]!.timings.phases!;
    (phases.camera.cpuMs as number[]).fill(3);
    (phases.positionMutation.commitMs as number[]).fill(5);

    const result = aggregateGpuSceneResidentRepeatability(
      fiveInputs(candidate),
      "2026-08-29T12:00:00.000Z",
      resealSustained(sustained),
    );

    expect(result.sustained600).toMatchObject({
      budgetPassed: false,
      budgetFailures: expect.arrayContaining(["camera-cpu-p95-ms", "position-commit-p95-ms"]),
      failures: expect.arrayContaining(["sustained-budget"]),
    });
    expect(result.promotion).toEqual({ status: "PAUSE", reasons: ["sustained-600"] });
  });
});

async function repeatabilityCliExitCode(
  formalPaths: readonly string[],
  sustainedPath: string,
  outputPath: string,
): Promise<number> {
  const child = Bun.spawn(
    [
      process.execPath,
      repeatabilityCliPath,
      ...formalPaths,
      "--sustained",
      sustainedPath,
      "--output",
      outputPath,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  return child.exited;
}

function fiveInputs(
  candidate: Readonly<BrowserBenchmarkArtifact>,
): GpuSceneResidentRepeatabilityInput[] {
  return Array.from({ length: 5 }, (_, index) => ({
    run: index + 1,
    artifactFile: `resident-repeat-${String(index + 1)}.json`,
    candidateSha256: String(index + 1).padStart(64, "0"),
    artifact: sealCandidate(candidate, index + 1),
  }));
}

function sustainedInput(
  candidate: Readonly<BrowserBenchmarkArtifact>,
): GpuSceneResidentSustainedInput {
  const artifact = artifactPayload(candidate, 6);
  (artifact as unknown as { exploratory?: boolean }).exploratory = true;
  applyPassingTelemetry(artifact.samples[0]!, 600);
  return {
    artifactFile: "resident-sustained-600.json",
    candidateSha256: "f".repeat(64),
    artifact: createBrowserBenchmarkArtifact(artifact, {
      runId: runId(6),
      buildManifest: BUILD_MANIFEST,
      harnessManifest: HARNESS_MANIFEST,
    }),
  };
}

function sealCandidate(
  candidate: Readonly<BrowserBenchmarkArtifact>,
  run: number,
): Readonly<BrowserBenchmarkArtifact> {
  return createBrowserBenchmarkArtifact(artifactPayload(candidate, run), {
    runId: runId(run),
    buildManifest: BUILD_MANIFEST,
    harnessManifest: HARNESS_MANIFEST,
  });
}

function artifactPayload(
  candidate: Readonly<BrowserBenchmarkArtifact>,
  run: number,
): BrowserBenchmarkArtifactPayload {
  const artifact = structuredClone(candidate) as unknown as {
    schemaVersion: number;
    capturedAt: string;
    provenance?: unknown;
    budget?: { passed: boolean; checks: unknown[] };
    samples: Array<BrowserBenchmarkArtifact["samples"][number]>;
  };
  delete artifact.provenance;
  artifact.schemaVersion = BENCHMARK_SCHEMA_VERSION;
  artifact.capturedAt = capturedAt(run);
  artifact.budget = { passed: true, checks: [] };
  (artifact as unknown as { gpuAdapter: unknown }).gpuAdapter = GPU_ADAPTER;
  for (const sample of artifact.samples) {
    (sample as unknown as { schemaVersion: number }).schemaVersion = BENCHMARK_SCHEMA_VERSION;
    (sample as unknown as { capturedAt: string }).capturedAt = capturedAt(run);
    (sample as unknown as { gpuAdapter: unknown }).gpuAdapter = GPU_ADAPTER;
    applyPassingTelemetry(sample, 120);
  }
  return artifact as unknown as BrowserBenchmarkArtifactPayload;
}

function resealArtifact(
  artifact: Readonly<BrowserBenchmarkArtifact>,
  options: Readonly<{
    buildManifest?: readonly Readonly<BrowserBenchmarkBuildManifestEntry>[];
    harnessManifest?: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[];
  }> = {},
): Readonly<BrowserBenchmarkArtifact> {
  const clone = structuredClone(artifact) as unknown as {
    provenance?: BrowserBenchmarkArtifact["provenance"];
  } & Record<string, unknown>;
  const provenance = clone.provenance;
  if (provenance === undefined) throw new TypeError("Expected sealed benchmark provenance");
  delete clone.provenance;
  return createBrowserBenchmarkArtifact(clone as unknown as BrowserBenchmarkArtifactPayload, {
    runId: provenance.runId,
    buildManifest: options.buildManifest ?? provenance.buildManifest,
    harnessManifest: options.harnessManifest ?? provenance.harnessManifest,
  });
}

function resealSustained(
  input: Readonly<GpuSceneResidentSustainedInput>,
  options: Readonly<{
    buildManifest?: readonly Readonly<BrowserBenchmarkBuildManifestEntry>[];
    harnessManifest?: readonly Readonly<BrowserBenchmarkHarnessManifestEntry>[];
  }> = {},
): GpuSceneResidentSustainedInput {
  return { ...input, artifact: resealArtifact(input.artifact, options) };
}

function runId(run: number): string {
  return `00000000-0000-4000-8000-${String(run).padStart(12, "0")}`;
}

function capturedAt(run: number): string {
  return `2026-08-29T11:59:${String(run).padStart(2, "0")}.000Z`;
}

function applyPassingTelemetry(
  source: Readonly<BrowserBenchmarkArtifact["samples"][number]>,
  sampleFrames: number,
): void {
  const sample = source as unknown as {
    configuration: { sampleFrames: number };
    counters: Record<string, unknown>;
    timings: Record<string, unknown> & {
      phases: {
        camera: BrowserBenchmarkPhaseTimings;
        positionMutation: BrowserBenchmarkPhaseTimings;
      };
      gpuTiming: Record<string, unknown>;
    };
    invariants: Record<string, boolean | number | string>;
  };
  const camera = passingPhase(sampleFrames, 10, false);
  const positionMutation = passingPhase(sampleFrames, 14, true);
  const timestampSamples = 2 * (10 + sampleFrames);
  sample.configuration.sampleFrames = sampleFrames;
  Object.assign(sample.timings, {
    setupMs: 1_000,
    frameMs: [...camera.frameMs, ...positionMutation.frameMs],
    cpuMs: [...camera.cpuMs, ...positionMutation.cpuMs],
    gpuMs: [...camera.gpuMs, ...positionMutation.gpuMs],
    gpuTimestampMs: [...camera.gpuTimestampMs, ...positionMutation.gpuTimestampMs],
    paletteGpuTimestampMs: [
      ...(camera.paletteGpuTimestampMs ?? []),
      ...(positionMutation.paletteGpuTimestampMs ?? []),
    ],
    cullGpuTimestampMs: [
      ...(camera.cullGpuTimestampMs ?? []),
      ...(positionMutation.cullGpuTimestampMs ?? []),
    ],
    sceneRenderGpuTimestampMs: [
      ...(camera.sceneRenderGpuTimestampMs ?? []),
      ...(positionMutation.sceneRenderGpuTimestampMs ?? []),
    ],
    completionWallMs: [...camera.completionWallMs, ...positionMutation.completionWallMs],
    instrumentationWallMs: [
      ...(camera.instrumentationWallMs ?? []),
      ...(positionMutation.instrumentationWallMs ?? []),
    ],
    timestampReadbackWallMs: [
      ...(camera.timestampReadbackWallMs ?? []),
      ...(positionMutation.timestampReadbackWallMs ?? []),
    ],
    uploadBytes: [...camera.uploadBytes, ...positionMutation.uploadBytes],
    uploadMs: [...camera.uploadMs, ...positionMutation.uploadMs],
    commitMs: [...camera.commitMs, ...positionMutation.commitMs],
    cullingMs: [...camera.cullingMs, ...positionMutation.cullingMs],
    mutationMs: positionMutation.mutationMs,
    phases: { camera, positionMutation },
  });
  Object.assign(sample.timings.gpuTiming, {
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
  });
  Object.assign(sample.counters, {
    residentLabels: 1_000_000,
    gpuResidentLabels: 1_000_000,
    prototypeCount: 1,
    submittedLabels: 50_000,
    visibleGlyphs: 50_000,
    submittedGlyphs: 50_000,
    submittedGlyphsHash: 0x45cf_d045,
    submittedGlyphsHashSource: "gpu-instances-out-readback",
    submittedGlyphsSource: "gpu-indirect-readback",
    renderedPixelHash: 0xa8ad_90b4,
    renderedPixelHashRepeat: 0xa8ad_90b4,
    nonTransparentPixels: 302_457,
    nonTransparentPixelsRepeat: 302_457,
    drawCalls: 1,
    drawCallsSource: "logical-mesh-count",
    observedDrawCalls: 0,
    observedDrawCallsSource: "unavailable-webgpu",
    heapBytes: 100 * 1_024 ** 2,
    rendererAdapter: "webgpu",
    cullPath: "compute-cull",
    palettePath: "storage",
    residencyRequested: "gpu-scene",
    residencyActive: "gpu-scene",
    deferredSpatialLabels: 100_000,
    cullRecordUploadBytes: 32_000_000,
    lastSceneSetupMs: 900,
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
  });
  delete sample.counters.residencyFallbackReason;
  Object.assign(sample.invariants, {
    submittedCountExact: true,
    submittedHashStable: true,
    submittedGlyphsReadback: true,
    pixelsRendered: true,
    pixelReadbackRepeatable: true,
    timestampFusedResolveExact: true,
    timestampStandaloneSubmissionZero: true,
    timestampSegmentedExact: true,
    timestampSegmentsValid: true,
  });
}

function passingPhase(
  count: number,
  frameMs: number,
  position: boolean,
): BrowserBenchmarkPhaseTimings {
  const samples = (value: number): number[] => Array.from({ length: count }, () => value);
  const booleans = (): boolean[] => Array.from({ length: count }, () => false);
  const mutationMs = position ? 5 : 0;
  const completionWallMs = position ? 5 : frameMs - 1;
  const cpuMs = frameMs - mutationMs - completionWallMs;
  return {
    frameMs: samples(frameMs),
    frameMetric: "mutation+timer-cpu+queue-completion",
    frameBudgetMs: 16.67,
    frameOverBudgetCount: 0,
    frameOverBudgetRatio: 0,
    frameP99Ms: frameMs,
    frameMaxMs: frameMs,
    cpuMs: samples(cpuMs),
    gpuMs: samples(5),
    gpuTimestampMs: samples(5),
    paletteGpuTimestampMs: samples(position ? 1 : 0),
    cullGpuTimestampMs: samples(1),
    sceneRenderGpuTimestampMs: samples(position ? 3 : 4),
    completionWallMs: samples(completionWallMs),
    instrumentationWallMs: samples(0.1),
    timestampReadbackWallMs: samples(0.2),
    uploadBytes: samples(position ? 800_016 : 0),
    transformUploadBytes: samples(position ? 800_016 : 0),
    cullRecordUploadBytes: samples(0),
    uploadMs: samples(1),
    commitMs: samples(position ? 3 : 0.5),
    cullingMs: samples(0),
    mutationMs: samples(mutationMs),
    visibilitySelectionMs: samples(0),
    renderPreparationMs: samples(0),
    renderCoordinatorMs: samples(0),
    surfaceApplyMs: samples(1),
    offscreenInspectedLabels: samples(0),
    offscreenMaterializedLabels: samples(0),
    offscreenAdmissionDeferred: booleans(),
    offscreenAdmissionGeneration: samples(0),
    offscreenAdmissionCursor: samples(0),
    offscreenAdmissionCursorResets: samples(0),
    offscreenAdmissionCycles: samples(0),
    deferredSpatialLabels: samples(0),
    shapedLabelsDelta: 0,
    admittedLabelsTotal: 0,
    cullingQueriesDelta: 0,
    frameTransactionSubmissionDeltas: samples(1),
    frameTransactionFusedSubmissionDeltas: samples(1),
    frameTransactionStandaloneSubmissionDeltas: samples(0),
  };
}

function refreshTailTelemetry(phase: { frameMs: number[] }): void {
  const composed = phase as typeof phase & {
    mutationMs?: number[];
    cpuMs?: number[];
    completionWallMs?: number[];
  };
  if (
    composed.mutationMs !== undefined &&
    composed.cpuMs !== undefined &&
    composed.completionWallMs !== undefined
  ) {
    for (const [index, frameMs] of phase.frameMs.entries()) {
      composed.completionWallMs[index] =
        frameMs - (composed.mutationMs[index] ?? 0) - (composed.cpuMs[index] ?? 0);
    }
  }
  const sorted = [...phase.frameMs].sort((left, right) => left - right);
  const overBudgetCount = phase.frameMs.filter((sample) => sample > 16.67).length;
  Object.assign(phase, {
    frameBudgetMs: 16.67,
    frameOverBudgetCount: overBudgetCount,
    frameOverBudgetRatio: overBudgetCount / phase.frameMs.length,
    frameP99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1],
    frameMaxMs: sorted.at(-1),
  });
}
