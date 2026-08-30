import { describe, expect, test } from "bun:test";

import { BENCHMARK_STATUS_POLLING_MS } from "../benchmarks/runtime";

describe("browser benchmark runner isolation", () => {
  test("polls completion on a fixed interval outside the animation-frame lane", () => {
    expect(BENCHMARK_STATUS_POLLING_MS).toBe(100);
  });
});
