import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { benchmarkRuntime, summarize } from "./schema";
import type { StoreWorkerFailure, StoreWorkerResult, StoreWorkerSuccess } from "./store-worker";

const packageMetadata = (await Bun.file(resolve(import.meta.dir, "../package.json")).json()) as {
  readonly version: string;
};
const labelCount = readPositiveInteger("GLYPHFLOW_STORE_LABELS", 1_000_000);
const mutationCount = readPositiveInteger("GLYPHFLOW_STORE_MUTATIONS", 100_000);
const requestedSampleCount = readPositiveInteger("GLYPHFLOW_STORE_SAMPLES", 7);
const maxRssBytes = readPositiveInteger("GLYPHFLOW_STORE_MAX_RSS_BYTES", 1024 * 1024 * 1024);
const timeoutMs = readPositiveInteger("GLYPHFLOW_STORE_TIMEOUT_MS", 120_000);
const outputPath = resolve(import.meta.dir, `results/text-store-${packageMetadata.version}.json`);

await runIsolatedSample(Math.min(labelCount, 1_000), Math.min(mutationCount, 100));

const samples: StoreWorkerSuccess[] = [];
const failures: StoreWorkerFailure[] = [];

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
  benchmark: "text-store-cpu",
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
    positionStorage: "packed-float32-xy",
    identityStorage: "float64-generation-id",
  },
  status: failures.length === 0 ? "complete" : "capacity-limit",
  measurements:
    samples.length > 0
      ? {
          create: summarize(
            samples.map((sample) => sample.createMs),
            "ms",
          ),
          updatePositions: summarize(
            samples.map((sample) => sample.updatePositionsMs),
            "ms",
          ),
          noOpPositions: summarize(
            samples.map((sample) => sample.noOpPositionsMs),
            "ms",
          ),
          remove: summarize(
            samples.map((sample) => sample.removeMs),
            "ms",
          ),
          fixedStore: summarize(
            samples.map((sample) => sample.fixedStoreBytes),
            "bytes",
          ),
          heapDelta: summarize(
            samples.map((sample) => sample.heapDeltaBytes),
            "bytes",
          ),
          peakRss: summarize(
            samples.map((sample) => sample.peakRssBytes),
            "bytes",
          ),
        }
      : undefined,
  invariants: {
    changedCounts: samples.map((sample) => sample.changedCount),
    noOpChangedCounts: samples.map((sample) => sample.noOpChangedCount),
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
    createP95Ms: artifact.measurements?.create.p95,
    updatePositionsP95Ms: artifact.measurements?.updatePositions.p95,
    noOpPositionsP95Ms: artifact.measurements?.noOpPositions.p95,
    fixedStoreBytes: artifact.measurements?.fixedStore.max,
    peakRssBytes: artifact.measurements?.peakRss.max,
    failure: failures.at(0),
  }),
);

async function runIsolatedSample(labels: number, mutations: number): Promise<StoreWorkerResult> {
  const workerPath = resolve(import.meta.dir, "store-worker.ts");
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
        ? `TextStore sample exceeded ${String(timeoutMs)} ms`
        : stderr.trim() || `TextStore worker exited with code ${String(exitCode)}`,
    );
  }

  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith("{"));
  if (line === undefined) {
    throw new Error("TextStore worker returned an empty result");
  }

  return JSON.parse(line) as StoreWorkerResult;
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
