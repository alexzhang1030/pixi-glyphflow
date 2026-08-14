import { FontRegistry } from "../FontRegistry";
import { HarfBuzzShaper } from "../shaping/HarfBuzzShaper";
import type { HarfBuzzShapeInput } from "../shaping/types";
import type { SerializedPositionedRun, ShapeWorkerRequest, ShapeWorkerResponse } from "./protocol";

interface WorkerScope {
  onmessage: ((event: MessageEvent<ShapeWorkerRequest>) => void) | null;
  postMessage(message: ShapeWorkerResponse, transfer?: Transferable[]): void;
  close(): void;
}

const scope = globalThis as unknown as WorkerScope;
const registry = new FontRegistry();
const shaper = new HarfBuzzShaper(registry);
const externalRevisions = new Map<string, number>();

scope.onmessage = (event): void => {
  void handleRequest(event.data);
};

async function handleRequest(request: ShapeWorkerRequest): Promise<void> {
  try {
    if (request.type === "register-font") {
      if (registry.has(request.family)) {
        registry.unregister(request.family);
      }
      await registry.register({
        family: request.family,
        source: new Uint8Array(request.data),
      });
      externalRevisions.set(request.family, request.fontRevision);
      scope.postMessage({ type: "ok", requestId: request.requestId });
      return;
    }
    if (request.type === "unregister-font") {
      registry.unregister(request.family);
      externalRevisions.delete(request.family);
      scope.postMessage({ type: "ok", requestId: request.requestId });
      return;
    }
    if (request.type === "dispose") {
      shaper.destroy();
      registry.destroy();
      externalRevisions.clear();
      scope.postMessage({ type: "ok", requestId: request.requestId });
      scope.close();
      return;
    }

    const revision = externalRevisions.get(request.input.family);
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
    const serialized = serializeRun(run, request.fontRevision);
    scope.postMessage(
      {
        type: "shape-result",
        requestId: request.requestId,
        labelId: request.labelId,
        sourceRevision: request.sourceRevision,
        fontRevision: request.fontRevision,
        run: serialized,
      },
      transferRun(serialized),
    );
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    scope.postMessage({
      type: "error",
      requestId: request.requestId,
      name: normalized.name,
      message: normalized.message,
      ...(normalized.stack === undefined ? {} : { stack: normalized.stack }),
    });
  }
}

function serializeRun(
  run: Awaited<ReturnType<HarfBuzzShaper["shape"]>>,
  fontRevision: number,
): SerializedPositionedRun {
  return {
    source: "harfbuzz",
    text: run.text,
    fontFamily: run.fontFamily,
    fontRevision,
    glyphCount: run.glyphCount,
    direction: run.direction,
    glyphIds: new Uint32Array(run.glyphIds),
    clusters: new Uint32Array(run.clusters),
    x: new Float32Array(run.x),
    y: new Float32Array(run.y),
    xAdvance: new Float32Array(run.xAdvance),
    yAdvance: new Float32Array(run.yAdvance),
    lineIndices: new Uint32Array(run.lineIndices),
    ...(run.glyphKeys === undefined ? {} : { glyphKeys: [...run.glyphKeys] }),
    bounds: { ...run.bounds },
  };
}

function transferRun(run: SerializedPositionedRun): Transferable[] {
  return [
    run.glyphIds.buffer,
    run.clusters.buffer,
    run.x.buffer,
    run.y.buffer,
    run.xAdvance.buffer,
    run.yAdvance.buffer,
    run.lineIndices.buffer,
  ];
}
