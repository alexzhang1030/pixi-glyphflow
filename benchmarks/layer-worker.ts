import { TextLayer, type TextLabelSpec } from "../src";

export interface LayerWorkerSuccess {
  readonly status: "ok";
  readonly fixtureMs: number;
  readonly createManyMs: number;
  readonly createCommitMs: number;
  readonly updatePositionsMs: number;
  readonly noOpPositionsMs: number;
  readonly updateCommitMs: number;
  readonly removeManyMs: number;
  readonly allocatedStoreBytes: number;
  readonly heapDeltaBytes: number;
  readonly peakRssBytes: number;
  readonly changedCount: number;
  readonly noOpChangedCount: number;
}

export interface LayerWorkerFailure {
  readonly status: "resource-limit";
  readonly stage: "fixture" | "create" | "update" | "remove";
  readonly rssBytes: number;
  readonly detail: string;
}

export type LayerWorkerResult = LayerWorkerSuccess | LayerWorkerFailure;

class ResourceLimitError extends Error {
  constructor(
    readonly stage: LayerWorkerFailure["stage"],
    readonly rssBytes: number,
    maxRssBytes: number,
  ) {
    super(
      `TextLayer reached ${String(rssBytes)} RSS bytes during ${stage}; limit is ${String(maxRssBytes)} bytes`,
    );
  }
}

async function runSample(
  labels: number,
  mutations: number,
  maxRssBytes: number,
): Promise<LayerWorkerResult> {
  const beforeHeap = process.memoryUsage().heapUsed;
  let peakRssBytes = process.memoryUsage().rss;
  const style = Object.freeze({
    fill: 0xffffff,
    fontFamily: "sans-serif",
    fontSize: 16,
  });
  const layer = new TextLayer({ initialCapacity: labels });

  try {
    const fixtureStart = performance.now();
    const specs: TextLabelSpec[] = Array.from({ length: labels }, (_, index) => ({
      text: `Counter ${String(index).padStart(6, "0")}`,
      x: index % 1_000,
      y: Math.floor(index / 1_000),
      style,
    }));
    const fixtureMs = performance.now() - fixtureStart;
    peakRssBytes = checkMemory("fixture", maxRssBytes, peakRssBytes);

    const createStart = performance.now();
    const ids = layer.createMany(specs);
    const createManyMs = performance.now() - createStart;
    peakRssBytes = checkMemory("create", maxRssBytes, peakRssBytes);

    const createCommitStart = performance.now();
    await layer.commit();
    const createCommitMs = performance.now() - createCommitStart;

    const mutationIds = new Float64Array(mutations);
    const positions = new Float32Array(mutations * 2);
    for (let index = 0; index < mutations; index += 1) {
      const id = ids[index];
      if (id === undefined) {
        throw new Error(`Missing benchmark identity at index ${String(index)}`);
      }
      mutationIds[index] = id;
      positions[index * 2] = (index % 1_000) + 0.5;
      positions[index * 2 + 1] = Math.floor(index / 1_000) + 0.25;
    }

    const updateStart = performance.now();
    const changedCount = layer.updatePositions(mutationIds, positions);
    const updatePositionsMs = performance.now() - updateStart;
    peakRssBytes = checkMemory("update", maxRssBytes, peakRssBytes);

    const noOpStart = performance.now();
    const noOpChangedCount = layer.updatePositions(mutationIds, positions);
    const noOpPositionsMs = performance.now() - noOpStart;

    const updateCommitStart = performance.now();
    await layer.commit();
    const updateCommitMs = performance.now() - updateCommitStart;
    const allocatedStoreBytes = layer.stats.allocatedStoreBytes;

    const packedIds = new Float64Array(ids);
    const removeStart = performance.now();
    const removed = layer.removeMany(packedIds);
    const removeManyMs = performance.now() - removeStart;
    if (removed !== labels) {
      throw new Error(`Expected ${String(labels)} removals and observed ${String(removed)}`);
    }
    peakRssBytes = checkMemory("remove", maxRssBytes, peakRssBytes);

    const heapDeltaBytes = process.memoryUsage().heapUsed - beforeHeap;
    layer.destroy();

    return {
      status: "ok",
      fixtureMs,
      createManyMs,
      createCommitMs,
      updatePositionsMs,
      noOpPositionsMs,
      updateCommitMs,
      removeManyMs,
      allocatedStoreBytes,
      heapDeltaBytes,
      peakRssBytes,
      changedCount,
      noOpChangedCount,
    };
  } catch (error) {
    layer.destroy();
    if (error instanceof ResourceLimitError) {
      return {
        status: "resource-limit",
        stage: error.stage,
        rssBytes: error.rssBytes,
        detail: error.message,
      };
    }

    throw error;
  }
}

function checkMemory(
  stage: LayerWorkerFailure["stage"],
  maxRssBytes: number,
  previousPeak: number,
): number {
  const rssBytes = process.memoryUsage().rss;
  if (rssBytes > maxRssBytes) {
    throw new ResourceLimitError(stage, rssBytes, maxRssBytes);
  }

  return Math.max(previousPeak, rssBytes);
}

function readArgument(name: string): number {
  const index = Bun.argv.indexOf(name);
  const raw = Bun.argv[index + 1];
  const value = Number(raw);

  if (index < 0 || raw === undefined || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be followed by a positive safe integer`);
  }

  return value;
}

if (import.meta.main) {
  const labelCount = readArgument("--labels");
  const mutationCount = readArgument("--mutations");
  const maxRssBytes = readArgument("--max-rss-bytes");
  const result = await runSample(labelCount, mutationCount, maxRssBytes);

  console.log(JSON.stringify(result));
}
