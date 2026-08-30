import { describe, expect, test } from "bun:test";

import { FontRegistry } from "../src/FontRegistry";
import { isLeasedPositionedRun, releasePositionedRun } from "../src/layout/PositionedRunLease";
import {
  HarfBuzzWorkerShaper,
  StaleShapeResultError,
  type WorkerLike,
} from "../src/shaping/HarfBuzzWorkerShaper";
import type { HarfBuzzShapeInput } from "../src/shaping/types";
import type { ShapeWorkerRequest, ShapeWorkerResponse } from "../src/worker/protocol";
import { SabShapeTransport, type ShapeResultResponse } from "../src/worker/SabShapeTransport";

describe("HarfBuzzWorkerShaper SAB transport", () => {
  test("returns a leased zero-copy run through the opt-in transport", async () => {
    const fixture = await createWorkerFixture();
    const run = await fixture.shaper.shape(10, 1, shapeInput());

    expect(isLeasedPositionedRun(run)).toBe(true);
    expect(run.glyphIds.buffer).toBe(fixture.transport.buffer);
    expect(fixture.worker.producer?.tryWrite(shapeResult(99, 1, 1))).toBe(false);
    releasePositionedRun(run);
    expect(fixture.worker.producer?.tryWrite(shapeResult(99, 1, 1))).toBe(true);
    fixture.transport.tryRead()?.release();
    fixture.destroy();
  });

  test("releases a stale SAB result before rejecting it", async () => {
    const fixture = await createWorkerFixture({ autoShape: false });
    const pending = fixture.shaper.shape(20, 1, shapeInput());
    const request = await fixture.worker.nextShapeRequest();
    fixture.shaper.invalidate(20, 2);
    fixture.worker.publishShape(request);

    await expect(pending).rejects.toBeInstanceOf(StaleShapeResultError);
    expect(fixture.worker.producer?.tryWrite(shapeResult(100, 1, 1))).toBe(true);
    fixture.transport.tryRead()?.release();
    fixture.destroy();
  });

  test("releases the first lease before retrying a changed font revision", async () => {
    const fixture = await createWorkerFixture({ autoShape: false });
    const pending = fixture.shaper.shape(30, 1, shapeInput());
    const first = await fixture.worker.nextShapeRequest();
    expect(fixture.worker.writeShape(first)).toBe(true);
    fixture.registry.unregister("Fixture");
    await fixture.registry.register({ family: "Fixture", source: new Uint8Array([2]) });
    fixture.worker.ackShape(first.requestId);

    const retry = await fixture.worker.nextShapeRequest();
    const currentRevision = fixture.registry.get("Fixture")?.revision;
    if (currentRevision === undefined) throw new Error("Fixture revision is unavailable");
    expect(retry.fontRevision).toBe(currentRevision);
    expect(fixture.worker.writeShape(retry)).toBe(true);
    fixture.worker.ackShape(retry.requestId);
    const run = await pending;
    expect(run.fontRevision).toBe(retry.fontRevision);
    releasePositionedRun(run);
    fixture.destroy();
  });

  test("destroy rejects pending work and settles the dedicated transport", async () => {
    const fixture = await createWorkerFixture({ autoShape: false });
    const pending = fixture.shaper.shape(40, 1, shapeInput());
    await fixture.worker.nextShapeRequest();
    fixture.shaper.destroy();

    await expect(pending).rejects.toThrow("HarfBuzzWorkerShaper has been destroyed");
    expect(fixture.transport.destroyed).toBe(true);
    fixture.registry.destroy();
  });

  test("closes the shaper after an inconsistent SAB result order", async () => {
    const fixture = await createWorkerFixture({ autoShape: false });
    const pending = fixture.shaper.shape(45, 1, shapeInput());
    const request = await fixture.worker.nextShapeRequest();
    expect(fixture.worker.writeShape(request)).toBe(true);
    fixture.worker.ackShape(request.requestId + 1);

    await expect(pending).rejects.toThrow("Shared shape result order is inconsistent");
    await expect(fixture.shaper.shape(46, 1, shapeInput())).rejects.toThrow(
      "Shared shape result order is inconsistent",
    );
    expect(fixture.transport.destroyed).toBe(true);
    expect(fixture.worker.terminated).toBe(true);
    fixture.registry.destroy();
  });

  test("resolves a same-family batch while both zero-copy leases remain live", async () => {
    const fixture = await createWorkerFixture({ slotCount: 2 });
    try {
      const runs = await withTimeout(
        Promise.all([
          fixture.shaper.shape(50, 1, { ...shapeInput(), text: "A" }),
          fixture.shaper.shape(51, 1, { ...shapeInput(), text: "B" }),
        ]),
        1_000,
      );

      expect(runs.map((run) => run.text)).toEqual(["A", "B"]);
      expect(runs.every(isLeasedPositionedRun)).toBe(true);
      expect(runs.every((run) => run.glyphIds.buffer === fixture.transport.buffer)).toBe(true);
      for (const run of runs) releasePositionedRun(run);
    } finally {
      fixture.destroy();
    }
  });
});

async function createWorkerFixture(
  options: { readonly autoShape?: boolean; readonly slotCount?: number } = {},
): Promise<{
  readonly registry: FontRegistry;
  readonly transport: SabShapeTransport;
  readonly worker: SabWorkerFixture;
  readonly shaper: HarfBuzzWorkerShaper;
  readonly destroy: () => void;
}> {
  const registry = new FontRegistry();
  await registry.register({ family: "Fixture", source: new Uint8Array([1]) });
  const transport = SabShapeTransport.create({
    slotCount: options.slotCount ?? 1,
    slotPayloadBytes: 512,
  });
  const worker = new SabWorkerFixture(options.autoShape ?? true);
  const shaper = new HarfBuzzWorkerShaper(registry, {
    workerFactory: () => worker,
    shapeTransport: transport,
  });
  return {
    registry,
    transport,
    worker,
    shaper,
    destroy() {
      shaper.destroy();
      registry.destroy();
    },
  };
}

class SabWorkerFixture implements WorkerLike {
  readonly #listeners = new Map<"message" | "error" | "messageerror", Set<EventListener>>([
    ["message", new Set()],
    ["error", new Set()],
    ["messageerror", new Set()],
  ]);
  readonly #shapeRequests: Array<Extract<ShapeWorkerRequest, { readonly type: "shape" }>> = [];
  readonly #shapeWaiters: Array<
    (request: Extract<ShapeWorkerRequest, { readonly type: "shape" }>) => void
  > = [];
  readonly #autoShape: boolean;
  producer: SabShapeTransport | undefined;
  terminated = false;

  constructor(autoShape: boolean) {
    this.#autoShape = autoShape;
  }

  postMessage(request: ShapeWorkerRequest): void {
    if (request.type === "attach-shape-transport") {
      this.producer = SabShapeTransport.attach(request.buffer);
      this.#emit({ type: "ok", requestId: request.requestId });
      return;
    }
    if (request.type === "register-font" || request.type === "unregister-font") {
      this.#emit({ type: "ok", requestId: request.requestId });
      return;
    }
    if (request.type === "dispose") {
      this.#emit({ type: "ok", requestId: request.requestId });
      return;
    }
    const waiter = this.#shapeWaiters.shift();
    if (waiter === undefined) this.#shapeRequests.push(request);
    else waiter(request);
    if (this.#autoShape) this.publishShape(request);
  }

  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void {
    this.#listeners.get(type)?.add(listener);
  }

  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  nextShapeRequest(): Promise<Extract<ShapeWorkerRequest, { readonly type: "shape" }>> {
    const queued = this.#shapeRequests.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.#shapeWaiters.push(resolve));
  }

  publishShape(request: Extract<ShapeWorkerRequest, { readonly type: "shape" }>): void {
    if (!this.writeShape(request)) throw new Error("SAB worker fixture hit backpressure");
    this.ackShape(request.requestId);
  }

  writeShape(request: Extract<ShapeWorkerRequest, { readonly type: "shape" }>): boolean {
    if (this.producer === undefined) throw new Error("SAB worker fixture is not attached");
    return this.producer.tryWrite(
      shapeResult(
        request.requestId,
        request.fontRevision,
        request.sourceRevision,
        request.input.text,
      ),
    );
  }

  ackShape(requestId: number): void {
    this.#emit({ type: "shape-result-sab", requestId });
  }

  #emit(response: ShapeWorkerResponse): void {
    const event = new MessageEvent("message", { data: response });
    for (const listener of this.#listeners.get("message") ?? []) listener(event);
  }
}

function shapeInput(): HarfBuzzShapeInput {
  return {
    family: "Fixture",
    text: "A",
    fontSize: 16,
    direction: "ltr",
  };
}

function shapeResult(
  requestId: number,
  fontRevision: number,
  sourceRevision: number,
  text = "A",
): Readonly<ShapeResultResponse> {
  return {
    type: "shape-result",
    requestId,
    labelId: requestId,
    sourceRevision,
    fontRevision,
    run: {
      source: "harfbuzz",
      text,
      fontFamily: "Fixture",
      fontRevision,
      glyphCount: 1,
      direction: "ltr",
      glyphIds: new Uint32Array([65]),
      clusters: new Uint32Array([0]),
      clusterEnds: new Uint32Array([1]),
      x: new Float32Array([0]),
      y: new Float32Array([0]),
      xAdvance: new Float32Array([8]),
      yAdvance: new Float32Array([0]),
      lineIndices: new Uint32Array([0]),
      bounds: { x: 0, y: -6, width: 8, height: 8 },
    },
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("SAB shape batch timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
