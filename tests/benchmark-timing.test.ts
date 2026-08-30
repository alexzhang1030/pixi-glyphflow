import { describe, expect, test } from "bun:test";

import { createGpuFrameTimer } from "../benchmarks/browser/timing";
import { WebGPUFrameTransaction } from "../src/render/WebGPUFrameTransaction";

describe("WebGPU benchmark timestamp fusion", () => {
  test("reads product, palette, cull, and scene timestamps from one fused product submission", async () => {
    const fixture = createSegmentedFixture();
    const transaction = new WebGPUFrameTransaction(fixture.renderer);
    const timer = createGpuFrameTimer(fixture.renderer);
    transaction.queue("palette", 0, {
      encode(encoder, timestampWrites) {
        fixture.calls.push("palette");
        encoder
          .beginComputePass(timestampWrites === undefined ? undefined : { timestampWrites })
          .end();
      },
    });
    transaction.queue("cull", 0, {
      encode(encoder, timestampWrites) {
        fixture.calls.push("cull");
        encoder
          .beginComputePass(timestampWrites === undefined ? undefined : { timestampWrites })
          .end();
      },
    });

    const sample = await timer.measure(fixture.render);

    expect(sample).toMatchObject({
      gpuTimestampMs: 8,
      paletteGpuTimestampMs: 1,
      cullGpuTimestampMs: 2,
      sceneRenderGpuTimestampMs: 5,
    });
    expect(fixture.calls.filter((call) => call === "submit")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call === "resolve:6")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call === "copy")).toHaveLength(1);
    expect(fixture.computeTimestampWrites).toEqual([
      { beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 },
      { beginningOfPassWriteIndex: 4, endOfPassWriteIndex: 5 },
    ]);
    expect(fixture.sceneTimestampWrites).toEqual([
      { beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
    ]);
    expect(fixture.timestampQuerySets.size).toBe(1);
    expect(timer.capability).toMatchObject({
      segmentedTimestampWrites: true,
      timestampQueriesPerFrame: 6,
      segmentedSamples: 1,
      validSegmentedSamples: 1,
      segmentedFallbackSamples: 0,
      validPaletteSamples: 1,
      validCullSamples: 1,
      validSceneRenderSamples: 1,
      fusedTimestampResolves: 1,
      standaloneTimestampSubmissions: 0,
    });
    timer.destroy();
    transaction.destroy();
  });

  test("keeps six-query timestamp fusion after Pixi replaces its encoder", async () => {
    const fixture = createSegmentedFixture();
    const transaction = new WebGPUFrameTransaction(fixture.renderer);
    const oldTimer = createGpuFrameTimer(fixture.renderer);
    let staleCancelled = 0;
    transaction.queue("palette", 0, {
      encode: () => fixture.calls.push("stale:palette:encoded"),
      cancel: (reason) => {
        if (reason === "stale") staleCancelled += 1;
      },
    });
    oldTimer.destroy();
    fixture.replaceEncoder();
    const timer = createGpuFrameTimer(fixture.renderer);
    transaction.queue("palette", 1, {
      encode(encoder, timestampWrites) {
        fixture.calls.push("palette");
        encoder
          .beginComputePass(timestampWrites === undefined ? undefined : { timestampWrites })
          .end();
      },
    });
    transaction.queue("cull", 1, {
      encode(encoder, timestampWrites) {
        fixture.calls.push("cull");
        encoder
          .beginComputePass(timestampWrites === undefined ? undefined : { timestampWrites })
          .end();
      },
    });

    const sample = await timer.measure(fixture.render);

    expect(staleCancelled).toBe(1);
    expect(sample).toMatchObject({
      gpuTimestampMs: 8,
      paletteGpuTimestampMs: 1,
      cullGpuTimestampMs: 2,
      sceneRenderGpuTimestampMs: 5,
    });
    expect(fixture.calls.filter((call) => call === "submit")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call === "resolve:6")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call === "copy")).toHaveLength(1);
    expect(fixture.timestampQuerySets.size).toBe(1);
    expect(timer.capability).toMatchObject({
      segmentedTimestampWrites: true,
      timestampQueriesPerFrame: 6,
      validSegmentedSamples: 1,
      fusedTimestampResolves: 1,
      standaloneTimestampSubmissions: 0,
    });
    expect(transaction.stats).toMatchObject({
      cancelledWork: 1,
      encodedWork: 2,
      fusedSubmissions: 1,
      standaloneSubmissions: 0,
      submissions: 1,
    });
    timer.destroy();
    transaction.destroy();
  });

  test("keeps six-query timestamp fusion after Pixi replaces the device on one encoder", async () => {
    const fixture = createSegmentedFixture();
    const encoder = fixture.encoder;
    const originalRenderStart = encoder.renderStart;
    const originalPostrender = encoder.postrender;
    const transaction = new WebGPUFrameTransaction(fixture.renderer);
    const oldTimer = createGpuFrameTimer(fixture.renderer);
    let staleCancelled = 0;
    transaction.queue("palette", 0, {
      encode: () => fixture.calls.push("stale:palette:encoded"),
      cancel: (reason) => {
        if (reason === "stale") staleCancelled += 1;
      },
    });
    oldTimer.destroy();
    fixture.replaceDevice();
    expect(fixture.encoder).toBe(encoder);
    const timer = createGpuFrameTimer(fixture.renderer);
    transaction.queue("palette", 1, {
      encode(productEncoder, timestampWrites) {
        fixture.calls.push("palette");
        productEncoder
          .beginComputePass(timestampWrites === undefined ? undefined : { timestampWrites })
          .end();
      },
    });
    transaction.queue("cull", 1, {
      encode(productEncoder, timestampWrites) {
        fixture.calls.push("cull");
        productEncoder
          .beginComputePass(timestampWrites === undefined ? undefined : { timestampWrites })
          .end();
      },
    });

    const sample = await timer.measure(fixture.render);

    expect(staleCancelled).toBe(1);
    expect(sample).toMatchObject({
      gpuTimestampMs: 8,
      paletteGpuTimestampMs: 1,
      cullGpuTimestampMs: 2,
      sceneRenderGpuTimestampMs: 5,
    });
    expect(fixture.calls.filter((call) => call === "submit")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call === "resolve:6")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call === "copy")).toHaveLength(1);
    expect(fixture.timestampQuerySets.size).toBe(1);
    expect(timer.capability).toMatchObject({
      segmentedTimestampWrites: true,
      timestampQueriesPerFrame: 6,
      validSegmentedSamples: 1,
      fusedTimestampResolves: 1,
      standaloneTimestampSubmissions: 0,
    });
    expect(transaction.stats).toMatchObject({
      cancelledWork: 1,
      encodedWork: 2,
      fusedSubmissions: 1,
      standaloneSubmissions: 0,
      submissions: 1,
    });
    timer.destroy();
    transaction.destroy();
    expect(encoder.renderStart).toBe(originalRenderStart);
    expect(encoder.postrender).toBe(originalPostrender);
  });

  test("reports explicit segmented fallback when no frame transaction publishes pass timestamps", async () => {
    const fixture = createSegmentedFixture();
    const timer = createGpuFrameTimer(fixture.renderer);

    const sample = await timer.measure(fixture.render);

    expect(sample).toMatchObject({
      gpuTimestampMs: 5,
      paletteGpuTimestampMs: null,
      cullGpuTimestampMs: null,
      sceneRenderGpuTimestampMs: 5,
    });
    expect(fixture.calls.filter((call) => call === "submit")).toHaveLength(1);
    expect(timer.capability).toMatchObject({
      segmentedTimestampWrites: false,
      segmentedSamples: 1,
      validSegmentedSamples: 0,
      segmentedFallbackSamples: 1,
      validPaletteSamples: 0,
      validCullSamples: 0,
      validSceneRenderSamples: 1,
      segmentedReason: "WebGPU frame transaction timestamp boundaries were not observed",
      fusedTimestampResolves: 1,
      standaloneTimestampSubmissions: 0,
    });
    timer.destroy();
  });

  test("delays timestamp readback until a three-slot ring wraps and drains in frame order", async () => {
    const fixture = createReadbackRingFixture();
    const timer = createGpuFrameTimer(fixture.renderer);

    const first = await timer.measureProductFrame(fixture.render);
    const second = await timer.measureProductFrame(fixture.render);
    const third = await timer.measureProductFrame(fixture.render);

    expect([first.token, second.token, third.token]).toEqual([0, 1, 2]);
    expect(fixture.calls.filter((call) => call.startsWith("map:"))).toHaveLength(0);

    const fourth = await timer.measureProductFrame(fixture.render);

    expect(fourth.token).toBe(3);
    expect(fixture.calls.filter((call) => call === "map:0")).toHaveLength(1);
    expect(fixture.calls.indexOf("unmap:0")).toBeLessThan(
      fixture.calls.lastIndexOf("timestampWrites:0"),
    );

    const samples = await timer.drain();

    expect(samples.map((sample) => sample.token)).toEqual([0, 1, 2, 3]);
    expect(samples.map((sample) => sample.gpuTimestampMs)).toEqual([1, 2, 3, 1]);
    expect(samples.every((sample) => sample.timestampReadbackWallMs >= 0)).toBe(true);
    expect(timer.capability).toMatchObject({
      samples: 4,
      validSamples: 4,
      fallbackSamples: 0,
      fusedTimestampResolves: 4,
      standaloneTimestampSubmissions: 0,
      timestampReadbackMode: "deferred-ring",
      timestampReadbackRingSize: 3,
      pendingTimestampReadbacks: 0,
      maxPendingTimestampReadbacks: 3,
    });
    timer.destroy();
  });

  test("keeps frame tokens ordered when drain mappings settle out of order", async () => {
    const waits = Array.from({ length: 3 }, () => deferred<void>());
    const fixture = createReadbackRingFixture(waits.map((wait) => wait.promise));
    const timer = createGpuFrameTimer(fixture.renderer);

    await timer.measureProductFrame(fixture.render);
    await timer.measureProductFrame(fixture.render);
    await timer.measureProductFrame(fixture.render);

    const draining = timer.drain();
    expect(fixture.calls.filter((call) => call.startsWith("map:"))).toEqual([
      "map:0",
      "map:1",
      "map:2",
    ]);

    waits[2]!.resolve();
    await Promise.resolve();
    expect(fixture.calls).toContain("unmap:2");
    waits[0]!.resolve();
    await Promise.resolve();
    expect(fixture.calls).toContain("unmap:0");
    waits[1]!.resolve();

    const samples = await draining;
    expect(samples.map((sample) => sample.token)).toEqual([0, 1, 2]);
    expect(samples.map((sample) => sample.gpuTimestampMs)).toEqual([1, 2, 3]);
    expect(fixture.calls.filter((call) => call.startsWith("unmap:"))).toEqual([
      "unmap:2",
      "unmap:0",
      "unmap:1",
    ]);
    timer.destroy();
  });

  test("falls back per failed readback and destroys every ring resource exactly once", async () => {
    const waits = Array.from({ length: 3 }, () => deferred<void>());
    const fixture = createReadbackRingFixture(waits.map((wait) => wait.promise));
    const timer = createGpuFrameTimer(fixture.renderer);

    await timer.measureProductFrame(fixture.render);
    await timer.measureProductFrame(fixture.render);
    await timer.measureProductFrame(fixture.render);
    const draining = timer.drain();
    waits[2]!.resolve();
    waits[0]!.reject(new Error("slot zero map failed"));
    waits[1]!.resolve();

    const samples = await draining;
    expect(samples.map((sample) => sample.token)).toEqual([0, 1, 2]);
    expect(samples.map((sample) => sample.gpuTimestampMs)).toEqual([null, 2, 3]);
    expect(timer.capability).toMatchObject({
      samples: 3,
      validSamples: 2,
      fallbackSamples: 1,
      gpuTimeSource: "mixed",
      quality: "mixed",
      pendingTimestampReadbacks: 0,
      reason: "slot zero map failed",
    });

    timer.destroy();
    timer.destroy();
    expectRingResourcesDestroyedOnce(fixture.calls);
  });

  test("releases pending slots exactly once when destroyed before phase drain", async () => {
    const fixture = createReadbackRingFixture();
    const timer = createGpuFrameTimer(fixture.renderer);

    await timer.measureProductFrame(fixture.render);
    await timer.measureProductFrame(fixture.render);
    expect(timer.capability.pendingTimestampReadbacks).toBe(2);

    timer.destroy();
    timer.destroy();

    expect(timer.capability.pendingTimestampReadbacks).toBe(0);
    await expect(timer.drain()).rejects.toThrow("GPU frame timer is destroyed");
    expectRingResourcesDestroyedOnce(fixture.calls);
  });

  test("freezes timer state when destroy interrupts active mappings and cleanup throws", async () => {
    const waits = Array.from({ length: 3 }, () => deferred<void>());
    const fixture = createReadbackRingFixture(
      waits.map((wait) => wait.promise),
      {
        kind: "resolve",
        slot: 1,
        message: "slot one destroy failed",
      },
    );
    const timer = createGpuFrameTimer(fixture.renderer);

    await timer.measureProductFrame(fixture.render);
    await timer.measureProductFrame(fixture.render);
    await timer.measureProductFrame(fixture.render);
    const draining = timer.drain();
    expect(fixture.calls.filter((call) => call.startsWith("map:"))).toHaveLength(3);

    expect(() => timer.destroy()).toThrow("slot one destroy failed");
    const destroyedCapability = timer.capability;
    waits[2]!.resolve();
    waits[0]!.resolve();
    waits[1]!.resolve();

    await expect(draining).rejects.toThrow("GPU frame timer is destroyed");
    expect(timer.capability).toBe(destroyedCapability);
    expect(timer.capability).toMatchObject({
      samples: 0,
      validSamples: 0,
      fallbackSamples: 0,
      pendingTimestampReadbacks: 0,
    });
    expect(fixture.calls.filter((call) => call.startsWith("range:"))).toHaveLength(0);
    expect(fixture.calls.filter((call) => call.startsWith("unmap:"))).toHaveLength(0);
    expect(() => timer.destroy()).not.toThrow();
    expectRingResourcesDestroyedOnce(fixture.calls);
  });

  for (const frameCount of [260, 1_220]) {
    test(`retains ${String(frameCount)} complete segmented samples with one fused product submission per frame`, async () => {
      const fixture = createReadbackRingFixture();
      const timer = createGpuFrameTimer(fixture.renderer);
      const transaction = new WebGPUFrameTransaction(fixture.renderer);

      for (let frame = 0; frame < frameCount; frame += 1) {
        transaction.queue("cull", 0, {
          encode(encoder, timestampWrites) {
            encoder
              .beginComputePass(timestampWrites === undefined ? undefined : { timestampWrites })
              .end();
          },
        });
        await timer.measureProductFrame(fixture.render);
      }
      const samples = await timer.drain();

      expect(samples).toHaveLength(frameCount);
      expect(samples.every((sample, token) => sample.token === token)).toBe(true);
      expect(samples.every((sample) => sample.gpuTimestampMs !== null)).toBe(true);
      expect(samples.every((sample) => sample.paletteGpuTimestampMs === 0)).toBe(true);
      expect(samples.every((sample) => sample.cullGpuTimestampMs === 0.5)).toBe(true);
      expect(samples.every((sample) => sample.sceneRenderGpuTimestampMs !== null)).toBe(true);
      expect(fixture.calls.filter((call) => call === "submit")).toHaveLength(frameCount);
      expect(timer.capability).toMatchObject({
        samples: frameCount,
        validSamples: frameCount,
        fallbackSamples: 0,
        segmentedTimestampWrites: true,
        segmentedSamples: frameCount,
        validSegmentedSamples: frameCount,
        segmentedFallbackSamples: 0,
        validPaletteSamples: frameCount,
        validCullSamples: frameCount,
        validSceneRenderSamples: frameCount,
        fusedTimestampResolves: frameCount,
        standaloneTimestampSubmissions: 0,
        pendingTimestampReadbacks: 0,
      });
      expect(transaction.stats).toMatchObject({
        submissions: frameCount,
        fusedSubmissions: frameCount,
        standaloneSubmissions: 0,
      });
      transaction.destroy();
      timer.destroy();
    });
  }

  test("rolls back timestamp resources and hooks when lifecycle hook installation fails", () => {
    for (const failAt of [
      "postrender",
      "beginRenderPass",
      "beginRenderPassAfterMutation",
      "finishRenderPass",
      "finishRenderPassAfterMutation",
    ] as const) {
      const fixture = createHookInstallationFailureFixture(failAt);
      const originalBeginRenderPass = fixture.encoder.beginRenderPass;
      const originalFinishRenderPass = fixture.encoder.finishRenderPass;
      const originalPostrender = fixture.encoder.postrender;
      const originalPostrenderDescriptor = Object.getOwnPropertyDescriptor(
        fixture.encoder,
        "postrender",
      );

      const timer = createGpuFrameTimer(fixture.renderer);

      expect(timer.capability).toMatchObject({
        method: "completion-wall",
        supported: false,
        reason: `${failAt} install failed`,
      });
      expect(fixture.encoder.beginRenderPass).toBe(originalBeginRenderPass);
      expect(fixture.encoder.finishRenderPass).toBe(originalFinishRenderPass);
      expect(fixture.encoder.postrender).toBe(originalPostrender);
      expect(Object.getOwnPropertyDescriptor(fixture.encoder, "postrender")).toEqual(
        originalPostrenderDescriptor,
      );
      expect(fixture.resourceDestroys).toEqual({ query: 3, read: 3, resolve: 3 });
      timer.destroy();
      expect(fixture.resourceDestroys).toEqual({ query: 3, read: 3, resolve: 3 });
    }
  });

  test("continues timer destruction after cleanup throws and reports the first error", () => {
    const fixture = createCleanupFailureFixture();
    const originalBeginRenderPass = fixture.encoder.beginRenderPass;
    const originalFinishRenderPass = fixture.encoder.finishRenderPass;
    const originalPostrender = fixture.encoder.postrender;
    const timer = createGpuFrameTimer(fixture.renderer);

    expect(() => timer.destroy()).toThrow("resolve cleanup failed");

    expect(fixture.encoder.beginRenderPass).toBe(originalBeginRenderPass);
    expect(fixture.encoder.finishRenderPass).toBe(originalFinishRenderPass);
    expect(fixture.encoder.postrender).toBe(originalPostrender);
    expect(fixture.resourceDestroys).toEqual({ query: 3, read: 3, resolve: 3 });
    expect(() => timer.destroy()).not.toThrow();
    expect(fixture.resourceDestroys).toEqual({ query: 3, read: 3, resolve: 3 });
  });

  test("commits fused resolve telemetry only after the product submission succeeds", async () => {
    const fixture = createFixture();
    const timer = createGpuFrameTimer(fixture.renderer);
    const transaction = new WebGPUFrameTransaction(fixture.renderer);
    let failed = 0;
    transaction.queue("cull", 0, {
      encode: () => fixture.calls.push("transaction-work"),
      fail: () => {
        failed += 1;
      },
    });

    await expect(
      timer.measure(() => {
        fixture.encoder.renderStart();
        fixture.encoder.beginRenderPass(fixture.renderTarget);
        fixture.encoder.finishRenderPass();
        throw new Error("render failed before product submit");
      }),
    ).rejects.toThrow("render failed before product submit");

    expect(fixture.calls.filter((call) => call === "resolve")).toHaveLength(1);
    expect(fixture.calls.filter((call) => call === "submit")).toHaveLength(0);
    expect(timer.capability).toMatchObject({
      samples: 0,
      fusedTimestampResolves: 0,
      standaloneTimestampSubmissions: 0,
    });

    expect((await timer.measure(fixture.render)).gpuTimestampMs).toBe(4);
    expect(failed).toBe(1);
    expect(fixture.calls.filter((call) => call === "submit")).toHaveLength(1);
    expect(timer.capability).toMatchObject({
      samples: 1,
      validSamples: 1,
      fusedTimestampResolves: 1,
      standaloneTimestampSubmissions: 0,
    });
    transaction.destroy();
    timer.destroy();
  });

  test("restores exact own and inherited lifecycle hook descriptors", async () => {
    for (const hookPlacement of ["own", "prototype"] as const) {
      const fixture = createFixture(hookPlacement);
      const originalDescriptors = Object.fromEntries(
        ["beginRenderPass", "finishRenderPass", "postrender"].map((name) => [
          name,
          Object.getOwnPropertyDescriptor(fixture.encoder, name),
        ]),
      );
      const timer = createGpuFrameTimer(fixture.renderer);

      expect((await timer.measure(fixture.render)).gpuTimestampMs).toBe(4);
      timer.destroy();

      for (const name of ["beginRenderPass", "finishRenderPass", "postrender"] as const) {
        expect(Object.getOwnPropertyDescriptor(fixture.encoder, name)).toEqual(
          originalDescriptors[name],
        );
      }
    }
  });

  test("preserves frame transaction failure semantics when render throws after the pass begins", async () => {
    const fixture = createFixture();
    const originalBeginRenderPass = fixture.encoder.beginRenderPass;
    const originalFinishRenderPass = fixture.encoder.finishRenderPass;
    const originalPostrender = fixture.encoder.postrender;
    const timer = createGpuFrameTimer(fixture.renderer);
    const transaction = new WebGPUFrameTransaction(fixture.renderer);
    let completed = 0;
    let failed = 0;
    transaction.queue("cull", 0, {
      encode: () => fixture.calls.push("transaction-work"),
      complete: () => {
        completed += 1;
      },
      fail: () => {
        failed += 1;
      },
    });

    await expect(
      timer.measure(() => {
        fixture.encoder.renderStart();
        fixture.encoder.beginRenderPass(fixture.renderTarget);
        throw new Error("render failed after beginRenderPass");
      }),
    ).rejects.toThrow("render failed after beginRenderPass");

    expect(fixture.calls.filter((call) => call === "submit")).toHaveLength(0);
    expect(completed).toBe(0);
    expect(failed).toBe(0);
    expect(timer.capability).toMatchObject({
      samples: 0,
      fusedTimestampResolves: 0,
      standaloneTimestampSubmissions: 0,
    });

    const recovered = await timer.measure(fixture.render);

    expect(recovered.gpuTimestampMs).toBe(4);
    expect(fixture.calls.filter((call) => call === "submit")).toHaveLength(1);
    expect(completed).toBe(0);
    expect(failed).toBe(1);
    transaction.destroy();
    timer.destroy();
    expect(completed).toBe(0);
    expect(failed).toBe(1);
    expect(fixture.calls.filter((call) => call.startsWith("destroy-"))).toEqual([
      "destroy-read",
      "destroy-resolve",
      "destroy-query",
      "destroy-read",
      "destroy-resolve",
      "destroy-query",
      "destroy-read",
      "destroy-resolve",
      "destroy-query",
    ]);
    expect(fixture.encoder.beginRenderPass).toBe(originalBeginRenderPass);
    expect(fixture.encoder.finishRenderPass).toBe(originalFinishRenderPass);
    expect(fixture.encoder.postrender).toBe(originalPostrender);
  });

  test("composes with frame transactions across either install and destroy order", async () => {
    for (const installOrder of ["timer-first", "transaction-first"] as const) {
      for (const destroyOrder of ["timer-first", "transaction-first"] as const) {
        const fixture = createFixture("prototype");
        const originalRenderStart = fixture.encoder.renderStart;
        const originalBeginRenderPass = fixture.encoder.beginRenderPass;
        const originalFinishRenderPass = fixture.encoder.finishRenderPass;
        const originalPostrender = fixture.encoder.postrender;
        for (const name of [
          "renderStart",
          "beginRenderPass",
          "finishRenderPass",
          "postrender",
        ] as const) {
          expect(Object.hasOwn(fixture.encoder, name)).toBe(false);
        }
        let timer: ReturnType<typeof createGpuFrameTimer>;
        let transaction: WebGPUFrameTransaction;
        if (installOrder === "timer-first") {
          timer = createGpuFrameTimer(fixture.renderer);
          transaction = new WebGPUFrameTransaction(fixture.renderer);
        } else {
          transaction = new WebGPUFrameTransaction(fixture.renderer);
          timer = createGpuFrameTimer(fixture.renderer);
        }
        const transactionRenderStart = fixture.encoder.renderStart;
        const transactionPostrender = fixture.encoder.postrender;
        for (const name of [
          "renderStart",
          "beginRenderPass",
          "finishRenderPass",
          "postrender",
        ] as const) {
          expect(Object.hasOwn(fixture.encoder, name)).toBe(true);
        }
        transaction.queue("cull", 0, {
          encode: () => fixture.calls.push("transaction-work"),
        });

        const sample = await timer.measure(fixture.render);

        expect(sample.gpuTimestampMs).toBe(4);
        expect(fixture.calls.filter((call) => call === "submit")).toHaveLength(1);
        expect(transaction.stats).toMatchObject({
          submissions: 1,
          fusedSubmissions: 1,
          standaloneSubmissions: 0,
        });
        if (destroyOrder === "timer-first") {
          timer.destroy();
          expect(fixture.encoder.renderStart).toBe(transactionRenderStart);
          expect(fixture.encoder.postrender).toBe(transactionPostrender);
          expect(Object.hasOwn(fixture.encoder, "renderStart")).toBe(true);
          expect(Object.hasOwn(fixture.encoder, "postrender")).toBe(true);
          expect(Object.hasOwn(fixture.encoder, "beginRenderPass")).toBe(false);
          expect(Object.hasOwn(fixture.encoder, "finishRenderPass")).toBe(false);
          expect(fixture.encoder.beginRenderPass).toBe(originalBeginRenderPass);
          expect(fixture.encoder.finishRenderPass).toBe(originalFinishRenderPass);
          transaction.destroy();
        } else {
          transaction.destroy();
          expect(fixture.encoder.renderStart).toBe(originalRenderStart);
          expect(fixture.encoder.postrender).not.toBe(transactionPostrender);
          expect(fixture.encoder.postrender).not.toBe(originalPostrender);
          expect(Object.hasOwn(fixture.encoder, "renderStart")).toBe(false);
          expect(Object.hasOwn(fixture.encoder, "postrender")).toBe(true);
          expect(Object.hasOwn(fixture.encoder, "beginRenderPass")).toBe(true);
          expect(Object.hasOwn(fixture.encoder, "finishRenderPass")).toBe(true);
          timer.destroy();
        }
        expect(fixture.encoder.renderStart).toBe(originalRenderStart);
        expect(fixture.encoder.beginRenderPass).toBe(originalBeginRenderPass);
        expect(fixture.encoder.finishRenderPass).toBe(originalFinishRenderPass);
        expect(fixture.encoder.postrender).toBe(originalPostrender);
        for (const name of [
          "renderStart",
          "beginRenderPass",
          "finishRenderPass",
          "postrender",
        ] as const) {
          expect(Object.hasOwn(fixture.encoder, name)).toBe(false);
        }
      }
    }
  });
});

function createHookInstallationFailureFixture(
  failAt:
    | "postrender"
    | "beginRenderPass"
    | "beginRenderPassAfterMutation"
    | "finishRenderPass"
    | "finishRenderPassAfterMutation",
) {
  const resourceDestroys = { query: 0, read: 0, resolve: 0 };
  const beginRenderPass = () => {};
  const finishRenderPass = () => {};
  const postrender = () => {};
  const target = {
    commandEncoder: null,
    beginRenderPass,
    finishRenderPass,
    postrender,
  };
  if (failAt === "beginRenderPass" || failAt === "beginRenderPassAfterMutation") {
    let current = beginRenderPass;
    Object.defineProperty(target, "beginRenderPass", {
      configurable: true,
      get: () => current,
      set: (value: typeof beginRenderPass) => {
        if (failAt === "beginRenderPassAfterMutation") current = value;
        throw new Error(`${failAt} install failed`);
      },
    });
  } else if (failAt === "finishRenderPass" || failAt === "finishRenderPassAfterMutation") {
    let current = finishRenderPass;
    Object.defineProperty(target, "finishRenderPass", {
      configurable: true,
      get: () => current,
      set: (value: typeof finishRenderPass) => {
        if (failAt === "finishRenderPassAfterMutation") current = value;
        throw new Error(`${failAt} install failed`);
      },
    });
  }
  const encoder =
    failAt === "postrender"
      ? new Proxy(target, {
          defineProperty(inner, property, descriptor) {
            if (property === "postrender" && "get" in descriptor) {
              throw new Error("postrender install failed");
            }
            return Reflect.defineProperty(inner, property, descriptor);
          },
        })
      : target;
  const buffers = Array.from({ length: 3 }, () => [
    {
      destroy() {
        resourceDestroys.resolve += 1;
      },
    },
    {
      destroy() {
        resourceDestroys.read += 1;
      },
    },
  ]).flat();
  const device = {
    features: { has: (feature: string) => feature === "timestamp-query" },
    createQuerySet: () => ({
      destroy() {
        resourceDestroys.query += 1;
      },
    }),
    createBuffer: () => buffers.shift(),
    queue: { onSubmittedWorkDone: async () => {} },
  };
  return { encoder, renderer: { encoder, gpu: { device } } as never, resourceDestroys };
}

function createCleanupFailureFixture() {
  const resourceDestroys = { query: 0, read: 0, resolve: 0 };
  const encoder = {
    commandEncoder: null,
    beginRenderPass() {},
    finishRenderPass() {},
    postrender() {},
  };
  const buffers = Array.from({ length: 3 }, () => [
    {
      destroy() {
        resourceDestroys.resolve += 1;
        throw new Error("resolve cleanup failed");
      },
    },
    {
      destroy() {
        resourceDestroys.read += 1;
      },
    },
  ]).flat();
  const device = {
    features: { has: (feature: string) => feature === "timestamp-query" },
    createQuerySet: () => ({
      destroy() {
        resourceDestroys.query += 1;
        throw new Error("query cleanup failed");
      },
    }),
    createBuffer: () => buffers.shift(),
    queue: { onSubmittedWorkDone: async () => {} },
  };
  return { encoder, renderer: { encoder, gpu: { device } } as never, resourceDestroys };
}

function createFixture(hookPlacement: "own" | "prototype" = "prototype") {
  const calls: string[] = [];
  const timestampData = new BigUint64Array([1_000_000n, 5_000_000n]);
  const readBuffer = {
    mapAsync: async () => calls.push("map"),
    getMappedRange: () => timestampData.buffer,
    unmap: () => calls.push("unmap"),
    destroy: () => calls.push("destroy-read"),
  };
  const resolveBuffer = { destroy: () => calls.push("destroy-resolve") };
  const queue = {
    submit: (_commands: readonly unknown[]) => calls.push("submit"),
    onSubmittedWorkDone: async () => calls.push("done"),
  };
  const device = {
    features: { has: (feature: string) => feature === "timestamp-query" },
    createQuerySet: () => ({ destroy: () => calls.push("destroy-query") }),
    createBuffer: (() => {
      let buffers = 0;
      return () => (buffers++ % 2 === 0 ? resolveBuffer : readBuffer);
    })(),
    createCommandEncoder: () => ({
      resolveQuerySet: () => calls.push("resolve"),
      copyBufferToBuffer: () => calls.push("copy"),
      finish: () => ({}),
    }),
    queue,
  };
  const renderTarget: { descriptor: { timestampWrites?: unknown } } = { descriptor: {} };
  const encoderPrototype = {
    renderStart(this: any) {
      this.commandEncoder = device.createCommandEncoder();
    },
    beginRenderPass(this: any, _target: typeof renderTarget) {
      this.renderPassOpen = true;
    },
    finishRenderPass(this: any) {
      this.renderPassOpen = false;
    },
    postrender(this: any) {
      this.finishRenderPass();
      const commandEncoder = this.commandEncoder;
      if (commandEncoder === null) throw new Error("missing product command encoder");
      queue.submit([commandEncoder.finish()]);
      this.commandEncoder = null;
    },
  };
  const encoderSubclassPrototype = Object.create(encoderPrototype) as typeof encoderPrototype;
  const encoder = Object.assign(
    hookPlacement === "prototype"
      ? (Object.create(encoderSubclassPrototype) as typeof encoderPrototype)
      : { ...encoderPrototype },
    {
      commandEncoder: null as ReturnType<typeof device.createCommandEncoder> | null,
      renderPassOpen: false,
    },
  );
  const renderer = { encoder, gpu: { device } } as never;
  const render = () => {
    encoder.renderStart();
    encoder.beginRenderPass(renderTarget);
    encoder.postrender();
  };

  return { calls, encoder, renderer, render, renderTarget };
}

function createSegmentedFixture() {
  const calls: string[] = [];
  const computeTimestampWrites: Array<{
    beginningOfPassWriteIndex?: number;
    endOfPassWriteIndex?: number;
  }> = [];
  const sceneTimestampWrites: Array<{
    beginningOfPassWriteIndex?: number;
    endOfPassWriteIndex?: number;
  }> = [];
  const timestampQuerySets = new Set<object>();
  const timestampData = new BigUint64Array([
    4_000_000n,
    9_000_000n,
    1_000_000n,
    2_000_000n,
    2_000_000n,
    4_000_000n,
  ]);
  const readBuffer = {
    mapAsync: async () => calls.push("map"),
    getMappedRange: () => timestampData.buffer,
    unmap: () => calls.push("unmap"),
    destroy: () => calls.push("destroy-read"),
  };
  const resolveBuffer = { destroy: () => calls.push("destroy-resolve") };
  const queue = {
    submit: (_commands: readonly unknown[]) => calls.push("submit"),
    onSubmittedWorkDone: async () => calls.push("done"),
  };
  const createCommandEncoder = () => {
    const encoder = {
      resolveQuerySet: (_querySet: object, _firstQuery: number, queryCount: number) =>
        calls.push(`resolve:${String(queryCount)}`),
      copyBufferToBuffer: () => calls.push("copy"),
      finish: () => ({}),
      beginComputePass: (descriptor?: {
        timestampWrites?: {
          querySet: object;
          beginningOfPassWriteIndex?: number;
          endOfPassWriteIndex?: number;
        };
      }) => {
        const writes = descriptor?.timestampWrites;
        if (writes !== undefined) {
          timestampQuerySets.add(writes.querySet);
          computeTimestampWrites.push({
            ...(writes.beginningOfPassWriteIndex === undefined
              ? {}
              : { beginningOfPassWriteIndex: writes.beginningOfPassWriteIndex }),
            ...(writes.endOfPassWriteIndex === undefined
              ? {}
              : { endOfPassWriteIndex: writes.endOfPassWriteIndex }),
          });
        }
        return { end: () => calls.push("compute-end") };
      },
    } satisfies {
      resolveQuerySet(_querySet: object, _firstQuery: number, queryCount: number): void;
      copyBufferToBuffer(): void;
      finish(): object;
      beginComputePass(descriptor?: {
        timestampWrites?: {
          querySet: object;
          beginningOfPassWriteIndex?: number;
          endOfPassWriteIndex?: number;
        };
      }): { end(): void };
    };
    return encoder;
  };
  let bufferAllocation = 0;
  const device = {
    features: { has: (feature: string) => feature === "timestamp-query" },
    createQuerySet: ({ count }: { count: number }) => {
      calls.push(`query:${String(count)}`);
      return { destroy: () => calls.push("destroy-query") };
    },
    createBuffer: () => (bufferAllocation++ % 2 === 0 ? resolveBuffer : readBuffer),
    createCommandEncoder,
    queue,
  };
  const gpu: { device: typeof device } = { device };
  const renderTarget: {
    descriptor: {
      timestampWrites?: {
        querySet: object;
        beginningOfPassWriteIndex?: number;
        endOfPassWriteIndex?: number;
      };
    };
  } = { descriptor: {} };
  const createPixiEncoder = () => ({
    commandEncoder: null as ReturnType<typeof createCommandEncoder> | null,
    renderStart() {
      this.commandEncoder = gpu.device.createCommandEncoder();
    },
    beginRenderPass(target: typeof renderTarget) {
      const writes = target.descriptor.timestampWrites;
      if (writes !== undefined) {
        timestampQuerySets.add(writes.querySet);
        sceneTimestampWrites.push({
          ...(writes.beginningOfPassWriteIndex === undefined
            ? {}
            : { beginningOfPassWriteIndex: writes.beginningOfPassWriteIndex }),
          ...(writes.endOfPassWriteIndex === undefined
            ? {}
            : { endOfPassWriteIndex: writes.endOfPassWriteIndex }),
        });
      }
    },
    finishRenderPass() {},
    postrender() {
      this.finishRenderPass();
      const commandEncoder = this.commandEncoder;
      if (commandEncoder === null) throw new Error("missing product command encoder");
      gpu.device.queue.submit([commandEncoder.finish()]);
      this.commandEncoder = null;
    },
  });
  const renderer = { encoder: createPixiEncoder(), gpu };
  const render = () => {
    const encoder = renderer.encoder;
    encoder.renderStart();
    encoder.beginRenderPass(renderTarget);
    encoder.postrender();
  };
  return {
    calls,
    computeTimestampWrites,
    get encoder() {
      return renderer.encoder;
    },
    renderer: renderer as never,
    render,
    replaceEncoder: () => {
      renderer.encoder = createPixiEncoder();
    },
    replaceDevice: () => {
      gpu.device = { ...gpu.device };
    },
    sceneTimestampWrites,
    timestampQuerySets,
  };
}

function createReadbackRingFixture(
  mapWaits: readonly Promise<void>[] = Array.from({ length: 3 }, async () => {}),
  destroyFailure?: Readonly<{
    kind: "query" | "read" | "resolve";
    slot: number;
    message: string;
  }>,
) {
  const calls: string[] = [];
  const querySlots = new Map<object, number>();
  const resolveSlots = new Map<object, number>();
  const readSlots = new Map<object, number>();
  const querySets = Array.from({ length: 3 }, (_, slot) => {
    const querySet = {
      destroy: () => {
        calls.push(`destroy-query:${String(slot)}`);
        if (destroyFailure?.kind === "query" && destroyFailure.slot === slot) {
          throw new Error(destroyFailure.message);
        }
      },
    };
    querySlots.set(querySet, slot);
    return querySet;
  });
  const resolveBuffers = Array.from({ length: 3 }, (_, slot) => {
    const buffer = {
      destroy: () => {
        calls.push(`destroy-resolve:${String(slot)}`);
        if (destroyFailure?.kind === "resolve" && destroyFailure.slot === slot) {
          throw new Error(destroyFailure.message);
        }
      },
    };
    resolveSlots.set(buffer, slot);
    return buffer;
  });
  const readBuffers = Array.from({ length: 3 }, (_, slot) => {
    const timestampData = new BigUint64Array([
      1_000_000n,
      BigInt(slot + 2) * 1_000_000n,
      0n,
      0n,
      500_000n,
      1_000_000n,
    ]);
    const buffer = {
      mapAsync: () => {
        calls.push(`map:${String(slot)}`);
        return mapWaits[slot];
      },
      getMappedRange: () => {
        calls.push(`range:${String(slot)}`);
        return timestampData.buffer;
      },
      unmap: () => calls.push(`unmap:${String(slot)}`),
      destroy: () => {
        calls.push(`destroy-read:${String(slot)}`);
        if (destroyFailure?.kind === "read" && destroyFailure.slot === slot) {
          throw new Error(destroyFailure.message);
        }
      },
    };
    readSlots.set(buffer, slot);
    return buffer;
  });
  let queryAllocation = 0;
  let bufferAllocation = 0;
  const queue = {
    submit: (_commands: readonly unknown[]) => calls.push("submit"),
    onSubmittedWorkDone: async () => calls.push("done"),
  };
  const device = {
    features: { has: (feature: string) => feature === "timestamp-query" },
    createQuerySet: () => querySets[queryAllocation++],
    createBuffer: () => {
      const allocation = bufferAllocation++;
      const slot = Math.floor(allocation / 2);
      return allocation % 2 === 0 ? resolveBuffers[slot] : readBuffers[slot];
    },
    createCommandEncoder: () => ({
      resolveQuerySet: (querySet: object) =>
        calls.push(`resolve:${String(querySlots.get(querySet))}`),
      copyBufferToBuffer: (_source: object, _sourceOffset: number, target: object) =>
        calls.push(`copy:${String(readSlots.get(target))}`),
      beginComputePass: () => ({ end() {} }),
      finish: () => ({}),
    }),
    queue,
  };
  const renderTarget: { descriptor: { timestampWrites?: { querySet: object } } } = {
    descriptor: {},
  };
  const encoder = {
    commandEncoder: null as ReturnType<typeof device.createCommandEncoder> | null,
    renderPassOpen: false,
    renderStart() {
      this.commandEncoder = device.createCommandEncoder();
    },
    beginRenderPass(target: typeof renderTarget) {
      this.renderPassOpen = true;
      const querySet = target.descriptor.timestampWrites?.querySet;
      calls.push(
        `timestampWrites:${String(querySet === undefined ? -1 : querySlots.get(querySet))}`,
      );
    },
    finishRenderPass() {
      this.renderPassOpen = false;
    },
    postrender() {
      this.finishRenderPass();
      const commandEncoder = this.commandEncoder;
      if (commandEncoder === null) throw new Error("missing product command encoder");
      queue.submit([commandEncoder.finish()]);
      this.commandEncoder = null;
    },
  };
  const renderer = { encoder, gpu: { device } } as never;
  const render = () => {
    encoder.renderStart();
    encoder.beginRenderPass(renderTarget);
    encoder.postrender();
  };

  return { calls, encoder, renderer, render, renderTarget };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function expectRingResourcesDestroyedOnce(calls: readonly string[]): void {
  for (const kind of ["query", "resolve", "read"] as const) {
    for (let slot = 0; slot < 3; slot += 1) {
      expect(calls.filter((call) => call === `destroy-${kind}:${String(slot)}`)).toHaveLength(1);
    }
  }
}
