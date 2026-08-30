import { FontRegistry } from "../../src/FontRegistry";
import { HarfBuzzShaper } from "../../src/shaping/HarfBuzzShaper";
import type { HarfBuzzShapeInput } from "../../src/shaping/types";
import type { ShapeWorkerRequest, ShapeWorkerResponse } from "../../src/worker/protocol";
import { serializeWorkerRun, workerRunTransferables } from "../../src/worker/serializeWorkerRun";
import type { PackagedHarfBuzzVariant } from "./packaged-runtime";
import { loadPackagedHarfBuzzRuntime } from "./packaged-runtime";

interface WorkerScope {
  onmessage: ((event: MessageEvent<ShapeWorkerRequest>) => void) | null;
  postMessage(message: ShapeWorkerResponse, transfer?: Transferable[]): void;
  close(): void;
}

export function startShapingSimdBenchmarkWorker(variant: PackagedHarfBuzzVariant): void {
  const scope = globalThis as unknown as WorkerScope;
  const registry = new FontRegistry();
  const shaper = new HarfBuzzShaper(registry, {
    loadRuntime: () => loadPackagedHarfBuzzRuntime(variant),
  });
  let chain = Promise.resolve();
  let disposed = false;

  scope.onmessage = (event): void => {
    const request = event.data;
    chain = chain
      .then(() => handleRequest(request))
      .catch((error: unknown) => postError(request.requestId, error));
  };

  async function handleRequest(request: ShapeWorkerRequest): Promise<void> {
    if (disposed) throw new Error("Packaged HarfBuzz benchmark worker has been disposed");
    if (request.type === "dispose") {
      disposed = true;
      shaper.destroy();
      registry.destroy();
      scope.postMessage({ type: "ok", requestId: request.requestId });
      scope.close();
      return;
    }
    if (request.type === "attach-shape-transport") {
      throw new Error("Packaged HarfBuzz benchmark worker uses transferable shape results");
    }
    if (request.type === "register-font") {
      if (registry.has(request.family)) registry.unregister(request.family);
      await registry.register({ family: request.family, source: new Uint8Array(request.data) });
      scope.postMessage({ type: "ok", requestId: request.requestId });
      return;
    }
    if (request.type === "unregister-font") {
      registry.unregister(request.family);
      scope.postMessage({ type: "ok", requestId: request.requestId });
      return;
    }

    const input = { ...request.input } as {
      -readonly [Key in keyof HarfBuzzShapeInput]: HarfBuzzShapeInput[Key];
    };
    delete input.fontRevision;
    const run = await shaper.shape(input);
    const serialized = serializeWorkerRun(run, request.fontRevision);
    scope.postMessage(
      {
        type: "shape-result",
        requestId: request.requestId,
        labelId: request.labelId,
        sourceRevision: request.sourceRevision,
        fontRevision: request.fontRevision,
        run: serialized,
      },
      workerRunTransferables(serialized),
    );
  }

  function postError(requestId: number, error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    scope.postMessage({
      type: "error",
      requestId,
      name: normalized.name,
      message: normalized.message,
      ...(normalized.stack === undefined ? {} : { stack: normalized.stack }),
    });
  }
}
