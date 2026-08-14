import type { TextId } from "../src";
import { TextStore } from "../src/store/TextStore";
import type { TextStoreLabel } from "../src/store/types";

export interface StoreWorkerSuccess {
  readonly status: "ok";
  readonly createMs: number;
  readonly updatePositionsMs: number;
  readonly noOpPositionsMs: number;
  readonly removeMs: number;
  readonly fixedStoreBytes: number;
  readonly heapDeltaBytes: number;
  readonly peakRssBytes: number;
  readonly changedCount: number;
  readonly noOpChangedCount: number;
}

export interface StoreWorkerFailure {
  readonly status: "resource-limit";
  readonly stage: "create" | "update" | "remove";
  readonly completedOperations: number;
  readonly rssBytes: number;
  readonly detail: string;
}

export type StoreWorkerResult = StoreWorkerSuccess | StoreWorkerFailure;

class ResourceLimitError extends Error {
  constructor(
    readonly stage: StoreWorkerFailure["stage"],
    readonly completedOperations: number,
    readonly rssBytes: number,
    maxRssBytes: number,
  ) {
    super(
      `TextStore reached ${String(rssBytes)} RSS bytes at ${String(completedOperations)} ${stage} operations; limit is ${String(maxRssBytes)} bytes`,
    );
  }
}

async function runSample(
  labels: number,
  mutations: number,
  maxRssBytes: number,
): Promise<StoreWorkerResult> {
  const beforeHeap = process.memoryUsage().heapUsed;
  let peakRssBytes = process.memoryUsage().rss;
  const store = new TextStore({ initialCapacity: labels });
  const ids = new Float64Array(labels);
  const positions = new Float32Array(mutations * 2);
  const style = Object.freeze({
    fill: 0xffffff,
    fontFamily: "sans-serif",
    fontSize: 16,
  });
  const baseLabel: TextStoreLabel = Object.freeze({
    text: "",
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    alpha: 1,
    visible: true,
    anchorX: 0,
    anchorY: 0,
    style,
  });

  try {
    const createStart = performance.now();
    for (let index = 0; index < labels; index += 1) {
      ids[index] = store.create({
        ...baseLabel,
        text: `Counter ${String(index).padStart(6, "0")}`,
        x: index % 1_000,
        y: Math.floor(index / 1_000),
      });
      peakRssBytes = checkMemory("create", index + 1, maxRssBytes, peakRssBytes);
    }
    const createMs = performance.now() - createStart;

    for (let index = 0; index < mutations; index += 1) {
      positions[index * 2] = (index % 1_000) + 0.5;
      positions[index * 2 + 1] = Math.floor(index / 1_000) + 0.25;
    }

    const mutationIds = ids.subarray(0, mutations);
    const updateStart = performance.now();
    const changedCount = store.updatePositions(mutationIds, positions);
    const updatePositionsMs = performance.now() - updateStart;
    peakRssBytes = checkMemory("update", mutations, maxRssBytes, peakRssBytes, true);

    const noOpStart = performance.now();
    const noOpChangedCount = store.updatePositions(mutationIds, positions);
    const noOpPositionsMs = performance.now() - noOpStart;

    const fixedStoreBytes = store.stats.allocatedBytes;
    const removeStart = performance.now();
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      if (id === undefined || !store.remove(id as TextId)) {
        throw new Error(`Missing benchmark label at index ${String(index)}`);
      }
      peakRssBytes = checkMemory("remove", index + 1, maxRssBytes, peakRssBytes);
    }
    const removeMs = performance.now() - removeStart;

    return {
      status: "ok",
      createMs,
      updatePositionsMs,
      noOpPositionsMs,
      removeMs,
      fixedStoreBytes,
      heapDeltaBytes: process.memoryUsage().heapUsed - beforeHeap,
      peakRssBytes,
      changedCount,
      noOpChangedCount,
    };
  } catch (error) {
    if (error instanceof ResourceLimitError) {
      return {
        status: "resource-limit",
        stage: error.stage,
        completedOperations: error.completedOperations,
        rssBytes: error.rssBytes,
        detail: error.message,
      };
    }

    throw error;
  }
}

function checkMemory(
  stage: StoreWorkerFailure["stage"],
  completedOperations: number,
  maxRssBytes: number,
  previousPeak: number,
  force = false,
): number {
  if (!force && completedOperations % 16_384 !== 0) {
    return previousPeak;
  }

  const rssBytes = process.memoryUsage().rss;
  if (rssBytes > maxRssBytes) {
    throw new ResourceLimitError(stage, completedOperations, rssBytes, maxRssBytes);
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
