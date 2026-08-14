import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { LayerWorkerFailure, LayerWorkerResult, LayerWorkerSuccess } from "./layer-worker";
import { benchmarkRuntime, summarize } from "./schema";

const packageMetadata = (await Bun.file(resolve(import.meta.dir, "../package.json")).json()) as {
  readonly version: string;
};
const labelCount = readPositiveInteger("GLYPHFLOW_CORE_LABELS", 1_000_000);
const mutationCount = readPositiveInteger("GLYPHFLOW_CORE_MUTATIONS", 100_000);
const requestedSampleCount = readPositiveInteger("GLYPHFLOW_CORE_SAMPLES", 7);
const maxRssBytes = readPositiveInteger("GLYPHFLOW_CORE_MAX_RSS_BYTES", 1536 * 1024 * 1024);
const timeoutMs = readPositiveInteger("GLYPHFLOW_CORE_TIMEOUT_MS", 120_000);
const outputPath = resolve(import.meta.dir, `results/core-layer-${packageMetadata.version}.json`);

await runIsolatedSample(Math.min(labelCount, 1_000), Math.min(mutationCount, 100));

const samples: LayerWorkerSuccess[] = [];
const failures: LayerWorkerFailure[] = [];

for (let sample = 0; sample < requestedSampleCount; sample += 1) {
  const result = await runIsolatedSample(labelCount, mutationCount);

  if (result.status === "ok") {
    samples.push(result);
    continue;
  }

  failures.push(result);
  break;
}

const artifact = {
  schemaVersion: 1,
  benchmark: "text-layer-core-api",
  packageVersion: packageMetadata.version,
  capturedAt: new Date().toISOString(),
  runtime: benchmarkRuntime(),
  isolation: {
    processPerSample: true,
    maxRssBytes,
    timeoutMs,
  },
  workload: {
    labelCount,
    mutationCount,
    mutationRate: mutationCount / labelCount,
    requestedSampleCount,
    completedSampleCount: samples.length,
  },
  status: failures.length === 0 ? "complete" : "capacity-limit",
  measurements:
    samples.length > 0
      ? {
          fixture: distribution(samples, "fixtureMs", "ms"),
          createMany: distribution(samples, "createManyMs", "ms"),
          createCommit: distribution(samples, "createCommitMs", "ms"),
          updatePositions: distribution(samples, "updatePositionsMs", "ms"),
          noOpPositions: distribution(samples, "noOpPositionsMs", "ms"),
          updateCommit: distribution(samples, "updateCommitMs", "ms"),
          removeMany: distribution(samples, "removeManyMs", "ms"),
          allocatedStore: distribution(samples, "allocatedStoreBytes", "bytes"),
          heapDelta: distribution(samples, "heapDeltaBytes", "bytes"),
          peakRss: distribution(samples, "peakRssBytes", "bytes"),
        }
      : undefined,
  invariants: {
    changedCounts: samples.map((sample) => sample.changedCount),
    noOpChangedCounts: samples.map((sample) => sample.noOpChangedCount),
    positionUpdateBudgetMs: 16.67,
    fixedStoreBudgetBytes: 128 * 1024 * 1024,
  },
  failures,
} as const;

await mkdir(dirname(outputPath), { recursive: true });
await Bun.write(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);

console.log(
  JSON.stringify({
    outputPath,
    status: artifact.status,
    completedSampleCount: samples.length,
    createManyP95Ms: artifact.measurements?.createMany.p95,
    updatePositionsP95Ms: artifact.measurements?.updatePositions.p95,
    allocatedStoreBytes: artifact.measurements?.allocatedStore.max,
    peakRssBytes: artifact.measurements?.peakRss.max,
    failure: failures.at(0),
  }),
);

function distribution(
  samples: readonly LayerWorkerSuccess[],
  key: keyof LayerWorkerSuccess,
  unit: "bytes" | "ms",
): ReturnType<typeof summarize> {
  return summarize(
    samples.map((sample) => {
      const value = sample[key];
      if (typeof value !== "number") {
        throw new TypeError(`Benchmark field ${String(key)} must be numeric`);
      }
      return value;
    }),
    unit,
  );
}

async function runIsolatedSample(labels: number, mutations: number): Promise<LayerWorkerResult> {
  const workerPath = resolve(import.meta.dir, "layer-worker.ts");
  const subprocess = Bun.spawn(
    [
      process.execPath,
      workerPath,
      "--labels",
      String(labels),
      "--mutations",
      String(mutations),
      "--max-rss-bytes",
      String(maxRssBytes),
    ],
    {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdoutPromise = new Response(subprocess.stdout).text();
  const stderrPromise = new Response(subprocess.stderr).text();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    subprocess.kill();
  }, timeoutMs);
  const exitCode = await subprocess.exited;
  clearTimeout(timeout);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);

  if (timedOut || exitCode !== 0) {
    throw new Error(
      timedOut
        ? `TextLayer sample exceeded ${String(timeoutMs)} ms`
        : stderr.trim() || `TextLayer worker exited with code ${String(exitCode)}`,
    );
  }

  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith("{"));
  if (line === undefined) {
    throw new Error("TextLayer worker returned an empty result");
  }

  return JSON.parse(line) as LayerWorkerResult;
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = Bun.env[name];
  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }

  return value;
}
