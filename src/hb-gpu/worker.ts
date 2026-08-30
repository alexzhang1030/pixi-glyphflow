import { HbGpuWasmRuntime, type HbGpuWasmFontHandle } from "./HbGpuWasmRuntime";
import type { HbGpuDrawWorkerRequest, HbGpuDrawWorkerResponse } from "./protocol";

interface WorkerScope {
  onmessage: ((event: MessageEvent<HbGpuDrawWorkerRequest>) => void) | null;
  postMessage(message: HbGpuDrawWorkerResponse, transfer?: Transferable[]): void;
  close(): void;
}

type WorkerRuntime = Pick<
  HbGpuWasmRuntime,
  "abiVersion" | "harfbuzzVersion" | "createFont" | "destroyFont" | "encode" | "destroy"
>;

type WorkerRuntimeLoader = (wasmUrl: string) => Promise<WorkerRuntime>;

export function attachHbGpuWorker(
  scope: WorkerScope,
  loadRuntime: WorkerRuntimeLoader = (wasmUrl) => HbGpuWasmRuntime.load(wasmUrl),
): void {
  const fonts = new Map<string, HbGpuWasmFontHandle>();
  const cleanupPendingFonts = new Set<HbGpuWasmFontHandle>();
  let runtimePromise: Promise<WorkerRuntime> | undefined;
  let commandTail = Promise.resolve();
  let disposing = false;

  scope.onmessage = (event): void => {
    const request = event.data;
    commandTail = commandTail
      .then(() => handleRequest(request))
      .catch((error: unknown) => {
        postError(request.requestId, error);
      });
  };

  async function handleRequest(request: HbGpuDrawWorkerRequest): Promise<void> {
    if (request.type === "dispose") {
      await dispose(request.requestId);
      return;
    }
    if (disposing) throw new Error("Hb GPU worker is being disposed");
    if (request.type === "initialize") {
      const runtime = await initialize(request.wasmUrl);
      if (runtime.abiVersion !== request.expectedAbiVersion) {
        throw new Error(
          `Hb GPU encoder ABI mismatch: expected ${String(request.expectedAbiVersion)}, received ${String(runtime.abiVersion)}`,
        );
      }
      if (runtime.harfbuzzVersion !== request.expectedHarfBuzzVersion) {
        throw new Error(
          `Hb GPU encoder HarfBuzz version mismatch: expected ${request.expectedHarfBuzzVersion}, received ${runtime.harfbuzzVersion}`,
        );
      }
      scope.postMessage({
        type: "ready",
        requestId: request.requestId,
        abiVersion: runtime.abiVersion,
        harfbuzzVersion: runtime.harfbuzzVersion,
      });
      return;
    }

    const runtime = await requireRuntime();
    if (request.type === "register-font") {
      const candidate = runtime.createFont(new Uint8Array(request.data));
      const previous = fonts.get(request.fontKey);
      if (previous !== undefined) {
        try {
          runtime.destroyFont(previous);
        } catch (error: unknown) {
          cleanupPendingFonts.add(candidate);
          try {
            runtime.destroyFont(candidate);
            cleanupPendingFonts.delete(candidate);
          } catch {
            // Disposal retries this unpublished candidate while the replacement error stays primary.
          }
          throw error;
        }
      }
      fonts.set(request.fontKey, candidate);
      scope.postMessage({ type: "ok", requestId: request.requestId });
      return;
    }
    if (request.type === "release-font") {
      const font = fonts.get(request.fontKey);
      if (font === undefined) {
        scope.postMessage({
          type: "font-released",
          requestId: request.requestId,
          released: false,
        });
        return;
      }
      runtime.destroyFont(font);
      fonts.delete(request.fontKey);
      scope.postMessage({ type: "font-released", requestId: request.requestId, released: true });
      return;
    }

    const font = fonts.get(request.fontKey);
    if (font === undefined)
      throw new RangeError(`Hb GPU font key is unavailable: ${request.fontKey}`);
    const encoded = runtime.encode(font, request.glyphId);
    const packedCurveBlob = encoded.packedCurveBlob.buffer as ArrayBuffer;
    scope.postMessage(
      {
        type: "encode-result",
        requestId: request.requestId,
        packedCurveBlob,
        extents: encoded.extents,
        upem: encoded.upem,
      },
      [packedCurveBlob],
    );
  }

  function initialize(wasmUrl: string): Promise<WorkerRuntime> {
    const current = runtimePromise;
    if (current !== undefined) return current;
    const pending = loadRuntime(wasmUrl);
    runtimePromise = pending;

    return pending;
  }

  async function requireRuntime(): Promise<WorkerRuntime> {
    const current = runtimePromise;
    if (current === undefined) throw new Error("Hb GPU worker must initialize before use");

    return current;
  }

  async function dispose(requestId: number): Promise<void> {
    if (disposing) throw new Error("Hb GPU worker is already being disposed");
    disposing = true;
    const current = runtimePromise;
    if (current !== undefined) {
      const runtime = await current;
      let firstFailure: { readonly error: unknown } | undefined;
      for (const [fontKey, font] of fonts) {
        try {
          runtime.destroyFont(font);
          fonts.delete(fontKey);
        } catch (error: unknown) {
          firstFailure ??= { error };
        }
      }
      for (const font of cleanupPendingFonts) {
        try {
          runtime.destroyFont(font);
          cleanupPendingFonts.delete(font);
        } catch (error: unknown) {
          firstFailure ??= { error };
        }
      }
      try {
        runtime.destroy();
      } catch (error: unknown) {
        firstFailure ??= { error };
      }
      if (firstFailure !== undefined) throw firstFailure.error;
    }
    scope.postMessage({ type: "ok", requestId });
    scope.close();
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

attachHbGpuWorker(globalThis as unknown as WorkerScope);
