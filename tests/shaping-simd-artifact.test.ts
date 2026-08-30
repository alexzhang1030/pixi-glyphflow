import { describe, expect, test } from "bun:test";

interface PackagedHarfBuzzAsset {
  readonly wasm: string;
  readonly glue: string;
  readonly sha256: string;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly simdInstructionCount: number;
}

interface PackagedHarfBuzzProvenance {
  readonly schemaVersion: number;
  readonly status: string;
  readonly harfbuzz: {
    readonly version: string;
    readonly commit: string;
    readonly repository: string;
    readonly licenseFile: string;
    readonly sourceRole: string;
    readonly hbGpuVersionBoundary: string;
  };
  readonly toolchain: {
    readonly emscriptenVersion: string;
    readonly sharedFlags: readonly string[];
    readonly variantFlags: {
      readonly scalar: readonly string[];
      readonly simd: readonly string[];
    };
  };
  readonly assets: {
    readonly scalar: PackagedHarfBuzzAsset;
    readonly simd: PackagedHarfBuzzAsset;
  };
  readonly packageDecision: {
    readonly status: string;
    readonly reason: string;
    readonly rawDeltaBytes: number;
    readonly gzipDeltaBytes: number;
  };
}

interface ArtifactMeasurement {
  readonly meanMs: number;
  readonly standardDeviationMs: number;
  readonly samplesMs: readonly number[];
}

interface ShapingSimdSabArtifact {
  readonly schemaVersion: number;
  readonly simd: {
    readonly baseline: ArtifactMeasurement & { readonly varianceMs2: number };
    readonly variant: ArtifactMeasurement & { readonly varianceMs2: number };
    readonly invariants: {
      readonly baselineHash: string;
      readonly variantHash: string;
      readonly hashesMatch: boolean;
    };
    readonly measurementDecision: {
      readonly status: string;
      readonly improvementMs: number;
      readonly varianceThresholdMs: number;
    };
    readonly productionDecision: { readonly status: string; readonly reasons: readonly string[] };
  };
  readonly sabTransport: {
    readonly structuredClone: ArtifactMeasurement;
    readonly sabRing: ArtifactMeasurement;
    readonly invariants: {
      readonly structuredCloneHash: string;
      readonly sabHash: string;
      readonly hashesMatch: boolean;
      readonly zeroCopyView: boolean;
      readonly clusterEndsZeroCopyView: boolean;
    };
    readonly measurementDecision: {
      readonly status: string;
      readonly reasons: readonly string[];
      readonly improvementMs: number;
      readonly varianceThresholdMs: number;
    };
    readonly productionDecision: {
      readonly status: string;
      readonly scope: string;
      readonly evidence: readonly string[];
      readonly next: string;
    };
  };
}

interface PackagedWorkerSimdArtifact {
  readonly schemaVersion: number;
  readonly benchmark: string;
  readonly packageVersion: string;
  readonly sourceVersions: {
    readonly workerShapingHarfBuzz: string;
    readonly hbGpu: string;
    readonly relationship: string;
  };
  readonly packageBoundary: {
    readonly status: string;
    readonly reason: string;
    readonly defaultPackageIncludesAssets: boolean;
  };
  readonly result: {
    readonly corpora: readonly string[];
    readonly workload: { readonly isolatedRuns: number };
    readonly parity: {
      readonly exact: boolean;
      readonly scalarHash: string;
      readonly simdHash: string;
    };
    readonly baseline: ArtifactMeasurement;
    readonly variant: ArtifactMeasurement;
    readonly workers: { readonly scalar: number; readonly simd: number };
    readonly report: {
      readonly decision: string;
      readonly reasons: readonly string[];
      readonly baselineHash: string;
      readonly variantHash: string;
      readonly improvementMs: number;
      readonly varianceThresholdMs: number;
    };
  };
}

describe("shaping SIMD and SAB benchmark artifact", () => {
  test("pins reproducible scalar and SIMD HarfBuzz shaping assets", async () => {
    const root = new URL("../benchmarks/shaping-simd/wasm/", import.meta.url);
    const provenance = (await Bun.file(
      new URL("provenance.json", root),
    ).json()) as PackagedHarfBuzzProvenance;

    expect(provenance).toMatchObject({
      schemaVersion: 1,
      status: "experimental-opt-in",
      harfbuzz: {
        version: "11.2.1",
        commit: "33a3f8de60dcad7535f14f07d6710144548853ac",
        repository: "https://github.com/harfbuzz/harfbuzz",
        licenseFile: "LICENSE.harfbuzz.txt",
        sourceRole: "worker-shaping",
        hbGpuVersionBoundary: "14.4.0-independent",
      },
      toolchain: {
        emscriptenVersion: "3.1.12",
        variantFlags: { scalar: [], simd: ["-msimd128"] },
      },
      packageDecision: {
        status: "pause",
        reason: "human-approval-required",
      },
    });
    expect(provenance.toolchain.sharedFlags).toContain("-DHB_TINY");
    expect(provenance.toolchain.sharedFlags).toContain("-O3");
    expect(provenance.packageDecision.rawDeltaBytes).toBeGreaterThan(0);
    expect(provenance.packageDecision.gzipDeltaBytes).toBeGreaterThan(0);
    expect(await Bun.file(new URL(provenance.harfbuzz.licenseFile, root)).text()).toContain(
      "Permission is hereby granted",
    );

    for (const [variant, asset] of Object.entries(provenance.assets) as Array<
      ["scalar" | "simd", PackagedHarfBuzzAsset]
    >) {
      const [wasm, glue] = await Promise.all([
        Bun.file(new URL(asset.wasm, root)).bytes(),
        Bun.file(new URL(asset.glue, root)).bytes(),
      ]);
      expect(WebAssembly.validate(wasm), variant).toBe(true);
      expect(wasm.byteLength, variant).toBe(asset.rawBytes);
      expect(Bun.gzipSync(wasm, { level: 9 }).byteLength, variant).toBe(asset.gzipBytes);
      expect(sha256(wasm), variant).toBe(asset.sha256);
      expect(glue.byteLength, variant).toBeGreaterThan(0);
    }
    expect(provenance.assets.scalar.simdInstructionCount).toBe(0);
    expect(provenance.assets.simd.simdInstructionCount).toBeGreaterThan(0);
    expect(provenance.assets.simd.sha256).not.toBe(provenance.assets.scalar.sha256);
  });

  test("records isolated samples, matching hashes, and gated decisions", async () => {
    const artifact = (await Bun.file(
      new URL("../benchmarks/results/shaping-simd-sab-1.2.0.json", import.meta.url),
    ).json()) as ShapingSimdSabArtifact;

    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.simd.baseline.samplesMs).toHaveLength(30);
    expect(artifact.simd.variant.samplesMs).toHaveLength(30);
    expect(artifact.simd.baseline.meanMs).toBeCloseTo(mean(artifact.simd.baseline.samplesMs), 12);
    expect(artifact.simd.variant.meanMs).toBeCloseTo(mean(artifact.simd.variant.samplesMs), 12);
    expect(artifact.simd.invariants).toMatchObject({
      hashesMatch: true,
      baselineHash: artifact.simd.invariants.variantHash,
    });
    expect(artifact.simd.measurementDecision.status).toBe("advance");
    expect(artifact.simd.measurementDecision.improvementMs).toBeGreaterThan(
      artifact.simd.measurementDecision.varianceThresholdMs,
    );
    expect(artifact.simd.productionDecision).toMatchObject({
      status: "pause",
      reasons: ["harfbuzz-simd-asset-unavailable"],
    });

    expect(artifact.sabTransport.structuredClone.samplesMs).toHaveLength(30);
    expect(artifact.sabTransport.sabRing.samplesMs).toHaveLength(30);
    expect(artifact.sabTransport.structuredClone.meanMs).toBeCloseTo(
      mean(artifact.sabTransport.structuredClone.samplesMs),
      12,
    );
    expect(artifact.sabTransport.sabRing.meanMs).toBeCloseTo(
      mean(artifact.sabTransport.sabRing.samplesMs),
      12,
    );
    expect(artifact.sabTransport.invariants).toMatchObject({
      hashesMatch: true,
      zeroCopyView: true,
      clusterEndsZeroCopyView: true,
      structuredCloneHash: artifact.sabTransport.invariants.sabHash,
    });
    expect(artifact.sabTransport.measurementDecision).toMatchObject({
      status: "advance",
      reasons: [],
    });
    expect(artifact.sabTransport.measurementDecision.improvementMs).toBeGreaterThan(
      artifact.sabTransport.measurementDecision.varianceThresholdMs,
    );
    expect(artifact.sabTransport.productionDecision).toMatchObject({
      status: "advance",
      scope: "advanced-opt-in-candidate",
      evidence: ["leased-run-render-lifecycle", "cache-owned-copy", "browser-worker-protocol"],
    });
  });

  test("pins real packaged HarfBuzz Worker SIMD evidence", async () => {
    const artifact = (await Bun.file(
      new URL("../benchmarks/results/shaping-simd-worker-1.2.0.json", import.meta.url),
    ).json()) as PackagedWorkerSimdArtifact;

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      benchmark: "packaged-harfbuzz-worker-simd",
      packageVersion: "1.2.0",
      sourceVersions: {
        workerShapingHarfBuzz: "11.2.1",
        hbGpu: "14.4.0",
        relationship: "independent",
      },
      packageBoundary: {
        status: "pause",
        reason: "human-approval-required",
        defaultPackageIncludesAssets: false,
      },
      result: {
        corpora: ["cjkv", "arabic", "devanagari", "hebrew", "thai"],
        workload: { isolatedRuns: 5 },
        parity: { exact: true },
        workers: { scalar: 5, simd: 5 },
      },
    });
    expect(artifact.result.baseline.samplesMs).toHaveLength(5);
    expect(artifact.result.variant.samplesMs).toHaveLength(5);
    expect(artifact.result.parity.scalarHash).toBe(artifact.result.parity.simdHash);
    expect(artifact.result.report.baselineHash).toBe(artifact.result.report.variantHash);
    expect(artifact.result.report.decision).toBe(
      artifact.result.report.improvementMs > artifact.result.report.varianceThresholdMs
        ? "advance"
        : "hold",
    );
    expect(artifact.result.report).toMatchObject({
      decision: "hold",
      reasons: ["variant-regression"],
    });
    expect(artifact.result.report.improvementMs).toBeLessThan(0);
  });
});

function mean(samples: readonly number[]): number {
  return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
}

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);

  return hasher.digest("hex");
}
