import { cpus, platform, release } from "node:os";

import type { BenchmarkRuntime } from "./schema";

/** Keep Playwright's completion observer off the browser animation-frame lane. */
export const BENCHMARK_STATUS_POLLING_MS = 100;

/** Node-only. Keep out of `schema.ts`, which browser fixtures import by value. */
export function benchmarkRuntime(): BenchmarkRuntime {
  return Object.freeze({
    bun: Bun.version,
    cpu: cpus()[0]?.model ?? "unknown",
    platform: platform(),
    release: release(),
    architecture: process.arch,
  });
}
