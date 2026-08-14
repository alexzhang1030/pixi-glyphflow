import type { BrowserBenchmarkWorkload } from "./schema";

export interface BenchmarkWorkloadDefinition {
  readonly id: BrowserBenchmarkWorkload;
  readonly description: string;
  readonly labelCount: number;
  readonly mutationCount: number;
  readonly warmupFrames: number;
  readonly sampleFrames: number;
  readonly timeoutMs: number;
}

export const BENCHMARK_WORKLOADS: readonly Readonly<BenchmarkWorkloadDefinition>[] = Object.freeze([
  define("static-hud", "Equal-content PixiJS text fixture comparison", 1_000, 1, 5, 60),
  define(
    "million-viewport",
    "One million resident labels under moving viewport culling",
    1_000_000,
    1,
    5,
    30,
    300_000,
  ),
  define(
    "dynamic-counters",
    "One hundred thousand text and transform mutations",
    1_000_000,
    100_000,
    5,
    7,
    300_000,
  ),
  define(
    "viewport-drag",
    "pixi-viewport drag and deceleration over one million labels",
    1_000_000,
    1,
    5,
    30,
    300_000,
  ),
  define(
    "viewport-zoom",
    "pixi-viewport wheel and pinch scale sweep over one million labels",
    1_000_000,
    1,
    5,
    30,
    300_000,
  ),
  define(
    "position-storm",
    "One hundred thousand packed position updates during viewport motion",
    1_000_000,
    100_000,
    5,
    7,
    300_000,
  ),
  define(
    "multilingual-stream",
    "Latin, CJK, Arabic, Devanagari, and emoji update stream",
    10_000,
    1_000,
    5,
    30,
    300_000,
  ),
  define("scale-scan", "Rotated camera sweep from 0.25x through 16x", 50_000, 1, 5, 30, 300_000),
  define(
    "atlas-pressure",
    "Twenty thousand unique glyphs under a four MiB atlas ceiling",
    20_000,
    1,
    0,
    20,
    300_000,
  ),
  define(
    "million-full",
    "One million labels and eight million visible glyph instances",
    1_000_000,
    1,
    1,
    5,
    600_000,
  ),
]);

export function getBenchmarkWorkload(
  id: BrowserBenchmarkWorkload,
): Readonly<BenchmarkWorkloadDefinition> {
  const workload = BENCHMARK_WORKLOADS.find((candidate) => candidate.id === id);
  if (workload === undefined) throw new RangeError(`Unknown benchmark workload: ${id}`);

  return workload;
}

export function isBenchmarkWorkload(value: string): value is BrowserBenchmarkWorkload {
  return BENCHMARK_WORKLOADS.some((workload) => workload.id === value);
}

function define(
  id: BrowserBenchmarkWorkload,
  description: string,
  labelCount: number,
  mutationCount: number,
  warmupFrames: number,
  sampleFrames: number,
  timeoutMs = 120_000,
): Readonly<BenchmarkWorkloadDefinition> {
  return Object.freeze({
    id,
    description,
    labelCount,
    mutationCount,
    warmupFrames,
    sampleFrames,
    timeoutMs,
  });
}
