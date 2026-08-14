import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { TextLayer, type TextId } from "../src";
import { benchmarkRuntime, summarize } from "./schema";

const packageMetadata = (await Bun.file(resolve(import.meta.dir, "../package.json")).json()) as {
  readonly version: string;
};
const labelCount = readPositiveInteger("GLYPHFLOW_BASELINE_LABELS", 10_000);
const mutationRate = 0.1;
const mutationCount = Math.ceil(labelCount * mutationRate);
const sampleCount = readPositiveInteger("GLYPHFLOW_BASELINE_SAMPLES", 7);
const outputPath = resolve(import.meta.dir, `results/baseline-${packageMetadata.version}.json`);

await runSample(Math.min(labelCount, 1_000), Math.min(mutationCount, 100));

const createSamples: number[] = [];
const createCommitSamples: number[] = [];
const updateSamples: number[] = [];
const updateCommitSamples: number[] = [];
const removeSamples: number[] = [];
const heapDeltas: number[] = [];

for (let sample = 0; sample < sampleCount; sample += 1) {
  const result = await runSample(labelCount, mutationCount);

  createSamples.push(result.createMs);
  createCommitSamples.push(result.createCommitMs);
  updateSamples.push(result.updateMs);
  updateCommitSamples.push(result.updateCommitMs);
  removeSamples.push(result.removeMs);
  heapDeltas.push(result.heapDeltaBytes);
}

const artifact = {
  schemaVersion: 1,
  benchmark: "poc-cpu-api",
  packageVersion: packageMetadata.version,
  capturedAt: new Date().toISOString(),
  runtime: benchmarkRuntime(),
  workload: {
    labelCount,
    mutationRate,
    mutationCount,
    sampleCount,
    text: "Counter 000000",
  },
  measurements: {
    create: summarize(createSamples, "ms"),
    createCommit: summarize(createCommitSamples, "ms"),
    update: summarize(updateSamples, "ms"),
    updateCommit: summarize(updateCommitSamples, "ms"),
    remove: summarize(removeSamples, "ms"),
    heapDelta: summarize(heapDeltas, "bytes"),
  },
  limitations: [
    "This CPU baseline creates the 0.0.1 object-per-label backend without a browser renderer.",
    "Browser frame, draw-call, upload, texture, and visual baselines are recorded separately.",
    "Heap deltas are observational because this process does not force garbage collection.",
  ],
} as const;

await mkdir(dirname(outputPath), { recursive: true });
await Bun.write(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);

console.log(
  JSON.stringify({
    outputPath,
    createP95Ms: artifact.measurements.create.p95,
    updateP95Ms: artifact.measurements.update.p95,
    removeP95Ms: artifact.measurements.remove.p95,
  }),
);

interface SampleResult {
  readonly createMs: number;
  readonly createCommitMs: number;
  readonly updateMs: number;
  readonly updateCommitMs: number;
  readonly removeMs: number;
  readonly heapDeltaBytes: number;
}

async function runSample(labels: number, mutations: number): Promise<SampleResult> {
  const beforeHeap = process.memoryUsage().heapUsed;
  const layer = new TextLayer();
  const ids: TextId[] = [];

  const createStart = performance.now();
  for (let index = 0; index < labels; index += 1) {
    ids.push(
      layer.create({
        text: `Counter ${String(index).padStart(6, "0")}`,
        x: index % 1_000,
        y: Math.floor(index / 1_000),
        style: { fill: 0xffffff, fontFamily: "sans-serif", fontSize: 16 },
      }),
    );
  }
  const createMs = performance.now() - createStart;

  const createCommitStart = performance.now();
  await layer.commit();
  const createCommitMs = performance.now() - createCommitStart;

  const updateStart = performance.now();
  for (let index = 0; index < mutations; index += 1) {
    const id = ids[index];
    if (id === undefined) {
      throw new Error(`Missing benchmark label at index ${String(index)}`);
    }
    layer.updateLabel(id, {
      text: `Updated ${String(index).padStart(6, "0")}`,
      x: (index % 1_000) + 1,
    });
  }
  const updateMs = performance.now() - updateStart;

  const updateCommitStart = performance.now();
  await layer.commit();
  const updateCommitMs = performance.now() - updateCommitStart;

  const removeStart = performance.now();
  for (const id of ids) {
    layer.remove(id);
  }
  const removeMs = performance.now() - removeStart;
  const heapDeltaBytes = process.memoryUsage().heapUsed - beforeHeap;

  layer.destroy();

  return {
    createMs,
    createCommitMs,
    updateMs,
    updateCommitMs,
    removeMs,
    heapDeltaBytes,
  };
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
