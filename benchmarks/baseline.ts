import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { BaselineWorkerResult, BaselineWorkerSuccess } from "./baseline-worker";
import { benchmarkRuntime, summarize } from "./schema";

const packageMetadata = (await Bun.file(resolve(import.meta.dir, "../package.json")).json()) as {
  readonly version: string;
};
const labelCount = readPositiveInteger("GLYPHFLOW_BASELINE_LABELS", 1_000_000);
const mutationRate = 0.1;
const mutationCount = Math.ceil(labelCount * mutationRate);
const requestedSampleCount = readPositiveInteger("GLYPHFLOW_BASELINE_SAMPLES", 7);
const maxRssBytes = readPositiveInteger("GLYPHFLOW_BASELINE_MAX_RSS_BYTES", 2 * 1024 * 1024 * 1024);
const timeoutMs = readPositiveInteger("GLYPHFLOW_BASELINE_TIMEOUT_MS", 120_000);
const outputPath = resolve(import.meta.dir, `results/baseline-${packageMetadata.version}.json`);

await runIsolatedSample(Math.min(labelCount, 1_000), Math.min(mutationCount, 100));

const samples: BaselineWorkerSuccess[] = [];
const failures: BaselineWorkerResult[] = [];

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
  schemaVersion: 2,
  benchmark: "poc-cpu-api",
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
    mutationRate,
    mutationCount,
    requestedSampleCount,
    completedSampleCount: samples.length,
    text: "Counter 000000",
  },
  status: failures.length === 0 ? "complete" : "capacity-limit",
  measurements:
    samples.length > 0
      ? {
          create: summarize(
            samples.map((sample) => sample.createMs),
            "ms",
          ),
          createCommit: summarize(
            samples.map((sample) => sample.createCommitMs),
            "ms",
          ),
          update: summarize(
            samples.map((sample) => sample.updateMs),
            "ms",
          ),
          updateCommit: summarize(
            samples.map((sample) => sample.updateCommitMs),
            "ms",
          ),
          remove: summarize(
            samples.map((sample) => sample.removeMs),
            "ms",
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
  failures,
  limitations: [
    "This CPU baseline runs the 0.0.1 object-per-label backend in a renderer-free process.",
    "Browser frame, draw-call, upload, texture, interaction, and visual baselines are recorded separately.",
    "Each measured sample runs in a fresh process and reports observational heap and peak RSS values.",
  ],
} as const;

await mkdir(dirname(outputPath), { recursive: true });
await Bun.write(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);

console.log(
  JSON.stringify({
    outputPath,
    status: artifact.status,
    completedSampleCount: samples.length,
    createP95Ms: artifact.measurements?.create.p95,
    updateP95Ms: artifact.measurements?.update.p95,
    removeP95Ms: artifact.measurements?.remove.p95,
    failure: failures.at(0),
  }),
);

async function runIsolatedSample(labels: number, mutations: number): Promise<BaselineWorkerResult> {
  const workerPath = resolve(import.meta.dir, "baseline-worker.ts");
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

  if (timedOut) {
    return {
      status: "timeout",
      stage: "process",
      completedLabels: 0,
      rssBytes: 0,
      detail: `Sample exceeded ${String(timeoutMs)} ms`,
    };
  }
  if (exitCode !== 0) {
    return {
      status: "process-failure",
      stage: "process",
      completedLabels: 0,
      rssBytes: 0,
      detail: stderr.trim() || `Worker exited with code ${String(exitCode)}`,
    };
  }

  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith("{"));
  if (line === undefined) {
    return {
      status: "process-failure",
      stage: "process",
      completedLabels: 0,
      rssBytes: 0,
      detail: "Worker returned an empty result",
    };
  }

  return JSON.parse(line) as BaselineWorkerResult;
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
