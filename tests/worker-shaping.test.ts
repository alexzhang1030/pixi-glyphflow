import { describe, expect, test } from "bun:test";

import {
  FontRegistry,
  HarfBuzzWorkerShaper,
  StaleShapeResultError,
  type HarfBuzzShapeInput,
  type ShapeWorkerRequest,
  type ShapeWorkerResponse,
  type WorkerLike,
} from "../src";

describe("HarfBuzzWorkerShaper", () => {
  test("transfers binary fonts once and reconstructs positioned runs", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture", source: new Uint8Array([1, 2, 3]) });
    const worker = new FakeWorker();
    const shaper = new HarfBuzzWorkerShaper(registry, { workerFactory: () => worker });
    const input: HarfBuzzShapeInput = {
      family: "Fixture",
      text: "hello",
      fontSize: 16,
    };

    const pending = shaper.shape(100, 1, input);
    await worker.waitForShapeRequests(1);
    worker.respondToShape(0);
    const run = await pending;

    expect(worker.registerRequests).toHaveLength(1);
    expect(run).toMatchObject({
      source: "harfbuzz",
      text: "hello",
      fontFamily: "Fixture",
      fontRevision: 1,
      glyphCount: 1,
    });
    expect([...run.glyphIds]).toEqual([42]);
    expect(Object.isFrozen(run)).toBe(true);
    expect(shaper.stats).toMatchObject({ workerStarts: 1, syncedFonts: 1, staleResults: 0 });

    const second = shaper.shape(101, 1, input);
    await worker.waitForShapeRequests(2);
    worker.respondToShape(1);
    await second;
    expect(worker.registerRequests).toHaveLength(1);

    shaper.destroy();
    registry.destroy();
  });

  test("rejects an out-of-order result after a newer source revision starts", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture", source: new Uint8Array([1]) });
    const worker = new FakeWorker();
    const shaper = new HarfBuzzWorkerShaper(registry, { workerFactory: () => worker });

    const first = shaper.shape(200, 1, {
      family: "Fixture",
      text: "old",
      fontSize: 16,
    });
    await worker.waitForShapeRequests(1);
    const second = shaper.shape(200, 2, {
      family: "Fixture",
      text: "new",
      fontSize: 16,
    });
    await worker.waitForShapeRequests(2);

    worker.respondToShape(1);
    expect((await second).text).toBe("new");
    worker.respondToShape(0);
    await expect(first).rejects.toMatchObject({
      name: StaleShapeResultError.name,
      labelId: 200,
      sourceRevision: 1,
      latestRevision: 2,
    });
    expect(shaper.stats.staleResults).toBe(1);

    shaper.destroy();
    registry.destroy();
  });

  test("serializes font revision transfers while registration is in flight", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture", source: new Uint8Array([1]) });
    const worker = new FakeWorker(false);
    const shaper = new HarfBuzzWorkerShaper(registry, { workerFactory: () => worker });

    const first = shaper.shape(300, 1, {
      family: "Fixture",
      text: "first",
      fontSize: 16,
    });
    await worker.waitForRegisterRequests(1);
    registry.unregister("Fixture");
    await registry.register({ family: "Fixture", source: new Uint8Array([2]) });
    const second = shaper.shape(301, 1, {
      family: "Fixture",
      text: "second",
      fontSize: 16,
    });

    await Promise.resolve();
    expect(worker.registerRequests).toHaveLength(1);
    worker.respondToRegister(0);
    await worker.waitForRegisterRequests(2);
    worker.respondToRegister(1);
    await worker.waitForShapeRequests(2);
    worker.respondToShape(0);
    worker.respondToShape(1);

    expect((await first).fontRevision).toBe(3);
    expect((await second).fontRevision).toBe(3);
    expect(worker.registerRequests.map((request) => request.fontRevision)).toEqual([1, 3]);

    shaper.destroy();
    registry.destroy();
  });
});

class FakeWorker implements WorkerLike {
  readonly registerRequests: Array<
    Extract<ShapeWorkerRequest, { readonly type: "register-font" }>
  > = [];
  readonly shapeRequests: Array<Extract<ShapeWorkerRequest, { readonly type: "shape" }>> = [];
  readonly #listeners = new Set<EventListener>();

  constructor(readonly autoAcknowledgeRegistration = true) {}

  postMessage(message: ShapeWorkerRequest): void {
    if (message.type === "register-font") {
      this.registerRequests.push(message);
      if (this.autoAcknowledgeRegistration) {
        queueMicrotask(() => {
          this.#emit({ type: "ok", requestId: message.requestId });
        });
      }
      return;
    }
    if (message.type === "shape") {
      this.shapeRequests.push(message);
      return;
    }
    queueMicrotask(() => {
      this.#emit({ type: "ok", requestId: message.requestId });
    });
  }

  addEventListener(_type: "message", listener: EventListener): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: EventListener): void {
    this.#listeners.delete(listener);
  }

  terminate(): void {}

  async waitForShapeRequests(count: number): Promise<void> {
    for (let turn = 0; turn < 100; turn += 1) {
      if (this.shapeRequests.length >= count) {
        return;
      }
      await Promise.resolve();
    }
    throw new Error(`Timed out waiting for ${String(count)} shape requests`);
  }

  async waitForRegisterRequests(count: number): Promise<void> {
    for (let turn = 0; turn < 100; turn += 1) {
      if (this.registerRequests.length >= count) {
        return;
      }
      await Promise.resolve();
    }
    throw new Error(`Timed out waiting for ${String(count)} register requests`);
  }

  respondToRegister(index: number): void {
    const request = this.registerRequests[index];
    if (request === undefined) {
      throw new RangeError(`Register request ${String(index)} is unavailable`);
    }
    this.#emit({ type: "ok", requestId: request.requestId });
  }

  respondToShape(index: number): void {
    const request = this.shapeRequests[index];
    if (request === undefined) {
      throw new RangeError(`Shape request ${String(index)} is unavailable`);
    }
    this.#emit({
      type: "shape-result",
      requestId: request.requestId,
      labelId: request.labelId,
      sourceRevision: request.sourceRevision,
      fontRevision: request.fontRevision,
      run: {
        source: "harfbuzz",
        text: request.input.text,
        fontFamily: request.input.family,
        fontRevision: request.fontRevision,
        glyphCount: 1,
        direction: request.input.direction ?? "ltr",
        glyphIds: new Uint32Array([42]),
        clusters: new Uint32Array([0]),
        x: new Float32Array([0]),
        y: new Float32Array([0]),
        xAdvance: new Float32Array([10]),
        yAdvance: new Float32Array([0]),
        lineIndices: new Uint32Array([0]),
        bounds: { x: 0, y: 0, width: 10, height: 16 },
      },
    });
  }

  #emit(response: ShapeWorkerResponse): void {
    const event = new MessageEvent("message", { data: response });
    for (const listener of this.#listeners) {
      listener(event);
    }
  }
}
