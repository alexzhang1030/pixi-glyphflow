import { describe, expect, test } from "bun:test";

import { finishGpu } from "../benchmarks/browser/timing";
import {
  BENCHMARK_WORKLOADS,
  getBenchmarkWorkload,
  isBenchmarkWorkload,
} from "../benchmarks/workloads";

describe("Wave 0 laboratory workloads", () => {
  test("registers the live-layer full-visibility workload beside the synthetic probe", () => {
    expect(isBenchmarkWorkload("million-full")).toBe(true);
    expect(isBenchmarkWorkload("million-live")).toBe(true);
    expect(getBenchmarkWorkload("million-full").description).toContain("Synthetic");
    expect(getBenchmarkWorkload("million-live")).toMatchObject({
      labelCount: 1_000_000,
      artifactRequired: false,
    });
    expect(getBenchmarkWorkload("million-live").description).toContain("Live TextLayer");
    expect(BENCHMARK_WORKLOADS.some((workload) => workload.id === "million-live")).toBe(true);
  });

  test("finishGpu waits for WebGL completion", async () => {
    let finished = 0;
    await finishGpu({
      gl: {
        finish() {
          finished += 1;
        },
      },
    } as never);
    expect(finished).toBe(1);
  });

  test("finishGpu waits for WebGPU submitted work", async () => {
    let finished = 0;
    await finishGpu({
      gpu: {
        device: {
          queue: {
            async onSubmittedWorkDone() {
              finished += 1;
            },
          },
        },
      },
    } as never);
    expect(finished).toBe(1);
  });
});
