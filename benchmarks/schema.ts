import { cpus, platform, release } from "node:os";

export interface BenchmarkDistribution {
  readonly unit: "bytes" | "ms";
  readonly samples: readonly number[];
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export interface BenchmarkRuntime {
  readonly bun: string;
  readonly cpu: string;
  readonly platform: string;
  readonly release: string;
  readonly architecture: string;
}

export function summarize(
  samples: readonly number[],
  unit: BenchmarkDistribution["unit"],
): BenchmarkDistribution {
  if (samples.length === 0) {
    throw new RangeError("At least one benchmark sample is required");
  }

  const sorted = [...samples].sort((left, right) => left - right);

  return Object.freeze({
    unit,
    samples: Object.freeze([...samples]),
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? 0,
  });
}

export function benchmarkRuntime(): BenchmarkRuntime {
  return Object.freeze({
    bun: Bun.version,
    cpu: cpus()[0]?.model ?? "unknown",
    platform: platform(),
    release: release(),
    architecture: process.arch,
  });
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);

  return sorted[index] ?? 0;
}
