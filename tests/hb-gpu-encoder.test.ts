import { describe, expect, test } from "bun:test";

import {
  HB_GPU_DRAW_ABI_VERSION,
  HB_GPU_DRAW_HARFBUZZ_VERSION,
  HbGpuDrawWorkerEncoder,
  type HbGpuDrawWorkerRequest,
  type HbGpuDrawWorkerResponse,
  type HbGpuWorkerLike,
} from "../src/hb-gpu";

describe("HbGpuDrawWorkerEncoder", () => {
  test("loads the optional worker lazily and transfers each font revision once", async () => {
    const worker = new FakeHbGpuWorker();
    const encoder = new HbGpuDrawWorkerEncoder({
      workerFactory: () => worker,
      wasmUrl: "https://fixture.invalid/hb-gpu-encoder.wasm",
    });

    expect(worker.requests).toHaveLength(0);
    const first = await encoder.encode({
      fontKey: "Fixture\u00001",
      fontBytes: new Uint8Array([1, 2, 3]),
      glyphId: 17,
    });
    const second = await encoder.encode({ fontKey: "Fixture\u00001", glyphId: 18 });

    expect(worker.requests.map((request) => request.type)).toEqual([
      "initialize",
      "register-font",
      "encode",
      "encode",
    ]);
    expect(worker.registerRequests).toHaveLength(1);
    expect(worker.transfers[1]).toHaveLength(1);
    expect(first).toEqual({
      packedCurveBlob: new Uint8Array([17, 0, 0, 0, 17, 0, 0, 0]),
      extents: { xBearing: 1, yBearing: 2, width: 3, height: -4 },
      upem: 1_000,
    });
    expect(second.packedCurveBlob[0]).toBe(18);
    expect(encoder.stats).toMatchObject({
      workerStarts: 1,
      requests: 4,
      syncedFonts: 1,
      encodedGlyphs: 2,
    });

    await encoder.destroy();
  });

  test("requires font bytes for a font key before its first glyph", async () => {
    const worker = new FakeHbGpuWorker();
    const encoder = new HbGpuDrawWorkerEncoder({ workerFactory: () => worker });

    await expect(encoder.encode({ fontKey: "Missing\u00001", glyphId: 2 })).rejects.toThrow(
      "fontBytes are required for an uncached fontKey",
    );
    expect(worker.requests).toHaveLength(0);

    await encoder.destroy();
  });

  test("fails initialization on explicit HarfBuzz version and ABI mismatches", async () => {
    for (const fixture of [
      { abiVersion: HB_GPU_DRAW_ABI_VERSION + 1, harfbuzzVersion: HB_GPU_DRAW_HARFBUZZ_VERSION },
      { abiVersion: HB_GPU_DRAW_ABI_VERSION, harfbuzzVersion: "14.5.0" },
    ]) {
      const worker = new FakeHbGpuWorker(fixture);
      const encoder = new HbGpuDrawWorkerEncoder({ workerFactory: () => worker });

      await expect(
        encoder.encode({
          fontKey: "Fixture\u00001",
          fontBytes: new Uint8Array([1]),
          glyphId: 1,
        }),
      ).rejects.toThrow(/Hb GPU encoder (ABI|HarfBuzz version) mismatch/u);
      await encoder.destroy();
    }
  });

  test("releases a cached font revision and requires bytes when the key returns", async () => {
    const worker = new FakeHbGpuWorker();
    const encoder = new HbGpuDrawWorkerEncoder({ workerFactory: () => worker });
    const fontKey = "Fixture\u00007";

    await encoder.encode({
      fontKey,
      fontBytes: new Uint8Array([7]),
      glyphId: 7,
    });
    expect(await encoder.releaseFont(fontKey)).toBe(true);
    expect(await encoder.releaseFont(fontKey)).toBe(false);
    await expect(encoder.encode({ fontKey, glyphId: 8 })).rejects.toThrow(
      "fontBytes are required for an uncached fontKey",
    );

    expect(worker.requests.map((request) => request.type)).toEqual([
      "initialize",
      "register-font",
      "encode",
      "release-font",
    ]);
    await encoder.destroy();
  });

  test("disposes Wasm resources before terminating the worker", async () => {
    const worker = new FakeHbGpuWorker();
    const encoder = new HbGpuDrawWorkerEncoder({ workerFactory: () => worker });
    await encoder.encode({
      fontKey: "Fixture\u00001",
      fontBytes: new Uint8Array([1]),
      glyphId: 1,
    });

    await Promise.all([encoder.destroy(), encoder.destroy()]);

    expect(worker.requests.at(-1)?.type).toBe("dispose");
    expect(worker.terminated).toBe(true);
    await expect(
      encoder.encode({
        fontKey: "Fixture\u00002",
        fontBytes: new Uint8Array([2]),
        glyphId: 2,
      }),
    ).rejects.toThrow("HbGpuDrawWorkerEncoder has been destroyed");
  });

  test("lets an active request finish during graceful destroy", async () => {
    const worker = new FakeHbGpuWorker();
    const encoder = new HbGpuDrawWorkerEncoder({
      workerFactory: () => worker,
      destroyGracePeriodMs: 100,
    });
    const encoding = encoder.encode({
      fontKey: "Fixture\u00001",
      fontBytes: new Uint8Array([1]),
      glyphId: 9,
    });

    await encoder.destroy();

    expect((await encoding).packedCurveBlob[0]).toBe(9);
    expect(worker.requests.map((request) => request.type)).toEqual([
      "initialize",
      "register-font",
      "encode",
      "dispose",
    ]);
    expect(worker.terminated).toBe(true);
  });

  test("rejects active and future requests when the Worker fails", async () => {
    const worker = new FakeHbGpuWorker();
    worker.stallEncodes = true;
    const encoder = new HbGpuDrawWorkerEncoder({ workerFactory: () => worker });
    const pending = encoder.encode({
      fontKey: "Fixture\u00001",
      fontBytes: new Uint8Array([1]),
      glyphId: 1,
    });
    while (!worker.requests.some((request) => request.type === "encode")) await Bun.sleep(0);

    worker.fail("fixture execution failed");

    await expect(pending).rejects.toThrow("Hb GPU worker failed: fixture execution failed");
    await expect(encoder.encode({ fontKey: "Fixture\u00001", glyphId: 2 })).rejects.toThrow(
      "Hb GPU worker failed: fixture execution failed",
    );
    await encoder.destroy();
    expect(worker.requests.at(-1)?.type).toBe("encode");
    expect(worker.terminated).toBe(true);
    expect(worker.terminateCalls).toBe(1);
  });

  test("bounds destroy when an active Worker request stays silent", async () => {
    const worker = new FakeHbGpuWorker();
    worker.stallEncodes = true;
    const encoder = new HbGpuDrawWorkerEncoder({
      workerFactory: () => worker,
      destroyGracePeriodMs: 5,
    });
    const active = encoder.encode({
      fontKey: "Fixture\u00001",
      fontBytes: new Uint8Array([1]),
      glyphId: 1,
    });
    while (!worker.requests.some((request) => request.type === "encode")) await Bun.sleep(0);
    const queued = encoder.encode({ fontKey: "Fixture\u00001", glyphId: 2 });
    const activeSettlement = active.catch((error: unknown) => error);
    const queuedSettlement = queued.catch((error: unknown) => error);

    const destroyedWithinBound = await Promise.race([
      encoder.destroy().then(() => true),
      Bun.sleep(100).then(() => false),
    ]);

    expect(destroyedWithinBound).toBe(true);
    expect(await activeSettlement).toMatchObject({
      message: "HbGpuDrawWorkerEncoder has been destroyed",
    });
    expect(await queuedSettlement).toMatchObject({
      message: "HbGpuDrawWorkerEncoder has been destroyed",
    });
    expect(worker.terminated).toBe(true);
    expect(encoder.stats).toMatchObject({ queueDepth: 0, activeRequests: 0, queuedRequests: 0 });
    await expect(encoder.encode({ fontKey: "Fixture\u00001", glyphId: 3 })).rejects.toThrow(
      "HbGpuDrawWorkerEncoder has been destroyed",
    );
  });

  test("bounds destroy while Worker initialization stays silent", async () => {
    const worker = new FakeHbGpuWorker();
    worker.stallInitializes = true;
    const encoder = new HbGpuDrawWorkerEncoder({
      workerFactory: () => worker,
      destroyGracePeriodMs: 5,
    });
    const encoding = encoder.encode({
      fontKey: "Fixture\u00001",
      fontBytes: new Uint8Array([1]),
      glyphId: 1,
    });
    const encodingSettlement = encoding.catch((error: unknown) => error);
    while (!worker.requests.some((request) => request.type === "initialize")) await Bun.sleep(0);

    const destroyedWithinBound = await Promise.race([
      encoder.destroy().then(() => true),
      Bun.sleep(100).then(() => false),
    ]);

    expect(destroyedWithinBound).toBe(true);
    expect(await encodingSettlement).toMatchObject({
      message: "HbGpuDrawWorkerEncoder has been destroyed",
    });
    expect(worker.requests.map((request) => request.type)).toEqual(["initialize"]);
    expect(worker.terminated).toBe(true);
  });

  test("bounds destroy while the Worker dispose acknowledgement stays silent", async () => {
    const worker = new FakeHbGpuWorker();
    worker.stallDisposes = true;
    const encoder = new HbGpuDrawWorkerEncoder({
      workerFactory: () => worker,
      destroyGracePeriodMs: 5,
    });
    await encoder.encode({
      fontKey: "Fixture\u00001",
      fontBytes: new Uint8Array([1]),
      glyphId: 1,
    });

    const destroyedWithinBound = await Promise.race([
      encoder.destroy().then(() => true),
      Bun.sleep(100).then(() => false),
    ]);

    expect(destroyedWithinBound).toBe(true);
    expect(worker.requests.at(-1)?.type).toBe("dispose");
    expect(worker.terminated).toBe(true);
  });
});

class FakeHbGpuWorker implements HbGpuWorkerLike {
  readonly requests: HbGpuDrawWorkerRequest[] = [];
  readonly transfers: Transferable[][] = [];
  readonly registerRequests: Array<
    Extract<HbGpuDrawWorkerRequest, { readonly type: "register-font" }>
  > = [];
  readonly #listeners = {
    message: new Set<EventListener>(),
    error: new Set<EventListener>(),
    messageerror: new Set<EventListener>(),
  };
  readonly #abiVersion: number;
  readonly #harfbuzzVersion: string;
  terminated = false;
  terminateCalls = 0;
  stallEncodes = false;
  stallInitializes = false;
  stallDisposes = false;

  constructor(
    fixture: Readonly<{ abiVersion: number; harfbuzzVersion: string }> = {
      abiVersion: HB_GPU_DRAW_ABI_VERSION,
      harfbuzzVersion: HB_GPU_DRAW_HARFBUZZ_VERSION,
    },
  ) {
    this.#abiVersion = fixture.abiVersion;
    this.#harfbuzzVersion = fixture.harfbuzzVersion;
  }

  postMessage(message: HbGpuDrawWorkerRequest, transfer: Transferable[] = []): void {
    this.requests.push(message);
    this.transfers.push(transfer);
    queueMicrotask(() => this.#respond(message));
  }

  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void {
    this.#listeners[type].add(listener);
  }

  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void {
    this.#listeners[type].delete(listener);
  }

  terminate(): void {
    this.terminated = true;
    this.terminateCalls += 1;
  }

  fail(message: string): void {
    const event = new Event("error");
    Object.defineProperty(event, "message", { value: message });
    for (const listener of this.#listeners.error) listener(event);
  }

  #respond(request: HbGpuDrawWorkerRequest): void {
    if (request.type === "initialize") {
      if (this.stallInitializes) return;
      this.#dispatch({
        type: "ready",
        requestId: request.requestId,
        abiVersion: this.#abiVersion,
        harfbuzzVersion: this.#harfbuzzVersion,
      });
      return;
    }
    if (request.type === "register-font") {
      this.registerRequests.push(request);
      this.#dispatch({ type: "ok", requestId: request.requestId });
      return;
    }
    if (request.type === "release-font") {
      this.#dispatch({ type: "font-released", requestId: request.requestId, released: true });
      return;
    }
    if (request.type === "dispose") {
      if (this.stallDisposes) return;
      this.#dispatch({ type: "ok", requestId: request.requestId });
      return;
    }

    if (this.stallEncodes) return;
    const packedCurveBlob = new Uint8Array([request.glyphId, 0, 0, 0, request.glyphId, 0, 0, 0])
      .buffer;
    this.#dispatch({
      type: "encode-result",
      requestId: request.requestId,
      packedCurveBlob,
      extents: { xBearing: 1, yBearing: 2, width: 3, height: -4 },
      upem: 1_000,
    });
  }

  #dispatch(response: HbGpuDrawWorkerResponse): void {
    const event = new MessageEvent("message", { data: response });
    for (const listener of this.#listeners.message) listener(event);
  }
}
