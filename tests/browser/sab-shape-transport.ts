import { hashShapeResult } from "../../benchmarks/shaping-simd/hash";
import { FontRegistry } from "../../src/FontRegistry";
import {
  isLeasedPositionedRun,
  ownedPositionedRun,
  releasePositionedRun,
} from "../../src/layout/PositionedRunLease";
import { HarfBuzzWorkerShaper } from "../../src/shaping/HarfBuzzWorkerShaper";
import {
  SabShapeTransport,
  detectSabShapeTransportCapability,
} from "../../src/worker/SabShapeTransport";

interface WorkerResponse {
  readonly structuredCloneHash: string;
}

interface SabShapeBrowserState {
  readonly done: boolean;
  readonly error?: string;
  readonly result?: {
    readonly capabilitySupported: boolean;
    readonly crossOriginIsolated: boolean;
    readonly requestId: number;
    readonly structuredCloneHash: string;
    readonly sabHash: string;
    readonly zeroCopyView: boolean;
    readonly clusterEndsZeroCopyView: boolean;
    readonly variationKey: string | undefined;
    readonly workerShaperZeroCopyView: boolean;
    readonly workerShaperOwnedCopy: boolean;
    readonly workerShaperBatchTexts: readonly string[];
  };
}

declare global {
  interface Window {
    __sabShape: SabShapeBrowserState;
  }
}

window.__sabShape = { done: false };
void run();

async function run(): Promise<void> {
  const capability = detectSabShapeTransportCapability();
  try {
    if (!capability.supported) {
      throw new Error(`SAB capability failed: ${capability.reason ?? "unknown"}`);
    }
    const transport = SabShapeTransport.create({ slotCount: 2, slotPayloadBytes: 1_024 });
    const worker = new Worker(new URL("./sab-shape-worker.ts", import.meta.url), {
      type: "module",
    });
    const workerResult = new Promise<WorkerResponse>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
    });
    worker.postMessage({ buffer: transport.buffer });

    const lease = await transport.read();
    const response = await workerResult;
    const sabHash = hashShapeResult(lease.result);
    const workerShaper = await runWorkerShaperFixture();
    window.__sabShape = {
      done: true,
      result: {
        capabilitySupported: capability.supported,
        crossOriginIsolated: globalThis.crossOriginIsolated,
        requestId: lease.result.requestId,
        structuredCloneHash: response.structuredCloneHash,
        sabHash,
        zeroCopyView: lease.result.run.glyphIds.buffer === transport.buffer,
        clusterEndsZeroCopyView: lease.result.run.clusterEnds?.buffer === transport.buffer,
        variationKey: lease.result.run.variationKey,
        ...workerShaper,
      },
    };
    lease.release();
    transport.destroy();
    worker.terminate();
  } catch (error) {
    window.__sabShape = {
      done: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runWorkerShaperFixture(): Promise<{
  readonly workerShaperZeroCopyView: boolean;
  readonly workerShaperOwnedCopy: boolean;
  readonly workerShaperBatchTexts: readonly string[];
}> {
  const registry = new FontRegistry();
  await registry.register({ family: "BrowserFixture", source: new Uint8Array([1]) });
  const transport = SabShapeTransport.create({ slotCount: 2, slotPayloadBytes: 1_024 });
  const worker = new Worker(new URL("./sab-worker-shaper-worker.ts", import.meta.url), {
    type: "module",
  });
  const shaper = new HarfBuzzWorkerShaper(registry, {
    workerFactory: () => worker,
    shapeTransport: transport,
  });
  try {
    const runs = await withTimeout(
      Promise.all(
        ["سلام glyph", "second glyph"].map((text, index) =>
          shaper.shape(404 + index, 12, {
            family: "BrowserFixture",
            text,
            fontSize: 18,
            direction: "rtl",
            variations: { wdth: 92, wght: 625 },
          }),
        ),
      ),
      1_000,
    );
    const owned = ownedPositionedRun(runs[0]!);
    const result = {
      workerShaperZeroCopyView:
        runs.every(isLeasedPositionedRun) &&
        runs.every((run) => run.glyphIds.buffer === transport.buffer),
      workerShaperOwnedCopy:
        !isLeasedPositionedRun(owned) && owned.glyphIds.buffer instanceof ArrayBuffer,
      workerShaperBatchTexts: Object.freeze(runs.map((run) => run.text)),
    };
    for (const run of runs) releasePositionedRun(run);
    return result;
  } finally {
    shaper.destroy();
    registry.destroy();
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("SAB worker shaper batch timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export {};
