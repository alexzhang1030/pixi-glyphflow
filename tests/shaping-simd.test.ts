import { describe, expect, test } from "bun:test";

import {
  benchmarkShapingVariants,
  detectWasmSimdCapability,
  evaluateShapingSimdBenchmark,
} from "../src/shaping/simd";

describe("WASM SIMD shaping capability", () => {
  test("validates a module that executes a SIMD instruction", () => {
    expect(detectWasmSimdCapability().supported).toBe(true);
    expect(
      detectWasmSimdCapability({
        WebAssembly: {
          validate: () => false,
        },
      }),
    ).toEqual({ supported: false, webAssembly: true, reason: "simd-validation" });
    expect(detectWasmSimdCapability({ WebAssembly: undefined })).toEqual({
      supported: false,
      webAssembly: false,
      reason: "webassembly",
    });
  });
});

describe("SIMD shaping benchmark decision", () => {
  test("advances a matching variant only when its gain exceeds measured variance", () => {
    expect(
      evaluateShapingSimdBenchmark({
        simdSupported: true,
        baselineSamplesMs: [10, 10.1, 9.9, 10],
        variantSamplesMs: [7, 7.1, 6.9, 7],
        baselineHash: "same",
        variantHash: "same",
      }),
    ).toMatchObject({
      decision: "advance",
      reasons: [],
      improvementRatio: 0.3,
    });

    expect(
      evaluateShapingSimdBenchmark({
        simdSupported: true,
        baselineSamplesMs: [10, 11, 9, 10],
        variantSamplesMs: [9.8, 10.8, 8.8, 9.8],
        baselineHash: "same",
        variantHash: "same",
      }),
    ).toMatchObject({
      decision: "hold",
      reasons: ["within-variance"],
    });
  });

  test("holds capability failures and result mismatches", () => {
    expect(
      evaluateShapingSimdBenchmark({
        simdSupported: false,
        baselineSamplesMs: [10, 10],
        variantSamplesMs: [5, 5],
        baselineHash: "a",
        variantHash: "b",
      }),
    ).toMatchObject({
      decision: "hold",
      reasons: ["simd-unavailable", "result-mismatch"],
    });
  });

  test("measures baseline and variant with an injectable monotonic clock", async () => {
    let now = 0;
    const report = await benchmarkShapingVariants({
      simdSupported: true,
      warmupIterations: 2,
      sampleCount: 4,
      iterationsPerSample: 3,
      now: () => now,
      baseline: {
        run() {
          now += 5;
        },
        hash: () => "equal",
      },
      variant: {
        run() {
          now += 3;
        },
        hash: () => "equal",
      },
    });

    expect(report.baseline.samplesMs).toEqual([15, 15, 15, 15]);
    expect(report.variant.samplesMs).toEqual([9, 9, 9, 9]);
    expect(report).toMatchObject({ decision: "advance", improvementRatio: 0.4 });
  });
});
