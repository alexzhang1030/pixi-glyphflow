import { FontRegistry } from "../FontRegistry";
import { HarfBuzzShaper } from "../shaping/HarfBuzzShaper";
import type { HarfBuzzShapeInput } from "../shaping/types";
import { KeyedTaskScheduler } from "./KeyedTaskScheduler";
import type { SerializedPositionedRun, ShapeWorkerRequest, ShapeWorkerResponse } from "./protocol";
import type { SabShapeTransport, ShapeResultResponse } from "./SabShapeTransport";
import { borrowWorkerRun, serializeWorkerRun, workerRunTransferables } from "./serializeWorkerRun";
import { WorkerFontRevisions } from "./WorkerFontRevisions";

interface WorkerScope {
  onmessage: ((event: MessageEvent<ShapeWorkerRequest>) => void) | null;
  postMessage(message: ShapeWorkerResponse, transfer?: Transferable[]): void;
  close(): void;
}

const scope = globalThis as unknown as WorkerScope;
const registry = new FontRegistry();
const shaper = new HarfBuzzShaper(registry);
const externalRevisions = new WorkerFontRevisions();
const commands = new KeyedTaskScheduler<undefined>({ maxQueueDepth: 1_024 });
let disposing = false;
let shapeTransport: SabShapeTransport | undefined;

scope.onmessage = (event): void => {
  const request = event.data;
  if (request.type === "dispose") {
    void disposeWorker(request);
    return;
  }
  if (disposing) {
    postError(request.requestId, new Error("Shape worker is being disposed"));
    return;
  }

  try {
    const scheduled = commands.schedule(requestFamily(request), undefined, () =>
      handleRequest(request),
    );
    void scheduled.catch((error: unknown) => {
      postError(request.requestId, error);
    });
  } catch (error) {
    postError(request.requestId, error);
  }
};

async function handleRequest(
  request: Exclude<ShapeWorkerRequest, { readonly type: "dispose" }>,
): Promise<void> {
  if (request.type === "attach-shape-transport") {
    if (shapeTransport !== undefined) {
      throw new Error("Shared shape transport is already attached");
    }
    const { SabShapeTransport } = await import("./SabShapeTransport");
    shapeTransport = SabShapeTransport.attach(request.buffer);
    scope.postMessage({ type: "ok", requestId: request.requestId });
    return;
  }
  if (request.type === "register-font") {
    if (!externalRevisions.beginRegistration(request.family, request.fontRevision)) {
      scope.postMessage({ type: "ok", requestId: request.requestId });
      return;
    }
    externalRevisions.unregister(request.family);
    if (registry.has(request.family)) {
      registry.unregister(request.family);
    }
    await registry.register({
      family: request.family,
      source: new Uint8Array(request.data),
    });
    externalRevisions.activate(request.family, request.fontRevision);
    scope.postMessage({ type: "ok", requestId: request.requestId });
    return;
  }
  if (request.type === "unregister-font") {
    registry.unregister(request.family);
    externalRevisions.unregister(request.family);
    scope.postMessage({ type: "ok", requestId: request.requestId });
    return;
  }

  const revision = externalRevisions.active(request.input.family);
  if (revision !== request.fontRevision) {
    throw new RangeError(
      `Worker font revision ${String(revision)} differs from request revision ${String(request.fontRevision)}`,
    );
  }
  const localInput = { ...request.input } as {
    -readonly [Key in keyof HarfBuzzShapeInput]: HarfBuzzShapeInput[Key];
  };
  delete localInput.fontRevision;
  const run = await shaper.shape(localInput);
  if (shapeTransport !== undefined) {
    const response = shapeResponse(request, borrowWorkerRun(run, request.fontRevision));
    await shapeTransport.write(response);
    scope.postMessage({ type: "shape-result-sab", requestId: request.requestId });
    return;
  }
  const serialized = serializeWorkerRun(run, request.fontRevision);
  const response = shapeResponse(request, serialized);
  scope.postMessage(response, workerRunTransferables(serialized));
}

function shapeResponse(
  request: Extract<ShapeWorkerRequest, { readonly type: "shape" }>,
  run: SerializedPositionedRun,
): ShapeResultResponse {
  return {
    type: "shape-result",
    requestId: request.requestId,
    labelId: request.labelId,
    sourceRevision: request.sourceRevision,
    fontRevision: request.fontRevision,
    run,
  };
}

async function disposeWorker(
  request: Extract<ShapeWorkerRequest, { readonly type: "dispose" }>,
): Promise<void> {
  if (disposing) {
    postError(request.requestId, new Error("Shape worker is already being disposed"));
    return;
  }
  disposing = true;
  shapeTransport?.destroy();
  await commands.whenIdle();
  commands.close(new Error("Shape worker has been disposed"));
  shaper.destroy();
  registry.destroy();
  externalRevisions.clear();
  scope.postMessage({ type: "ok", requestId: request.requestId });
  scope.close();
}

function requestFamily(request: Exclude<ShapeWorkerRequest, { readonly type: "dispose" }>): string {
  if (request.type === "attach-shape-transport") return "\u0000shape-transport";
  return request.type === "shape" ? request.input.family : request.family;
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
