import { describe, expect, test } from "bun:test";

import type { HbGpuDrawWorkerRequest, HbGpuDrawWorkerResponse } from "../src/hb-gpu/protocol";
import { attachHbGpuWorker } from "../src/hb-gpu/worker";

describe("Hb GPU worker font replacement", () => {
  test("keeps the previous font published when its destruction fails, then supports retry", async () => {
    const fixture = await createWorkerFixture();
    const previousDestroyFailure = new Error("previous font destroy failed");

    expect(await fixture.register(1, "Fixture", 1)).toMatchObject({ type: "ok" });
    fixture.runtime.failNextDestroy(1, previousDestroyFailure);

    const failedReplacement = await fixture.register(2, "Fixture", 2);

    expect(failedReplacement).toMatchObject({
      type: "error",
      requestId: 2,
      name: "Error",
      message: previousDestroyFailure.message,
    });
    expect(fixture.runtime.destroyAttempts).toEqual([1, 2]);
    expect(await fixture.encodedFont(3, "Fixture")).toBe(1);

    expect(await fixture.register(4, "Fixture", 3)).toMatchObject({ type: "ok" });
    expect(await fixture.encodedFont(5, "Fixture")).toBe(3);
    expect(await fixture.request({ type: "dispose", requestId: 6 })).toMatchObject({ type: "ok" });

    expect(fixture.runtime.destroyAttempts).toEqual([1, 2, 1, 3]);
    expect(fixture.runtime.liveFonts.size).toBe(0);
    expect(fixture.runtime.destroyCalls).toBe(1);
    expect(fixture.scope.closeCalls).toBe(1);
  });

  test("preserves the previous destroy error and later retires a rollback candidate", async () => {
    const fixture = await createWorkerFixture();
    const previousDestroyFailure = new Error("primary previous destroy failure");
    const candidateCleanupFailure = new Error("secondary candidate cleanup failure");

    expect(await fixture.register(1, "Fixture", 1)).toMatchObject({ type: "ok" });
    fixture.runtime.failNextDestroy(1, previousDestroyFailure);
    fixture.runtime.failNextDestroy(2, candidateCleanupFailure);

    const failedReplacement = await fixture.register(2, "Fixture", 2);

    expect(failedReplacement).toMatchObject({
      type: "error",
      requestId: 2,
      name: "Error",
      message: previousDestroyFailure.message,
    });
    expect(fixture.runtime.destroyAttempts).toEqual([1, 2]);
    expect(await fixture.encodedFont(3, "Fixture")).toBe(1);

    expect(await fixture.register(4, "Fixture", 3)).toMatchObject({ type: "ok" });
    expect(await fixture.request({ type: "dispose", requestId: 5 })).toMatchObject({ type: "ok" });

    expect(fixture.runtime.destroyAttempts).toEqual([1, 2, 1, 3, 2]);
    expect(fixture.runtime.liveFonts.size).toBe(0);
    expect(fixture.runtime.destroyCalls).toBe(1);
    expect(fixture.scope.closeCalls).toBe(1);
  });
});

async function createWorkerFixture(): Promise<{
  readonly runtime: FakeWorkerRuntime;
  readonly scope: FakeWorkerScope;
  readonly request: (request: HbGpuDrawWorkerRequest) => Promise<HbGpuDrawWorkerResponse>;
  readonly register: (
    requestId: number,
    fontKey: string,
    byte: number,
  ) => Promise<HbGpuDrawWorkerResponse>;
  readonly encodedFont: (requestId: number, fontKey: string) => Promise<number>;
}> {
  const runtime = new FakeWorkerRuntime();
  const scope = new FakeWorkerScope();
  attachHbGpuWorker(scope, async () => runtime);
  const request = (message: HbGpuDrawWorkerRequest): Promise<HbGpuDrawWorkerResponse> =>
    scope.request(message);
  const ready = await request({
    type: "initialize",
    requestId: 0,
    wasmUrl: "fixture.wasm",
    expectedAbiVersion: runtime.abiVersion,
    expectedHarfBuzzVersion: runtime.harfbuzzVersion,
  });
  expect(ready).toMatchObject({ type: "ready", requestId: 0 });

  return {
    runtime,
    scope,
    request,
    register: (requestId, fontKey, byte) =>
      request({
        type: "register-font",
        requestId,
        fontKey,
        data: Uint8Array.of(byte).buffer,
      }),
    encodedFont: async (requestId, fontKey) => {
      const response = await request({ type: "encode", requestId, fontKey, glyphId: 7 });
      if (response.type !== "encode-result") {
        throw new Error(`Expected encode-result, received ${response.type}`);
      }

      return new Uint8Array(response.packedCurveBlob)[0] ?? 0;
    },
  };
}

class FakeWorkerScope {
  onmessage: ((event: MessageEvent<HbGpuDrawWorkerRequest>) => void) | null = null;
  readonly responses: HbGpuDrawWorkerResponse[] = [];
  closeCalls = 0;

  postMessage(message: HbGpuDrawWorkerResponse): void {
    this.responses.push(message);
  }

  close(): void {
    this.closeCalls += 1;
  }

  async request(request: HbGpuDrawWorkerRequest): Promise<HbGpuDrawWorkerResponse> {
    const responseIndex = this.responses.length;
    const onmessage = this.onmessage;
    if (onmessage === null) throw new Error("Worker handler is unavailable");
    onmessage(new MessageEvent("message", { data: request }));
    while (this.responses.length === responseIndex) await Bun.sleep(0);
    const response = this.responses[responseIndex];
    if (response === undefined) throw new Error("Worker response is unavailable");

    return response;
  }
}

class FakeWorkerRuntime {
  readonly abiVersion = 1;
  readonly harfbuzzVersion = "fixture-harfbuzz";
  readonly destroyAttempts: number[] = [];
  readonly liveFonts = new Set<number>();
  readonly #destroyFailures = new Map<number, Error[]>();
  #nextFont = 1;
  destroyCalls = 0;

  createFont(fontBytes: Uint8Array): number {
    if (fontBytes.byteLength === 0) throw new Error("Fixture font is empty");
    const font = this.#nextFont;
    this.#nextFont += 1;
    this.liveFonts.add(font);

    return font;
  }

  destroyFont(font: number): void {
    this.destroyAttempts.push(font);
    const failure = this.#destroyFailures.get(font)?.shift();
    if (failure !== undefined) throw failure;
    if (!this.liveFonts.delete(font)) throw new Error(`Font ${String(font)} was destroyed twice`);
  }

  encode(
    font: number,
    glyphId: number,
  ): {
    readonly packedCurveBlob: Uint8Array;
    readonly extents: {
      readonly xBearing: number;
      readonly yBearing: number;
      readonly width: number;
      readonly height: number;
    };
    readonly upem: number;
  } {
    if (!this.liveFonts.has(font)) throw new Error(`Font ${String(font)} is unavailable`);

    return {
      packedCurveBlob: Uint8Array.of(font, glyphId),
      extents: { xBearing: 0, yBearing: 0, width: 1, height: 1 },
      upem: 1_000,
    };
  }

  destroy(): void {
    this.destroyCalls += 1;
    if (this.liveFonts.size > 0) throw new Error("Fixture runtime still owns font handles");
  }

  failNextDestroy(font: number, failure: Error): void {
    const failures = this.#destroyFailures.get(font) ?? [];
    failures.push(failure);
    this.#destroyFailures.set(font, failures);
  }
}
