import { cpus, platform, release } from "node:os";

import type { BenchmarkRuntime } from "./schema";

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
