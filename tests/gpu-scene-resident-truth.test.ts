import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import {
  browserBenchmarkArtifactFileName,
  readBrowserBenchmarkArtifact,
} from "../benchmarks/artifacts";
import {
  GPU_SCENE_RESIDENT_CANONICAL_TRUTH,
  evaluateGpuSceneResidentCanonicalSourceBinding,
  evaluateGpuSceneResidentOutputTruth,
} from "../benchmarks/gpu-scene-resident-truth";
import { readBenchmarkArtifactBytes } from "../scripts/benchmark-artifact-archive";

async function readCanonicalSource() {
  const source = GPU_SCENE_RESIDENT_CANONICAL_TRUTH.sourceCandidate;
  const bytes = await readBenchmarkArtifactBytes(
    new URL(`../benchmarks/results/${source.artifact}`, import.meta.url),
  );
  return {
    bytes,
    read: readBrowserBenchmarkArtifact(new TextDecoder().decode(bytes)),
  };
}

describe("GPU-resident canonical output truth", () => {
  test("binds the canonical truth to the formal candidate bytes", async () => {
    const source = GPU_SCENE_RESIDENT_CANONICAL_TRUTH.sourceCandidate;
    const { bytes, read } = await readCanonicalSource();
    const candidate = read.artifact;

    expect(createHash("sha256").update(bytes).digest("hex")).toBe(source.sha256);
    expect(source.packageVersion).toBe("1.2.0");
    expect(source.artifact).not.toBe(
      browserBenchmarkArtifactFileName({
        workload: "gpu-scene-resident",
        renderer: "webgpu",
        artifactRole: "candidate",
        packageVersion: source.packageVersion,
        exploratory: false,
      }),
    );
    if (read.classification === "historical") {
      expect(read).toMatchObject({
        schemaVersion: 6,
        reason: "schema-6-without-build-provenance",
      });
    }
    expect(candidate.packageVersion).toBe(source.packageVersion);
    const binding = evaluateGpuSceneResidentCanonicalSourceBinding(candidate);
    expect(binding.passed).toBe(true);
    expect(binding.failures).toEqual([]);
    expect(binding.checks.map((check) => check.name)).toEqual([
      "sample-count",
      "label-count",
      "mutation-count",
      "warmup-frames",
      "sample-frames",
      "width",
      "height",
      "submitted-glyphs",
      "submitted-labels",
      "submitted-glyphs-source",
      "submitted-glyphs-hash",
      "submitted-glyphs-hash-source",
      "rendered-pixel-hash",
      "rendered-pixel-hash-repeat",
      "non-transparent-pixels",
      "non-transparent-pixels-repeat",
      "frame-transaction-submissions",
      "frame-transaction-fused-submissions",
      "frame-transaction-standalone-submissions",
      "diagnostic-readback-submissions",
      "timestamp-readback-submissions",
      "timestamp-fused-resolves",
      "timestamp-standalone-submissions",
      "gpu-timing-renderer",
      "gpu-timing-method",
      "gpu-time-source",
      "gpu-timing-quality",
      "gpu-timing-supported",
      "gpu-timing-timer-query",
      "gpu-timing-timestamp-writes",
      "gpu-timing-resolve-query-set",
      "gpu-timing-readback",
      "gpu-timing-disjoint",
      "gpu-timing-samples",
      "gpu-timing-valid-samples",
      "gpu-timing-fallback-samples",
      "gpu-timing-fused-resolves",
      "gpu-timing-standalone-submissions",
    ]);
  });

  test("rejects a canonical constant that disagrees with the pinned source payload", async () => {
    const { read } = await readCanonicalSource();
    const candidate = read.artifact;
    const tampered = structuredClone(GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal);
    (tampered.configuration as { width: number }).width -= 1;
    (tampered.output as { renderedPixelHash: number }).renderedPixelHash ^= 1;
    (
      tampered.output as unknown as { submittedGlyphsHashSource: string }
    ).submittedGlyphsHashSource = "host-derived";
    (tampered.telemetry as { frameTransactionSubmissions: number }).frameTransactionSubmissions -=
      1;
    (tampered.telemetry.gpuTiming as { fusedTimestampResolves: number }).fusedTimestampResolves -=
      1;

    const result = evaluateGpuSceneResidentCanonicalSourceBinding(candidate, tampered);

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      "width",
      "submitted-glyphs-hash-source",
      "rendered-pixel-hash",
      "rendered-pixel-hash-repeat",
      "frame-transaction-submissions",
      "gpu-timing-fused-resolves",
    ]);
  });

  test("labels artifact-backed and contract-backed truth fields independently", () => {
    const source = GPU_SCENE_RESIDENT_CANONICAL_TRUTH.sourceCandidate;
    const artifactEvidence = {
      kind: "source-candidate-artifact",
      artifact: source.artifact,
      sha256: source.sha256,
    } as const;
    expect(GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal.provenance).toEqual({
      configuration: artifactEvidence,
      output: artifactEvidence,
      telemetry: artifactEvidence,
    });
    expect(GPU_SCENE_RESIDENT_CANONICAL_TRUTH.sustained600.provenance).toEqual({
      configuration: { kind: "benchmark-contract", contract: "sustained-600" },
      output: artifactEvidence,
      telemetry: { kind: "benchmark-contract", contract: "sustained-600" },
    });
    expect(GPU_SCENE_RESIDENT_CANONICAL_TRUTH.browserSmoke.provenance).toEqual({
      configuration: { kind: "benchmark-contract", contract: "browser-smoke" },
      output: { kind: "benchmark-contract", contract: "browser-smoke" },
      telemetry: { kind: "benchmark-contract", contract: "browser-smoke" },
    });
  });

  test("rejects formal pixel identity drift even when each readback repeats", () => {
    const expected = GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal;
    const result = evaluateGpuSceneResidentOutputTruth(expected.configuration, {
      submittedGlyphs: expected.output.submittedGlyphs,
      submittedGlyphsHash: expected.output.submittedGlyphsHash,
      renderedPixelHash: expected.output.renderedPixelHash ^ 1,
      renderedPixelHashRepeat: expected.output.renderedPixelHash ^ 1,
      nonTransparentPixels: expected.output.nonTransparentPixels - 1,
      nonTransparentPixelsRepeat: expected.output.nonTransparentPixels - 1,
    });

    expect(result).toMatchObject({
      knownConfiguration: true,
      submittedIdentity: true,
      renderedPixelHash: false,
      nonTransparentPixels: false,
      repeatable: true,
      exactOutputIdentity: false,
    });
  });
});
