import { describe, expect, test } from "bun:test";

import { evaluateTransportBenchmark } from "../benchmarks/shaping-transport/evaluate";

describe("SAB transport benchmark decision", () => {
  test("advances only when equivalent zero-copy output beats combined variance", () => {
    expect(
      evaluateTransportBenchmark({
        structuredCloneSamplesMs: [10, 10.2, 9.8],
        sabSamplesMs: [2, 2.1, 1.9],
        hashesMatch: true,
        zeroCopyView: true,
        clusterEndsZeroCopyView: true,
      }).status,
    ).toBe("advance");

    const withinVariance = evaluateTransportBenchmark({
      structuredCloneSamplesMs: [10, 12, 8],
      sabSamplesMs: [9.9, 11.9, 7.9],
      hashesMatch: true,
      zeroCopyView: true,
      clusterEndsZeroCopyView: true,
    });
    expect(withinVariance).toMatchObject({
      status: "pause",
      reasons: ["improvement-within-variance"],
    });
  });

  test("pauses mismatched or copied output", () => {
    expect(
      evaluateTransportBenchmark({
        structuredCloneSamplesMs: [10, 10.1, 9.9],
        sabSamplesMs: [1, 1.1, 0.9],
        hashesMatch: false,
        zeroCopyView: false,
        clusterEndsZeroCopyView: false,
      }),
    ).toMatchObject({
      status: "pause",
      reasons: ["shape-hash-mismatch", "glyph-view-copied", "cluster-end-view-copied"],
    });
  });
});
