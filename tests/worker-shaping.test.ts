import { describe, expect, test } from "bun:test";

import { FontRegistry } from "../src/FontRegistry";
import {
  HarfBuzzWorkerShaper,
  StaleShapeResultError,
  WorkerQueueOverflowError,
  type HarfBuzzShapeInput,
  type ShapeWorkerRequest,
  type ShapeWorkerResponse,
  type WorkerLike,
} from "../src/shaping";

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
      variations: { wght: 650 },
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
    expect([...run.clusterEnds!]).toEqual([5]);
    expect(run.variationKey).toBe("wght=650");
    expect(Object.isFrozen(run)).toBe(true);
    expect(shaper.stats).toMatchObject({
      workerStarts: 1,
      maxQueueDepth: 1_024,
      syncedFonts: 1,
      staleResults: 0,
    });

    const second = shaper.shape(101, 1, input);
    await worker.waitForShapeRequests(2);
    worker.respondToShape(1);
    await second;
    expect(worker.registerRequests).toHaveLength(1);

    shaper.destroy();
    registry.destroy();
  });

  test("rejects an active result after a newer source revision starts", async () => {
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
    expect(worker.shapeRequests).toHaveLength(1);
    const stale = first.catch((error: unknown) => error);
    worker.respondToShape(0);
    expect(await stale).toMatchObject({
      name: StaleShapeResultError.name,
      labelId: 200,
      sourceRevision: 1,
      latestRevision: 2,
    });
    await worker.waitForShapeRequests(2);
    worker.respondToShape(1);
    expect((await second).text).toBe("new");
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
    await worker.waitForShapeRequests(1);
    worker.respondToShape(0);
    expect((await first).fontRevision).toBe(3);
    await worker.waitForShapeRequests(2);
    worker.respondToShape(1);

    expect((await second).fontRevision).toBe(3);
    expect(worker.registerRequests.map((request) => request.fontRevision)).toEqual([1, 3]);

    shaper.destroy();
    registry.destroy();
  });

  test("preserves register, shape, and unregister invocation order for one family", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture", source: new Uint8Array([1]) });
    const worker = new FakeWorker(false);
    const shaper = new HarfBuzzWorkerShaper(registry, { workerFactory: () => worker });

    const shaped = shaper.shape(400, 1, {
      family: "Fixture",
      text: "ordered",
      fontSize: 16,
    });
    await worker.waitForRegisterRequests(1);
    const unregistered = shaper.unregisterFont("Fixture");

    expect(worker.requestTypes).toEqual(["register-font"]);
    worker.respondToRegister(0);
    await worker.waitForShapeRequests(1);
    expect(worker.requestTypes).toEqual(["register-font", "shape"]);

    worker.respondToShape(0);
    await worker.waitForUnregisterRequests(1);
    expect(worker.requestTypes).toEqual(["register-font", "shape", "unregister-font"]);
    worker.respondToUnregister(0);

    expect((await shaped).text).toBe("ordered");
    expect(await unregistered).toBe(true);

    shaper.destroy();
    registry.destroy();
  });

  test("cancels a queued superseded shape before it reaches the worker", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture", source: new Uint8Array([1]) });
    const worker = new FakeWorker(false);
    const shaper = new HarfBuzzWorkerShaper(registry, {
      workerFactory: () => worker,
      maxQueueDepth: 4,
    });

    const blocker = shaper.shape(500, 1, {
      family: "Fixture",
      text: "blocker",
      fontSize: 16,
    });
    await worker.waitForRegisterRequests(1);
    const old = shaper.shape(501, 1, {
      family: "Fixture",
      text: "old",
      fontSize: 16,
    });
    const oldResult = rejectionOf(old);
    const latest = shaper.shape(501, 2, {
      family: "Fixture",
      text: "latest",
      fontSize: 16,
    });

    expect(await oldResult).toMatchObject({
      name: StaleShapeResultError.name,
      labelId: 501,
      sourceRevision: 1,
      latestRevision: 2,
    });
    expect(shaper.stats).toMatchObject({
      queueDepth: 2,
      cancelledRequests: 1,
      staleResults: 0,
      trackedLabels: 2,
    });

    worker.respondToRegister(0);
    await worker.waitForShapeRequests(1);
    worker.respondToShape(0);
    await blocker;
    await worker.waitForShapeRequests(2);
    worker.respondToShape(1);
    expect((await latest).text).toBe("latest");
    expect(worker.shapeRequests.map((request) => request.input.text)).toEqual([
      "blocker",
      "latest",
    ]);
    expect(shaper.stats.trackedLabels).toBe(0);

    shaper.destroy();
    registry.destroy();
  });

  test("keeps the latest pending label revision monotonic", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture", source: new Uint8Array([1]) });
    const worker = new FakeWorker(false);
    const shaper = new HarfBuzzWorkerShaper(registry, { workerFactory: () => worker });

    const latest = shaper.shape(550, 2, {
      family: "Fixture",
      text: "latest",
      fontSize: 16,
    });
    const latestResult = rejectionOf(latest);
    await worker.waitForRegisterRequests(1);
    const older = await rejectionOf(
      shaper.shape(550, 1, {
        family: "Fixture",
        text: "older",
        fontSize: 16,
      }),
    );

    expect(older).toMatchObject({
      name: StaleShapeResultError.name,
      sourceRevision: 1,
      latestRevision: 2,
    });
    expect(shaper.stats).toMatchObject({
      queueDepth: 1,
      cancelledRequests: 1,
      trackedLabels: 1,
    });

    shaper.destroy();
    expect((await latestResult).message).toBe("HarfBuzzWorkerShaper has been destroyed");
    registry.destroy();
  });

  test("rejects overflow at a configurable bounded depth", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture", source: new Uint8Array([1]) });
    const worker = new FakeWorker(false);
    const shaper = new HarfBuzzWorkerShaper(registry, {
      workerFactory: () => worker,
      maxQueueDepth: 2,
    });

    const first = shaper.shape(600, 1, {
      family: "Fixture",
      text: "first",
      fontSize: 16,
    });
    const firstResult = rejectionOf(first);
    await worker.waitForRegisterRequests(1);
    const second = shaper.shape(601, 1, {
      family: "Fixture",
      text: "second",
      fontSize: 16,
    });
    const secondResult = rejectionOf(second);
    const overflow = await rejectionOf(
      shaper.shape(602, 1, {
        family: "Fixture",
        text: "overflow",
        fontSize: 16,
      }),
    );

    expect(overflow).toBeInstanceOf(WorkerQueueOverflowError);
    expect(shaper.stats).toMatchObject({
      queueDepth: 2,
      maxQueueDepth: 2,
      peakQueueDepth: 2,
      queueOverflows: 1,
      trackedLabels: 2,
    });

    shaper.destroy();
    expect((await firstResult).message).toBe("HarfBuzzWorkerShaper has been destroyed");
    expect((await secondResult).message).toBe("HarfBuzzWorkerShaper has been destroyed");
    expect(shaper.stats).toMatchObject({ queueDepth: 0, trackedLabels: 0 });
    expect(worker.terminated).toBe(true);
    registry.destroy();
  });

  test("starts independent font families in parallel", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "FixtureA", source: new Uint8Array([1]) });
    await registry.register({ family: "FixtureB", source: new Uint8Array([2]) });
    const worker = new FakeWorker(false);
    const shaper = new HarfBuzzWorkerShaper(registry, { workerFactory: () => worker });

    const first = shaper.shape(700, 1, {
      family: "FixtureA",
      text: "first",
      fontSize: 16,
    });
    const second = shaper.shape(701, 1, {
      family: "FixtureB",
      text: "second",
      fontSize: 16,
    });

    await worker.waitForRegisterRequests(2);
    expect(worker.registerRequests.map((request) => request.family)).toEqual([
      "FixtureA",
      "FixtureB",
    ]);
    worker.respondToRegister(0);
    worker.respondToRegister(1);
    await worker.waitForShapeRequests(2);
    worker.respondToShape(0);
    worker.respondToShape(1);
    expect((await first).fontFamily).toBe("FixtureA");
    expect((await second).fontFamily).toBe("FixtureB");
    expect(shaper.stats).toMatchObject({ syncedFonts: 2, trackedLabels: 0 });

    shaper.destroy();
    registry.destroy();
  });

  test("keeps revision tracking proportional to pending work", () => {
    const registry = new FontRegistry();
    const shaper = new HarfBuzzWorkerShaper(registry, {
      workerFactory: () => new FakeWorker(),
    });

    for (let labelId = 0; labelId < 1_000_000; labelId += 1) {
      shaper.invalidate(labelId, 1);
    }

    expect(shaper.stats).toMatchObject({ trackedLabels: 0, workerStarts: 0, queueDepth: 0 });
    shaper.destroy();
    registry.destroy();
  });

  test("fails every pending command when the worker emits an error", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "FixtureA", source: new Uint8Array([1]) });
    await registry.register({ family: "FixtureB", source: new Uint8Array([2]) });
    const worker = new FakeWorker(false);
    const shaper = new HarfBuzzWorkerShaper(registry, { workerFactory: () => worker });

    const activeA = rejectionOf(
      shaper.shape(800, 1, {
        family: "FixtureA",
        text: "active-a",
        fontSize: 16,
      }),
    );
    const queuedA = rejectionOf(
      shaper.shape(801, 1, {
        family: "FixtureA",
        text: "queued-a",
        fontSize: 16,
      }),
    );
    const activeB = rejectionOf(
      shaper.shape(802, 1, {
        family: "FixtureB",
        text: "active-b",
        fontSize: 16,
      }),
    );
    await worker.waitForRegisterRequests(2);
    const emitted = new ErrorEvent("error", {
      message: "worker module evaluation exploded",
      error: new Error("module evaluation exploded"),
      cancelable: true,
    });

    worker.emitFailure(emitted);
    const [firstFailure, queuedFailure, secondFailure] = await Promise.all([
      activeA,
      queuedA,
      activeB,
    ]);

    expect(firstFailure).toBe(queuedFailure);
    expect(firstFailure).toBe(secondFailure);
    expect(firstFailure).toMatchObject({
      name: "HarfBuzzWorkerError",
      message: "HarfBuzz shape worker failed: worker module evaluation exploded",
    });
    expect(emitted.defaultPrevented).toBe(true);
    await eventually(() => {
      expect(shaper.stats).toMatchObject({
        queueDepth: 0,
        activeRequests: 0,
        queuedRequests: 0,
        cancelledRequests: 3,
        syncedFonts: 0,
        trackedLabels: 0,
      });
    });
    expect(worker.terminateCalls).toBe(1);
    expect(worker.listenerCount).toBe(0);

    const requestsAtFailure = worker.requestTypes.length;
    const laterShapeFailure = await rejectionOf(
      shaper.shape(803, 1, {
        family: "FixtureA",
        text: "later",
        fontSize: 16,
      }),
    );
    const laterUnregisterFailure = await rejectionOf(shaper.unregisterFont("FixtureA"));
    expect(laterShapeFailure).toBe(firstFailure);
    expect(laterUnregisterFailure).toBe(firstFailure);
    expect(worker.requestTypes).toHaveLength(requestsAtFailure);

    shaper.destroy();
    shaper.destroy();
    expect(worker.terminateCalls).toBe(1);
    registry.destroy();
  });

  test("persists a messageerror failure after response deserialization fails", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture", source: new Uint8Array([1]) });
    const worker = new FakeWorker(false);
    const shaper = new HarfBuzzWorkerShaper(registry, { workerFactory: () => worker });
    const first = rejectionOf(
      shaper.shape(900, 1, {
        family: "Fixture",
        text: "first",
        fontSize: 16,
      }),
    );
    await worker.waitForRegisterRequests(1);

    worker.emitFailure(new MessageEvent("messageerror", { data: { unreadable: true } }));
    const failure = await first;

    expect(failure).toMatchObject({
      name: "HarfBuzzWorkerError",
      message: "HarfBuzz shape worker failed: response deserialization failed",
    });
    expect(
      await rejectionOf(
        shaper.shape(901, 1, {
          family: "Fixture",
          text: "second",
          fontSize: 16,
        }),
      ),
    ).toBe(failure);
    expect(await rejectionOf(shaper.unregisterFont("Fixture"))).toBe(failure);

    shaper.destroy();
    shaper.destroy();
    expect(worker.terminateCalls).toBe(1);
    registry.destroy();
  });

  test("settles a request when a real worker module fails during evaluation", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture", source: new Uint8Array([1]) });
    const shaper = new HarfBuzzWorkerShaper(registry, {
      workerFactory: () =>
        new Worker(new URL("./worker-module-error-fixture.ts", import.meta.url), {
          type: "module",
        }) as unknown as WorkerLike,
    });

    const firstFailure = await rejectionOf(
      shaper.shape(950, 1, {
        family: "Fixture",
        text: "real-worker",
        fontSize: 16,
      }),
    );

    expect(firstFailure.name).toBe("HarfBuzzWorkerError");
    expect(firstFailure.message).toContain("worker fixture module evaluation exploded");
    expect(
      await rejectionOf(
        shaper.shape(951, 1, {
          family: "Fixture",
          text: "after-failure",
          fontSize: 16,
        }),
      ),
    ).toBe(firstFailure);
    shaper.destroy();
    shaper.destroy();
    registry.destroy();
  });
});

class FakeWorker implements WorkerLike {
  readonly registerRequests: Array<
    Extract<ShapeWorkerRequest, { readonly type: "register-font" }>
  > = [];
  readonly shapeRequests: Array<Extract<ShapeWorkerRequest, { readonly type: "shape" }>> = [];
  readonly unregisterRequests: Array<
    Extract<ShapeWorkerRequest, { readonly type: "unregister-font" }>
  > = [];
  readonly requestTypes: ShapeWorkerRequest["type"][] = [];
  readonly #listeners: Record<WorkerEventType, Set<EventListener>> = {
    message: new Set(),
    error: new Set(),
    messageerror: new Set(),
  };
  terminated = false;
  terminateCalls = 0;

  constructor(readonly autoAcknowledgeRegistration = true) {}

  postMessage(message: ShapeWorkerRequest): void {
    this.requestTypes.push(message.type);
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
    if (message.type === "unregister-font") {
      this.unregisterRequests.push(message);
      return;
    }
    queueMicrotask(() => {
      this.#emit({ type: "ok", requestId: message.requestId });
    });
  }

  addEventListener(type: WorkerEventType, listener: EventListener): void {
    this.#listeners[type].add(listener);
  }

  removeEventListener(type: WorkerEventType, listener: EventListener): void {
    this.#listeners[type].delete(listener);
  }

  terminate(): void {
    this.terminated = true;
    this.terminateCalls += 1;
  }

  get listenerCount(): number {
    return Object.values(this.#listeners).reduce((total, listeners) => total + listeners.size, 0);
  }

  emitFailure(event: ErrorEvent | MessageEvent): void {
    const type = event.type;
    if (type !== "error" && type !== "messageerror") {
      throw new TypeError(`Unsupported worker failure event: ${type}`);
    }
    for (const listener of this.#listeners[type]) {
      listener(event);
    }
  }

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

  async waitForUnregisterRequests(count: number): Promise<void> {
    for (let turn = 0; turn < 100; turn += 1) {
      if (this.unregisterRequests.length >= count) {
        return;
      }
      await Promise.resolve();
    }
    throw new Error(`Timed out waiting for ${String(count)} unregister requests`);
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
        clusterEnds: new Uint32Array([request.input.text.length]),
        variationKey: Object.entries(request.input.variations ?? {})
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([axis, value]) => `${axis}=${String(value)}`)
          .join(","),
        x: new Float32Array([0]),
        y: new Float32Array([0]),
        xAdvance: new Float32Array([10]),
        yAdvance: new Float32Array([0]),
        lineIndices: new Uint32Array([0]),
        bounds: { x: 0, y: 0, width: 10, height: 16 },
      },
    });
  }

  respondToUnregister(index: number): void {
    const request = this.unregisterRequests[index];
    if (request === undefined) {
      throw new RangeError(`Unregister request ${String(index)} is unavailable`);
    }
    this.#emit({ type: "ok", requestId: request.requestId });
  }

  #emit(response: ShapeWorkerResponse): void {
    const event = new MessageEvent("message", { data: response });
    for (const listener of this.#listeners.message) {
      listener(event);
    }
  }
}

type WorkerEventType = "message" | "error" | "messageerror";

async function rejectionOf<Result>(promise: Promise<Result>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected promise to reject");
}

async function eventually(assertion: () => void): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}
