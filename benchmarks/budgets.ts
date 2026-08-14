import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { summarize, type BrowserBenchmarkArtifact, type BrowserBenchmarkSample } from "./schema";
import { BENCHMARK_WORKLOADS } from "./workloads";

interface BudgetResult {
  readonly name: string;
  readonly actual: number | string;
  readonly limit: number | string;
  readonly passed: boolean;
}

const projectRoot = resolve(import.meta.dir, "..");
const packageMetadata = (await Bun.file(resolve(projectRoot, "package.json")).json()) as {
  readonly version: string;
};
const artifacts = new Map<string, BrowserBenchmarkArtifact>();
const checks: BudgetResult[] = [];

for (const definition of BENCHMARK_WORKLOADS) {
  const path = resolve(
    import.meta.dir,
    `results/browser-${definition.id}-${packageMetadata.version}.json`,
  );
  const file = Bun.file(path);
  const exists = await file.exists();
  record(`artifact:${definition.id}`, exists ? "present" : "missing", "present", exists);
  if (!exists) continue;
  const artifact = (await file.json()) as BrowserBenchmarkArtifact;
  artifacts.set(definition.id, artifact);
  record(`status:${definition.id}`, artifact.status, "complete", artifact.status === "complete");
  const expectedSamples = definition.id === "static-hud" ? 4 : 1;
  record(
    `samples:${definition.id}`,
    artifact.samples.length,
    expectedSamples,
    artifact.samples.length === expectedSamples,
  );
  for (const sample of artifact.samples) {
    record(
      `labels:${definition.id}/${sample.configuration.fixture}`,
      sample.configuration.labelCount,
      definition.labelCount,
      sample.configuration.labelCount === definition.labelCount,
    );
    for (const [name, value] of Object.entries(sample.invariants)) {
      if (typeof value === "boolean") {
        record(`invariant:${definition.id}/${name}`, String(value), "true", value);
      }
    }
  }
}

const staticArtifact = artifacts.get("static-hud");
const glyphflowStatic = fixture(staticArtifact, "glyphflow");
const bitmapStatic = fixture(staticArtifact, "bitmap-text");
if (glyphflowStatic !== undefined && bitmapStatic !== undefined) {
  const glyphflowP95 = p95(glyphflowStatic.timings.frameMs);
  const bitmapP95 = p95(bitmapStatic.timings.frameMs);
  record(
    "static-glyphflow-vs-bitmap-text-p95-ms",
    glyphflowP95,
    bitmapP95,
    glyphflowP95 <= bitmapP95,
  );
}

for (const workload of [
  "million-full",
  "million-viewport",
  "dynamic-counters",
  "viewport-drag",
  "viewport-zoom",
  "position-storm",
] as const) {
  const sample = glyphflow(artifacts.get(workload));
  if (sample === undefined) continue;
  record(
    `${workload}-frame-p95-ms`,
    p95(sample.timings.frameMs),
    16.67,
    p95(sample.timings.frameMs) <= 16.67,
  );
  if (sample.counters.allocatedStoreBytes !== undefined) {
    record(
      `${workload}-store-bytes`,
      sample.counters.allocatedStoreBytes,
      128 * 1_024 ** 2,
      sample.counters.allocatedStoreBytes <= 128 * 1_024 ** 2,
    );
  }
}

for (const workload of ["dynamic-counters", "position-storm"] as const) {
  const sample = glyphflow(artifacts.get(workload));
  if (sample?.timings.mutationMs === undefined) continue;
  record(
    `${workload}-mutation-p95-ms`,
    p95(sample.timings.mutationMs),
    16.67,
    p95(sample.timings.mutationMs) <= 16.67,
  );
}

const full = glyphflow(artifacts.get("million-full"));
if (full !== undefined) {
  const instanceBytes = full.counters.instanceBytes ?? Number.POSITIVE_INFINITY;
  const transformBytes = full.counters.transformBytes ?? Number.POSITIVE_INFINITY;
  record(
    "full-visible-glyphs",
    full.counters.visibleGlyphs,
    8_000_000,
    full.counters.visibleGlyphs === 8_000_000,
  );
  record(
    "instance-bytes-per-glyph",
    instanceBytes / full.counters.visibleGlyphs,
    32,
    instanceBytes / full.counters.visibleGlyphs <= 32,
  );
  record(
    "instance-buffer-bytes",
    instanceBytes,
    256 * 1_024 ** 2,
    instanceBytes <= 256 * 1_024 ** 2,
  );
  record(
    "transform-bytes-per-label",
    transformBytes / full.counters.residentLabels,
    64,
    transformBytes / full.counters.residentLabels <= 64,
  );
  record("full-draw-calls", full.counters.drawCalls, 1, full.counters.drawCalls === 1);
}

const atlas = glyphflow(artifacts.get("atlas-pressure"));
if (atlas !== undefined) {
  const atlasBytes = atlas.counters.atlasBytes ?? Number.POSITIVE_INFINITY;
  record("atlas-bytes", atlasBytes, 4 * 1_024 ** 2, atlasBytes <= 4 * 1_024 ** 2);
  record(
    "atlas-evictions",
    atlas.counters.atlasEvictions ?? 0,
    "> 0",
    (atlas.counters.atlasEvictions ?? 0) > 0,
  );
}

const coreGzipBytes = await coreGzipSize();
record("core-esm-gzip-bytes", coreGzipBytes, 40 * 1_024, coreGzipBytes < 40 * 1_024);

const failed = checks.filter((check) => !check.passed);
const outputPath = resolve(import.meta.dir, `results/budgets-${packageMetadata.version}.json`);
await Bun.write(
  outputPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      packageVersion: packageMetadata.version,
      capturedAt: new Date().toISOString(),
      passed: failed.length === 0,
      checks,
    },
    undefined,
    2,
  )}\n`,
);
console.log(JSON.stringify({ outputPath, passed: failed.length === 0, failed }, undefined, 2));
if (failed.length > 0) process.exitCode = 1;

function record(
  name: string,
  actual: number | string,
  limit: number | string,
  passed: boolean,
): void {
  checks.push(Object.freeze({ name, actual, limit, passed }));
}

function glyphflow(
  artifact: Readonly<BrowserBenchmarkArtifact> | undefined,
): Readonly<BrowserBenchmarkSample> | undefined {
  return fixture(artifact, "glyphflow");
}

function fixture(
  artifact: Readonly<BrowserBenchmarkArtifact> | undefined,
  name: string,
): Readonly<BrowserBenchmarkSample> | undefined {
  return artifact?.samples.find((sample) => sample.configuration.fixture === name);
}

function p95(samples: readonly number[]): number {
  return summarize(samples, "ms").p95;
}

async function coreGzipSize(): Promise<number> {
  const entry = resolve(projectRoot, "dist/index.js");
  if (!(await Bun.file(entry).exists())) {
    throw new Error("dist/index.js is required; run bun run build before benchmark:check");
  }
  const visited = new Set<string>();
  const sources: Uint8Array[] = [];
  await collect(entry, visited, sources);

  return gzipSync(Buffer.concat(sources)).byteLength;
}

async function collect(path: string, visited: Set<string>, sources: Uint8Array[]): Promise<void> {
  if (visited.has(path)) return;
  visited.add(path);
  const source = await Bun.file(path).text();
  sources.push(new TextEncoder().encode(source));
  const imports = source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g);
  for (const match of imports) {
    const specifier = match[1];
    if (specifier === undefined || !specifier.endsWith(".js")) continue;
    await collect(resolve(path, "..", specifier), visited, sources);
  }
}
