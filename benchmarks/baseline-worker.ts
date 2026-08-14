import { TextLayer, type TextId } from "../src";

export interface BaselineWorkerSuccess {
  readonly status: "ok";
  readonly createMs: number;
  readonly createCommitMs: number;
  readonly updateMs: number;
  readonly updateCommitMs: number;
  readonly removeMs: number;
  readonly heapDeltaBytes: number;
  readonly peakRssBytes: number;
}

export interface BaselineWorkerFailure {
  readonly status: "resource-limit" | "timeout" | "process-failure";
  readonly stage: "create" | "update" | "remove" | "process";
  readonly completedLabels: number;
  readonly rssBytes: number;
  readonly detail: string;
}

export type BaselineWorkerResult = BaselineWorkerSuccess | BaselineWorkerFailure;

async function runSample(
  labels: number,
  mutations: number,
  maxRssBytes: number,
): Promise<BaselineWorkerResult> {
  const beforeHeap = process.memoryUsage().heapUsed;
  let peakRssBytes = process.memoryUsage().rss;
  const layer = new TextLayer();
  const ids: TextId[] = [];
  const style = Object.freeze({
    fill: 0xffffff,
    fontFamily: "sans-serif",
    fontSize: 16,
  });

  try {
    const createStart = performance.now();
    for (let index = 0; index < labels; index += 1) {
      ids.push(
        layer.create({
          text: `Counter ${String(index).padStart(6, "0")}`,
          x: index % 1_000,
          y: Math.floor(index / 1_000),
          style,
        }),
      );
      peakRssBytes = checkMemory("create", index + 1, maxRssBytes, peakRssBytes);
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
      peakRssBytes = checkMemory("update", index + 1, maxRssBytes, peakRssBytes);
    }
    const updateMs = performance.now() - updateStart;

    const updateCommitStart = performance.now();
    await layer.commit();
    const updateCommitMs = performance.now() - updateCommitStart;

    const removeStart = performance.now();
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      if (id === undefined) {
        throw new Error(`Missing benchmark label at index ${String(index)}`);
      }
      layer.remove(id);
      peakRssBytes = checkMemory("remove", index + 1, maxRssBytes, peakRssBytes);
    }
    const removeMs = performance.now() - removeStart;
    const heapDeltaBytes = process.memoryUsage().heapUsed - beforeHeap;

    layer.destroy();

    return {
      status: "ok",
      createMs,
      createCommitMs,
      updateMs,
      updateCommitMs,
      removeMs,
      heapDeltaBytes,
      peakRssBytes,
    };
  } catch (error) {
    if (error instanceof ResourceLimitError) {
      return {
        status: "resource-limit",
        stage: error.stage,
        completedLabels: error.completedLabels,
        rssBytes: error.rssBytes,
        detail: error.message,
      };
    }

    layer.destroy();
    throw error;
  }
}

class ResourceLimitError extends Error {
  constructor(
    readonly stage: BaselineWorkerFailure["stage"],
    readonly completedLabels: number,
    readonly rssBytes: number,
    maxRssBytes: number,
  ) {
    super(
      `Object backend reached ${String(rssBytes)} RSS bytes at ${String(completedLabels)} ${stage} operations; limit is ${String(maxRssBytes)} bytes`,
    );
  }
}

function checkMemory(
  stage: BaselineWorkerFailure["stage"],
  completedLabels: number,
  maxRssBytes: number,
  previousPeak: number,
): number {
  if (completedLabels % 4_096 !== 0) {
    return previousPeak;
  }

  const rssBytes = process.memoryUsage().rss;
  if (rssBytes > maxRssBytes) {
    throw new ResourceLimitError(stage, completedLabels, rssBytes, maxRssBytes);
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
