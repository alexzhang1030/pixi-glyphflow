import { describe, expect, test } from "bun:test";

import type { WebGPURenderer } from "pixi.js";

import { PALETTE_DENSE_MOVE_STRIDE } from "../src/render/paletteStorage";
import { PaletteStoragePass } from "../src/render/PaletteStoragePass";
import {
  WebGPUFrameTransaction,
  observeWebGPUFrameTimestamps,
} from "../src/render/WebGPUFrameTransaction";
import { installWebGpuGlobals } from "./fixtures/webgpuGlobals";

describe("WebGPUFrameTransaction", () => {
  test("cancels old-device work before rendering through the same Pixi encoder", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const encoder = renderer.encoder;
    const transaction = new WebGPUFrameTransaction(renderer);
    transaction.queue("palette", 1, {
      encode: () => events.push("device-a:palette:encoded"),
      cancel: (reason) => events.push(`device-a:palette:${reason}`),
    });

    replaceFakeDevice(renderer, events, "device-b:");
    expect(renderer.encoder).toBe(encoder);
    transaction.queue("palette", 2, { encode: () => events.push("device-b:palette") });
    transaction.queue("cull", 2, { encode: () => events.push("device-b:cull") });
    encoder.renderStart();
    encoder.postrender();

    expect(events).toEqual([
      "device-a:palette:stale",
      "pixi:renderStart",
      "device-b:palette",
      "device-b:cull",
      "pixi:postrender",
      "device-b:encoder:finish",
      "device-b:queue:submit",
    ]);
    expect(transaction.stats).toMatchObject({
      cancelledWork: 1,
      encodedWork: 2,
      fusedSubmissions: 1,
      standaloneSubmissions: 0,
      submissions: 1,
    });
  });

  test("continues renderStart on the new device when the encoder object stays stable", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const encoder = renderer.encoder;
    const transaction = new WebGPUFrameTransaction(renderer);
    transaction.queue("palette", 1, {
      encode: () => events.push("device-a:palette:encoded"),
      cancel: (reason) => events.push(`device-a:palette:${reason}`),
    });

    replaceFakeDevice(renderer, events, "device-b:");
    encoder.renderStart();
    encoder.postrender();

    expect(events).toEqual([
      "device-a:palette:stale",
      "pixi:renderStart",
      "pixi:postrender",
      "device-b:encoder:finish",
      "device-b:queue:submit",
    ]);
    expect(transaction.stats).toMatchObject({
      cancelledWork: 1,
      encodedWork: 0,
      submissions: 0,
    });
  });

  test("retires old-device pending work when currentEpoch observes a device replacement", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const transaction = new WebGPUFrameTransaction(renderer);
    let cancelled = 0;
    transaction.queue("palette", 1, {
      encode: () => events.push("device-a:palette:encoded"),
      cancel(reason) {
        if (reason === "stale") cancelled += 1;
        events.push(`device-a:palette:${reason}`);
      },
    });

    replaceFakeDevice(renderer, events, "device-b:");

    expect(transaction.currentEpoch).toBe(0);
    expect(transaction.currentEpoch).toBe(0);
    expect(cancelled).toBe(1);
    expect(events).toEqual(["device-a:palette:stale"]);
    expect(transaction.stats).toMatchObject({ cancelledWork: 1, submissions: 0 });
  });

  test("fails an encoded frame when postrender observes a same-encoder device replacement", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const encoder = renderer.encoder;
    const transaction = new WebGPUFrameTransaction(renderer);
    const querySet = {} as GPUQuerySet;
    let completed = 0;
    let failed = 0;
    let timestampFailures = 0;
    const detach = observeWebGPUFrameTimestamps(renderer, {
      beginFrame() {
        events.push("timestamp:begin");
        return {
          querySet,
          paletteStartQuery: 0,
          paletteEndQuery: 1,
          cullStartQuery: 2,
          cullEndQuery: 3,
        };
      },
      endFrame() {
        events.push("timestamp:end");
      },
      fail() {
        timestampFailures += 1;
        events.push("timestamp:failed");
      },
    });
    const oldWork = (stage: "palette" | "cull") => ({
      encode: () => events.push(`device-a:${stage}`),
      complete: () => {
        completed += 1;
        events.push(`device-a:${stage}:complete`);
      },
      fail: () => {
        failed += 1;
        events.push(`device-a:${stage}:failed`);
      },
    });
    transaction.queue("palette", 1, oldWork("palette"));
    transaction.queue("cull", 1, oldWork("cull"));
    const staleRenderStart = encoder.renderStart;
    encoder.renderStart();
    const stalePostrender = encoder.postrender;

    replaceFakeDevice(renderer, events, "device-b:");
    encoder.postrender();

    expect(failed).toBe(2);
    expect(completed).toBe(0);
    expect(timestampFailures).toBe(1);
    const eventsAfterRetirement = events.length;
    staleRenderStart.call(encoder);
    stalePostrender.call(encoder);
    expect(events).toHaveLength(eventsAfterRetirement);

    detach();
    transaction.queue("palette", 2, { encode: () => events.push("device-b:palette") });
    transaction.queue("cull", 2, { encode: () => events.push("device-b:cull") });
    encoder.renderStart();
    encoder.postrender();

    expect(events.filter((event) => event === "queue:submit")).toHaveLength(0);
    expect(events.filter((event) => event === "device-b:queue:submit")).toHaveLength(1);
    expect(events.slice(-6)).toEqual([
      "pixi:renderStart",
      "device-b:palette",
      "device-b:cull",
      "pixi:postrender",
      "device-b:encoder:finish",
      "device-b:queue:submit",
    ]);
    expect(transaction.stats).toMatchObject({
      failedWork: 2,
      encodedWork: 2,
      fusedSubmissions: 1,
      standaloneSubmissions: 0,
      submissions: 1,
    });
  });

  test("cancels old-device pending work when flush observes a same-encoder replacement", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const transaction = new WebGPUFrameTransaction(renderer);
    transaction.queue("palette", 1, {
      encode: () => events.push("device-a:palette:encoded"),
      cancel: (reason) => events.push(`device-a:palette:${reason}`),
    });
    transaction.queue("cull", 1, {
      encode: () => events.push("device-a:cull:encoded"),
      cancel: (reason) => events.push(`device-a:cull:${reason}`),
    });

    replaceFakeDevice(renderer, events, "device-b:");
    expect(transaction.flush()).toEqual({ ok: true, submitted: false, encodedWork: 0 });

    transaction.queue("palette", 2, { encode: () => events.push("device-b:palette") });
    transaction.queue("cull", 2, { encode: () => events.push("device-b:cull") });
    expect(transaction.flush()).toEqual({ ok: true, submitted: true, encodedWork: 2 });
    expect(events).toEqual([
      "device-a:palette:stale",
      "device-a:cull:stale",
      "device-b:palette",
      "device-b:cull",
      "device-b:encoder:finish",
      "device-b:queue:submit",
    ]);
    expect(transaction.stats).toMatchObject({
      cancelledWork: 2,
      encodedWork: 2,
      fusedSubmissions: 0,
      standaloneSubmissions: 1,
      submissions: 1,
    });
  });

  test("retires an encoded final owner when destroy observes a same-encoder device replacement", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const encoder = renderer.encoder;
    const originalRenderStart = encoder.renderStart;
    const originalPostrender = encoder.postrender;
    const transaction = new WebGPUFrameTransaction(renderer);
    let completed = 0;
    let failed = 0;
    let retired = 0;
    transaction.queue("palette", 1, {
      encode: () => events.push("device-a:palette"),
      complete: () => {
        completed += 1;
      },
      fail: () => {
        failed += 1;
        events.push("device-a:palette:failed");
      },
    });
    encoder.renderStart();
    const stalePostrender = encoder.postrender;

    replaceFakeDevice(renderer, events, "device-b:");
    transaction.destroy(() => {
      retired += 1;
      events.push("retire");
    });

    expect(failed).toBe(1);
    expect(completed).toBe(0);
    expect(retired).toBe(1);
    expect(encoder.renderStart).toBe(originalRenderStart);
    expect(encoder.postrender).toBe(originalPostrender);
    const eventsAfterDestroy = events.length;
    stalePostrender.call(encoder);
    expect(events).toHaveLength(eventsAfterDestroy);
    expect(events.filter((event) => event.endsWith("queue:submit"))).toHaveLength(0);
    expect(transaction.stats).toMatchObject({ failedWork: 1, submissions: 0 });
  });

  test("restores hooks when a deferred final owner meets a same-encoder device replacement", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const encoder = renderer.encoder;
    const originalRenderStart = encoder.renderStart;
    const originalPostrender = encoder.postrender;
    const transaction = new WebGPUFrameTransaction(renderer);
    const querySet = {} as GPUQuerySet;
    let completed = 0;
    let failed = 0;
    let retired = 0;
    let timestampFailures = 0;
    const detach = observeWebGPUFrameTimestamps(renderer, {
      beginFrame: () => ({
        querySet,
        paletteStartQuery: 0,
        paletteEndQuery: 1,
        cullStartQuery: 2,
        cullEndQuery: 3,
      }),
      fail: () => {
        timestampFailures += 1;
      },
    });
    transaction.queue("palette", 1, {
      encode: () => events.push("device-a:palette"),
      complete: () => {
        completed += 1;
      },
      fail: () => {
        failed += 1;
        events.push("device-a:palette:failed");
      },
    });
    encoder.renderStart();
    const stalePostrender = encoder.postrender;
    transaction.destroy(() => {
      retired += 1;
      events.push("retire");
    });
    expect({ completed, failed, retired, timestampFailures }).toEqual({
      completed: 0,
      failed: 0,
      retired: 0,
      timestampFailures: 0,
    });

    replaceFakeDevice(renderer, events, "device-b:");
    encoder.postrender();

    expect({ completed, failed, retired, timestampFailures }).toEqual({
      completed: 0,
      failed: 1,
      retired: 1,
      timestampFailures: 1,
    });
    expect(encoder.renderStart).toBe(originalRenderStart);
    expect(encoder.postrender).toBe(originalPostrender);
    expect(events.filter((event) => event.endsWith("queue:submit"))).toHaveLength(0);
    detach();

    const next = new WebGPUFrameTransaction(renderer);
    next.queue("palette", 2, { encode: () => events.push("device-b:palette") });
    encoder.renderStart();
    const eventsBeforeStalePostrender = events.length;
    stalePostrender.call(encoder);
    expect(events).toHaveLength(eventsBeforeStalePostrender);
    encoder.postrender();

    expect(events.filter((event) => event === "device-b:queue:submit")).toHaveLength(1);
    expect(next.stats).toMatchObject({ encodedWork: 1, fusedSubmissions: 1, submissions: 1 });
    next.destroy();
    expect(encoder.renderStart).toBe(originalRenderStart);
    expect(encoder.postrender).toBe(originalPostrender);
  });

  test("moves pending work to a fresh encoder epoch after Pixi replaces its encoder", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const oldEncoder = renderer.encoder;
    const oldRenderStart = oldEncoder.renderStart;
    const oldPostrender = oldEncoder.postrender;
    const transaction = new WebGPUFrameTransaction(renderer);

    transaction.queue("palette", 1, {
      encode: () => events.push("old:palette:encoded"),
      cancel: (reason) => events.push(`old:palette:${reason}`),
    });
    const newEncoder = replaceFakeEncoder(renderer, events);
    const newRenderStart = newEncoder.renderStart;
    const newPostrender = newEncoder.postrender;
    transaction.queue("palette", 2, { encode: () => events.push("new:palette") });
    transaction.queue("cull", 2, { encode: () => events.push("new:cull") });

    expect(oldEncoder.renderStart).toBe(oldRenderStart);
    expect(oldEncoder.postrender).toBe(oldPostrender);
    expect(newEncoder.renderStart).not.toBe(newRenderStart);
    expect(newEncoder.postrender).not.toBe(newPostrender);

    newEncoder.renderStart();
    newEncoder.postrender();

    expect(events).toEqual([
      "old:palette:stale",
      "pixi:renderStart",
      "new:palette",
      "new:cull",
      "pixi:postrender",
      "encoder:finish",
      "queue:submit",
    ]);
    expect(transaction.stats).toMatchObject({
      pendingPaletteSlices: 0,
      pendingCull: false,
      cancelledWork: 1,
      encodedWork: 2,
      fusedSubmissions: 1,
      standaloneSubmissions: 0,
      submissions: 1,
    });
  });

  test("fails an encoded old epoch and ignores its late lifecycle callbacks", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const oldEncoder = renderer.encoder;
    const transaction = new WebGPUFrameTransaction(renderer);
    const querySet = {} as GPUQuerySet;
    let timestampFailures = 0;
    const detach = observeWebGPUFrameTimestamps(renderer, {
      beginFrame() {
        events.push("timestamp:begin");
        return {
          querySet,
          paletteStartQuery: 0,
          paletteEndQuery: 1,
          cullStartQuery: 2,
          cullEndQuery: 3,
        };
      },
      endFrame() {
        events.push("timestamp:end");
      },
      fail(error) {
        timestampFailures += 1;
        events.push(`timestamp:failed:${String(error)}`);
      },
    });
    transaction.queue("palette", 1, {
      encode: () => events.push("old:palette"),
      complete: () => events.push("old:palette:complete"),
      fail: (error) => events.push(`old:palette:failed:${String(error)}`),
    });
    transaction.queue("cull", 1, {
      encode: () => events.push("old:cull"),
      complete: () => events.push("old:cull:complete"),
      fail: (error) => events.push(`old:cull:failed:${String(error)}`),
    });
    oldEncoder.renderStart();
    const staleRenderStart = oldEncoder.renderStart;
    const stalePostrender = oldEncoder.postrender;

    const newEncoder = replaceFakeEncoder(renderer, events);
    transaction.queue("palette", 2, { encode: () => events.push("new:palette") });
    detach();
    transaction.queue("cull", 2, { encode: () => events.push("new:cull") });
    const eventsAfterReplacement = events.length;

    staleRenderStart.call(oldEncoder);
    expect(events).toHaveLength(eventsAfterReplacement);
    expect(timestampFailures).toBe(1);

    newEncoder.renderStart();
    const eventsAfterNewFrameStart = events.length;
    stalePostrender.call(oldEncoder);
    expect(events).toHaveLength(eventsAfterNewFrameStart);
    newEncoder.postrender();

    expect(events.filter((event) => event === "queue:submit")).toHaveLength(1);
    expect(events).not.toContain("old:palette:complete");
    expect(events).not.toContain("old:cull:complete");
    expect(events.slice(-6)).toEqual([
      "pixi:renderStart",
      "new:palette",
      "new:cull",
      "pixi:postrender",
      "encoder:finish",
      "queue:submit",
    ]);
    expect(transaction.stats).toMatchObject({
      failedWork: 2,
      encodedWork: 2,
      fusedSubmissions: 1,
      standaloneSubmissions: 0,
      submissions: 1,
    });
  });

  test("retires an in-flight final owner when destroy races with encoder replacement", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const oldEncoder = renderer.encoder;
    const oldRenderStart = oldEncoder.renderStart;
    const oldPostrender = oldEncoder.postrender;
    const transaction = new WebGPUFrameTransaction(renderer);
    let failed = 0;
    let retired = 0;
    transaction.queue("palette", 1, {
      encode: () => events.push("old:palette"),
      complete: () => events.push("old:palette:complete"),
      fail: () => {
        failed += 1;
        events.push("old:palette:failed");
      },
    });
    oldEncoder.renderStart();
    const stalePostrender = oldEncoder.postrender;

    const newEncoder = replaceFakeEncoder(renderer, events);
    const newRenderStart = newEncoder.renderStart;
    const newPostrender = newEncoder.postrender;
    transaction.destroy(() => {
      retired += 1;
      events.push("retire");
    });

    expect(failed).toBe(1);
    expect(retired).toBe(1);
    expect(oldEncoder.renderStart).toBe(oldRenderStart);
    expect(oldEncoder.postrender).toBe(oldPostrender);
    expect(newEncoder.renderStart).toBe(newRenderStart);
    expect(newEncoder.postrender).toBe(newPostrender);
    const eventsAfterDestroy = events.length;
    stalePostrender.call(oldEncoder);
    expect(events).toHaveLength(eventsAfterDestroy);
    expect(events).not.toContain("old:palette:complete");
    expect(events.filter((event) => event === "queue:submit")).toHaveLength(0);
    expect(transaction.stats).toMatchObject({ failedWork: 1, submissions: 0 });
  });

  test("settles old and rejected work when replacement hook installation fails", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const oldEncoder = renderer.encoder;
    const oldRenderStart = oldEncoder.renderStart;
    const oldPostrender = oldEncoder.postrender;
    const transaction = new WebGPUFrameTransaction(renderer);
    transaction.queue("palette", 1, {
      encode: () => events.push("old:palette:encoded"),
      cancel: (reason) => events.push(`old:palette:${reason}`),
    });

    const newEncoder = replaceFakeEncoder(renderer, events);
    const newRenderStart = newEncoder.renderStart;
    const newPostrender = newEncoder.postrender;
    Object.defineProperty(newEncoder, "postrender", {
      configurable: true,
      value: newPostrender,
      writable: false,
    });
    expect(
      transaction.queue("cull", 2, {
        encode: () => events.push("rejected:cull:encoded"),
        fail: (error) => events.push(`rejected:cull:failed:${String(error)}`),
      }),
    ).toBe(false);

    expect(oldEncoder.renderStart).toBe(oldRenderStart);
    expect(oldEncoder.postrender).toBe(oldPostrender);
    expect(newEncoder.renderStart).toBe(newRenderStart);
    expect(newEncoder.postrender).toBe(newPostrender);
    expect(events).toEqual([
      "old:palette:stale",
      "rejected:cull:failed:TypeError: Pixi encoder postrender hook is not writable",
    ]);

    Object.defineProperty(newEncoder, "postrender", {
      configurable: true,
      value: newPostrender,
      writable: true,
    });
    expect(transaction.queue("palette", 3, { encode: () => events.push("fresh:palette") })).toBe(
      true,
    );
    expect(transaction.queue("cull", 3, { encode: () => events.push("fresh:cull") })).toBe(true);
    newEncoder.renderStart();
    newEncoder.postrender();

    expect(events.slice(-6)).toEqual([
      "pixi:renderStart",
      "fresh:palette",
      "fresh:cull",
      "pixi:postrender",
      "encoder:finish",
      "queue:submit",
    ]);
    expect(transaction.stats).toMatchObject({
      cancelledWork: 1,
      failedWork: 1,
      encodedWork: 2,
      fusedSubmissions: 1,
      standaloneSubmissions: 0,
    });
  });

  test("cancels old pending work when flush observes an encoder replacement", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const oldEncoder = renderer.encoder;
    const oldRenderStart = oldEncoder.renderStart;
    const oldPostrender = oldEncoder.postrender;
    const transaction = new WebGPUFrameTransaction(renderer);
    transaction.queue("palette", 1, {
      encode: () => events.push("old:palette:encoded"),
      cancel: (reason) => events.push(`old:palette:${reason}`),
    });
    transaction.queue("cull", 1, {
      encode: () => events.push("old:cull:encoded"),
      cancel: (reason) => events.push(`old:cull:${reason}`),
    });

    const newEncoder = replaceFakeEncoder(renderer, events);
    const newRenderStart = newEncoder.renderStart;
    const newPostrender = newEncoder.postrender;
    expect(transaction.flush()).toEqual({ ok: true, submitted: false, encodedWork: 0 });

    expect(events).toEqual(["old:palette:stale", "old:cull:stale"]);
    expect(oldEncoder.renderStart).toBe(oldRenderStart);
    expect(oldEncoder.postrender).toBe(oldPostrender);
    expect(newEncoder.renderStart).not.toBe(newRenderStart);
    expect(newEncoder.postrender).not.toBe(newPostrender);
    expect(transaction.stats).toMatchObject({
      cancelledWork: 2,
      encodedWork: 0,
      fusedSubmissions: 0,
      standaloneSubmissions: 0,
      submissions: 0,
    });
  });

  test("threads aggregate palette and cull timestamp writes through product compute passes", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const first = new WebGPUFrameTransaction(renderer);
    const second = new WebGPUFrameTransaction(renderer);
    let productEncoder: GPUCommandEncoder | undefined;
    const querySet = {} as GPUQuerySet;
    const detach = observeWebGPUFrameTimestamps(renderer, {
      beginFrame(encoder) {
        productEncoder ??= encoder;
        expect(encoder).toBe(productEncoder);
        events.push("timestamp:begin");
        return {
          querySet,
          paletteStartQuery: 2,
          paletteEndQuery: 3,
          cullStartQuery: 4,
          cullEndQuery: 5,
        };
      },
      endFrame(summary) {
        events.push(`timestamp:end:${String(summary.palettePasses)}:${String(summary.cullPasses)}`);
      },
    });

    first.queue("palette", 1, {
      encode(encoder, timestampWrites) {
        expect(encoder).toBe(productEncoder as GPUCommandEncoder);
        expect(timestampWrites).toEqual({ querySet, beginningOfPassWriteIndex: 2 });
        events.push("first:palette");
      },
    });
    second.queue("palette", 1, {
      encode(encoder, timestampWrites) {
        expect(encoder).toBe(productEncoder as GPUCommandEncoder);
        expect(timestampWrites).toEqual({ querySet, endOfPassWriteIndex: 3 });
        events.push("second:palette");
      },
    });
    first.queue("cull", 1, {
      encode(_encoder, timestampWrites) {
        expect(timestampWrites).toEqual({ querySet, beginningOfPassWriteIndex: 4 });
        events.push("first:cull");
      },
    });
    second.queue("cull", 1, {
      encode(_encoder, timestampWrites) {
        expect(timestampWrites).toEqual({ querySet, endOfPassWriteIndex: 5 });
        events.push("second:cull");
      },
    });

    renderer.encoder.renderStart();
    renderer.encoder.postrender();

    expect(events).toEqual([
      "pixi:renderStart",
      "timestamp:begin",
      "first:palette",
      "second:palette",
      "first:cull",
      "second:cull",
      "timestamp:end:2:2",
      "pixi:postrender",
      "encoder:finish",
      "queue:submit",
    ]);

    detach();
    detach();
    first.queue("cull", 2, { encode: () => events.push("cull:fresh") });
    renderer.encoder.renderStart();
    renderer.encoder.postrender();
    expect(events.filter((event) => event.startsWith("timestamp:"))).toHaveLength(2);
  });

  test("keeps product submission live when timestamp observation fails", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const transaction = new WebGPUFrameTransaction(renderer);
    const errors: unknown[] = [];
    observeWebGPUFrameTimestamps(renderer, {
      beginFrame() {
        events.push("timestamp:begin");
        throw new Error("timestamp plan failed");
      },
      fail(error) {
        errors.push(error);
      },
    });
    transaction.queue("palette", 1, { encode: () => events.push("palette") });
    transaction.queue("cull", 1, { encode: () => events.push("cull") });

    renderer.encoder.renderStart();
    renderer.encoder.postrender();

    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("timestamp plan failed");
    expect(transaction.stats).toMatchObject({
      encodedWork: 2,
      fusedSubmissions: 1,
      standaloneSubmissions: 0,
    });
    expect(events.slice(-4)).toEqual(["cull", "pixi:postrender", "encoder:finish", "queue:submit"]);
  });

  test("encodes palette work before cull work in one Pixi submission", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const transaction = new WebGPUFrameTransaction(renderer);
    let sharedEncoder: GPUCommandEncoder | undefined;
    expect(transaction.currentEpoch).toBe(0);

    expect(
      transaction.queue("cull", 1, {
        encode(encoder) {
          expect(encoder).toBe(sharedEncoder as GPUCommandEncoder);
          events.push("cull");
        },
      }),
    ).toBe(true);
    expect(
      transaction.queue("palette", 1, {
        encode(encoder) {
          sharedEncoder = encoder;
          events.push("palette");
        },
      }),
    ).toBe(true);

    renderer.encoder.renderStart();
    renderer.encoder.postrender();

    expect(events).toEqual([
      "pixi:renderStart",
      "palette",
      "cull",
      "pixi:postrender",
      "encoder:finish",
      "queue:submit",
    ]);
    expect(transaction.stats).toMatchObject({
      pendingPaletteSlices: 0,
      pendingCull: false,
      fusedSubmissions: 1,
      standaloneSubmissions: 0,
      submissions: 1,
    });
    expect(transaction.currentEpoch).toBe(1);
  });

  test("retains palette slices and coalesces cull work across unrendered commits", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const transaction = new WebGPUFrameTransaction(renderer);

    transaction.queue("palette", 10, { encode: () => events.push("palette:10") });
    transaction.queue("cull", 10, {
      encode: () => events.push("cull:10"),
      cancel: (reason) => events.push(`cull:10:${reason}`),
    });
    transaction.queue("palette", 11, { encode: () => events.push("palette:11") });
    transaction.queue("cull", 11, { encode: () => events.push("cull:11") });

    renderer.encoder.renderStart();
    renderer.encoder.postrender();

    expect(events).toEqual([
      "cull:10:superseded",
      "pixi:renderStart",
      "palette:10",
      "palette:11",
      "cull:11",
      "pixi:postrender",
      "encoder:finish",
      "queue:submit",
    ]);
    expect(transaction.stats).toMatchObject({
      queuedPaletteSlices: 2,
      queuedCulls: 2,
      coalescedCulls: 1,
      cancelledWork: 1,
      encodedWork: 3,
      submissions: 1,
    });
  });

  test("cancels one stale epoch before a rebuilt frame is queued", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const transaction = new WebGPUFrameTransaction(renderer);

    transaction.queue("palette", 40, {
      encode: () => events.push("palette:40"),
      cancel: (reason) => events.push(`palette:40:${reason}`),
    });
    transaction.queue("cull", 40, {
      encode: () => events.push("cull:40"),
      cancel: (reason) => events.push(`cull:40:${reason}`),
    });

    expect(transaction.cancelEpoch(40)).toBe(2);
    transaction.queue("palette", 41, { encode: () => events.push("palette:41") });
    transaction.queue("cull", 41, { encode: () => events.push("cull:41") });
    renderer.encoder.renderStart();
    renderer.encoder.postrender();

    expect(events).toEqual([
      "palette:40:stale",
      "cull:40:stale",
      "pixi:renderStart",
      "palette:41",
      "cull:41",
      "pixi:postrender",
      "encoder:finish",
      "queue:submit",
    ]);
    expect(transaction.stats).toMatchObject({
      cancelledWork: 2,
      encodedWork: 2,
      submissions: 1,
    });
  });

  test("flushes pending work before diagnostic readback starts", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const transaction = new WebGPUFrameTransaction(renderer);

    transaction.queue("cull", 50, { encode: () => events.push("cull") });
    transaction.queue("palette", 50, { encode: () => events.push("palette") });

    expect(transaction.flush()).toEqual({ ok: true, submitted: true, encodedWork: 2 });
    expect(events).toEqual(["palette", "cull", "encoder:finish", "queue:submit"]);
    expect(transaction.stats).toMatchObject({
      pendingPaletteSlices: 0,
      pendingCull: false,
      fusedSubmissions: 0,
      standaloneSubmissions: 1,
      submissions: 1,
      encodedWork: 2,
    });
    expect(transaction.currentEpoch).toBe(1);
    expect(transaction.flush()).toEqual({ ok: true, submitted: false, encodedWork: 0 });
    expect(transaction.currentEpoch).toBe(1);
  });

  test("abandons a failed flush and cancels the dependent work", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const transaction = new WebGPUFrameTransaction(renderer);

    transaction.queue("palette", 60, {
      encode() {
        events.push("palette");
        throw new Error("palette validation failed");
      },
      fail: (error) => events.push(`palette:failed:${String(error)}`),
    });
    transaction.queue("cull", 60, {
      encode: () => events.push("cull"),
      cancel: (reason) => events.push(`cull:${reason}`),
    });

    expect(transaction.flush()).toEqual({
      ok: false,
      submitted: false,
      encodedWork: 0,
      reason: "palette validation failed",
    });
    expect(events).toEqual([
      "palette",
      "palette:failed:Error: palette validation failed",
      "cull:failed",
    ]);
    expect(transaction.stats).toMatchObject({
      pendingPaletteSlices: 0,
      pendingCull: false,
      failedWork: 1,
      cancelledWork: 1,
      submissions: 0,
    });
  });

  test("fails the throwing palette slice and cancels the drained frame across owners", () => {
    const events: string[] = [];
    const releases = new Map<string, number>();
    const renderer = fakeRenderer(events);
    const first = new WebGPUFrameTransaction(renderer);
    const second = new WebGPUFrameTransaction(renderer);
    const release = (name: string): void => {
      releases.set(name, (releases.get(name) ?? 0) + 1);
    };

    first.queue("palette", 80, {
      encode: () => {
        events.push("first:palette");
      },
      complete: () => release("first:palette"),
      cancel: (reason) => {
        events.push(`first:palette:${reason}`);
        release("first:palette");
      },
    });
    first.queue("cull", 80, {
      encode: () => events.push("first:cull:stale"),
      cancel: (reason) => {
        events.push(`first:cull:${reason}`);
        release("first:cull");
      },
    });
    second.queue("palette", 80, {
      encode: () => {
        events.push("second:palette:1");
      },
      complete: () => release("second:palette:1"),
      cancel: (reason) => {
        events.push(`second:palette:1:${reason}`);
        release("second:palette:1");
      },
    });
    second.queue("palette", 80, {
      encode: () => {
        events.push("second:palette:2");
        first.queue("cull", 80, {
          encode: () => events.push("first:cull:late:stale"),
          cancel: (reason) => {
            events.push(`first:cull:late:${reason}`);
            release("first:cull:late");
          },
        });
        throw new Error("second palette failed");
      },
      fail: (error) => {
        events.push(`second:palette:2:failed:${String(error)}`);
        release("second:palette:2");
      },
    });
    second.queue("palette", 80, {
      encode: () => events.push("second:palette:3:stale"),
      cancel: (reason) => {
        events.push(`second:palette:3:${reason}`);
        release("second:palette:3");
      },
    });
    second.queue("cull", 80, {
      encode: () => events.push("second:cull:stale"),
      cancel: (reason) => {
        events.push(`second:cull:${reason}`);
        release("second:cull");
      },
    });

    expect(() => renderer.encoder.renderStart()).toThrow("second palette failed");

    expect(events).toEqual([
      "pixi:renderStart",
      "first:palette",
      "second:palette:1",
      "second:palette:2",
      "second:palette:2:failed:Error: second palette failed",
      "first:palette:failed",
      "second:palette:1:failed",
      "second:palette:3:failed",
      "first:cull:failed",
      "second:cull:failed",
      "first:cull:late:failed",
    ]);
    expect([...releases]).toEqual([
      ["second:palette:2", 1],
      ["first:palette", 1],
      ["second:palette:1", 1],
      ["second:palette:3", 1],
      ["first:cull", 1],
      ["second:cull", 1],
      ["first:cull:late", 1],
    ]);
    expect(first.stats).toMatchObject({
      pendingPaletteSlices: 0,
      pendingCull: false,
      encodedWork: 0,
      cancelledWork: 3,
      failedWork: 0,
      submissions: 0,
    });
    expect(second.stats).toMatchObject({
      pendingPaletteSlices: 0,
      pendingCull: false,
      encodedWork: 0,
      cancelledWork: 3,
      failedWork: 1,
      submissions: 0,
    });

    first.queue("cull", 81, { encode: () => events.push("first:cull:fresh") });
    renderer.encoder.renderStart();
    renderer.encoder.postrender();

    expect(events.slice(-4)).toEqual([
      "first:cull:fresh",
      "pixi:postrender",
      "encoder:finish",
      "queue:submit",
    ]);
    expect(first.stats).toMatchObject({ encodedWork: 1, fusedSubmissions: 1, submissions: 1 });
  });

  test("aborts an encoded frame when Pixi submission fails and recovers on the next frame", () => {
    const events: string[] = [];
    const controls: FakeRendererControls = {};
    const renderer = fakeRenderer(events, controls);
    const originalRenderStart = renderer.encoder.renderStart;
    const originalPostrender = renderer.encoder.postrender;
    const transaction = new WebGPUFrameTransaction(renderer);

    transaction.queue("palette", 90, {
      encode: () => events.push("palette"),
      complete: () => events.push("palette:complete"),
      fail: (error) => events.push(`palette:failed:${String(error)}`),
    });
    transaction.queue("cull", 90, {
      encode: () => events.push("cull"),
      complete: () => events.push("cull:complete"),
      fail: (error) => events.push(`cull:failed:${String(error)}`),
    });

    renderer.encoder.renderStart();
    controls.submitError = new Error("injected queue failure");
    expect(() => renderer.encoder.postrender()).toThrow("injected queue failure");

    expect(events).toEqual([
      "pixi:renderStart",
      "palette",
      "cull",
      "pixi:postrender",
      "encoder:finish",
      "queue:submit",
      "palette:failed:Error: injected queue failure",
      "cull:failed:Error: injected queue failure",
    ]);
    expect(transaction.stats).toMatchObject({
      pendingPaletteSlices: 0,
      pendingCull: false,
      encodedWork: 0,
      failedWork: 2,
      fusedSubmissions: 0,
      submissions: 0,
    });

    controls.submitError = undefined;
    transaction.queue("cull", 91, {
      encode: () => events.push("cull:fresh"),
      complete: () => events.push("cull:fresh:complete"),
    });
    renderer.encoder.renderStart();
    renderer.encoder.postrender();

    expect(events.slice(-6)).toEqual([
      "pixi:renderStart",
      "cull:fresh",
      "pixi:postrender",
      "encoder:finish",
      "queue:submit",
      "cull:fresh:complete",
    ]);
    expect(transaction.stats).toMatchObject({
      encodedWork: 1,
      failedWork: 2,
      fusedSubmissions: 1,
      submissions: 1,
    });
    transaction.destroy();
    expect(renderer.encoder.renderStart).toBe(originalRenderStart);
    expect(renderer.encoder.postrender).toBe(originalPostrender);
  });

  test("invalidates earlier palette and cull work when a later owner cull throws", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const first = new WebGPUFrameTransaction(renderer);
    const second = new WebGPUFrameTransaction(renderer);

    first.queue("palette", 100, {
      encode: () => events.push("first:palette"),
      cancel: (reason) => events.push(`first:palette:${reason}`),
    });
    first.queue("cull", 100, {
      encode: () => events.push("first:cull"),
      cancel: (reason) => events.push(`first:cull:${reason}`),
    });
    second.queue("palette", 100, {
      encode: () => events.push("second:palette"),
      cancel: (reason) => events.push(`second:palette:${reason}`),
    });
    second.queue("cull", 100, {
      encode() {
        events.push("second:cull");
        throw new Error("later cull failed");
      },
      fail: (error) => events.push(`second:cull:failed:${String(error)}`),
    });

    expect(() => renderer.encoder.renderStart()).toThrow("later cull failed");
    expect(events).toEqual([
      "pixi:renderStart",
      "first:palette",
      "second:palette",
      "first:cull",
      "second:cull",
      "second:cull:failed:Error: later cull failed",
      "first:palette:failed",
      "second:palette:failed",
      "first:cull:failed",
    ]);
    expect(first.stats).toMatchObject({ cancelledWork: 2, encodedWork: 0, submissions: 0 });
    expect(second.stats).toMatchObject({
      cancelledWork: 1,
      failedWork: 1,
      encodedWork: 0,
      submissions: 0,
    });

    first.queue("palette", 101, {
      encode: () => events.push("first:palette:rebuilt"),
      complete: () => events.push("first:palette:rebuilt:complete"),
    });
    first.queue("cull", 101, {
      encode: () => events.push("first:cull:rebuilt"),
      complete: () => events.push("first:cull:rebuilt:complete"),
    });
    renderer.encoder.renderStart();
    renderer.encoder.postrender();

    expect(events.slice(-8)).toEqual([
      "pixi:renderStart",
      "first:palette:rebuilt",
      "first:cull:rebuilt",
      "pixi:postrender",
      "encoder:finish",
      "queue:submit",
      "first:palette:rebuilt:complete",
      "first:cull:rebuilt:complete",
    ]);
    expect(first.stats).toMatchObject({ encodedWork: 2, fusedSubmissions: 1, submissions: 1 });
  });

  test("restores prototype lifecycle placement after the final owner is destroyed", () => {
    const events: string[] = [];
    const renderer = fakePrototypeRenderer(events);
    const encoder = renderer.encoder;
    const originalRenderStart = encoder.renderStart;
    const originalPostrender = encoder.postrender;
    expect(Object.hasOwn(encoder, "renderStart")).toBe(false);
    expect(Object.hasOwn(encoder, "postrender")).toBe(false);

    const transaction = new WebGPUFrameTransaction(renderer);

    expect(Object.hasOwn(encoder, "renderStart")).toBe(true);
    expect(Object.hasOwn(encoder, "postrender")).toBe(true);
    transaction.destroy();

    expect(Object.hasOwn(encoder, "renderStart")).toBe(false);
    expect(Object.hasOwn(encoder, "postrender")).toBe(false);
    expect(encoder.renderStart).toBe(originalRenderStart);
    expect(encoder.postrender).toBe(originalPostrender);
  });

  test("restores prototype placement when the second lifecycle hook cannot be installed", () => {
    const events: string[] = [];
    const renderer = fakePrototypeRenderer(events);
    const encoder = renderer.encoder;
    const prototype = Object.getPrototypeOf(encoder) as object;
    const originalRenderStart = encoder.renderStart;
    const originalPostrender = encoder.postrender;
    Object.defineProperty(prototype, "postrender", {
      configurable: true,
      value: originalPostrender,
      writable: false,
    });

    expect(() => new WebGPUFrameTransaction(renderer)).toThrow();

    expect(Object.hasOwn(encoder, "renderStart")).toBe(false);
    expect(Object.hasOwn(encoder, "postrender")).toBe(false);
    expect(encoder.renderStart).toBe(originalRenderStart);
    expect(encoder.postrender).toBe(originalPostrender);
  });

  test("rolls back renderStart when postrender is non-writable", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const encoder = renderer.encoder;
    const originalRenderStart = encoder.renderStart;
    const originalPostrender = encoder.postrender;
    let activeRenderStart = originalRenderStart;
    let renderStartWrites = 0;
    Object.defineProperty(encoder, "renderStart", {
      configurable: true,
      get: () => activeRenderStart,
      set: (hook: typeof originalRenderStart) => {
        renderStartWrites += 1;
        activeRenderStart = hook;
      },
    });
    Object.defineProperty(encoder, "postrender", {
      configurable: true,
      value: originalPostrender,
      writable: false,
    });

    expect(() => new WebGPUFrameTransaction(renderer)).toThrow();

    expect(renderStartWrites).toBe(2);
    expect(encoder.renderStart).toBe(originalRenderStart);
    expect(encoder.postrender).toBe(originalPostrender);

    Object.defineProperty(encoder, "postrender", {
      configurable: true,
      value: originalPostrender,
      writable: true,
    });
    const retry = new WebGPUFrameTransaction(renderer);
    retry.destroy();

    expect(renderStartWrites).toBe(4);
    expect(encoder.renderStart).toBe(originalRenderStart);
    expect(encoder.postrender).toBe(originalPostrender);
  });

  test("rolls back attempted lifecycle writes in reverse order when postrender setter throws", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const encoder = renderer.encoder;
    const originalRenderStart = encoder.renderStart;
    const originalPostrender = encoder.postrender;
    let activeRenderStart = originalRenderStart;
    let activePostrender = originalPostrender;
    const writes: string[] = [];
    Object.defineProperty(encoder, "renderStart", {
      configurable: true,
      get: () => activeRenderStart,
      set: (hook: typeof originalRenderStart) => {
        activeRenderStart = hook;
        writes.push(`renderStart:${hook === originalRenderStart ? "original" : "hook"}`);
      },
    });
    Object.defineProperty(encoder, "postrender", {
      configurable: true,
      get: () => activePostrender,
      set: (hook: typeof originalPostrender) => {
        activePostrender = hook;
        writes.push(`postrender:${hook === originalPostrender ? "original" : "hook"}`);
        if (hook !== originalPostrender) throw new Error("postrender hook setter failed");
      },
    });

    expect(() => new WebGPUFrameTransaction(renderer)).toThrow("postrender hook setter failed");

    expect(writes).toEqual([
      "renderStart:hook",
      "postrender:hook",
      "postrender:original",
      "renderStart:original",
    ]);
    expect(encoder.renderStart).toBe(originalRenderStart);
    expect(encoder.postrender).toBe(originalPostrender);
  });

  test("restores exact lifecycle descriptors when a setter mutates placement before throwing", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const encoder = renderer.encoder;
    const originalRenderStart = encoder.renderStart;
    const originalPostrender = encoder.postrender;
    let activeRenderStart = originalRenderStart;
    let activePostrender = originalPostrender;
    Object.defineProperty(encoder, "renderStart", {
      configurable: true,
      enumerable: false,
      get: () => activeRenderStart,
      set: (hook: typeof originalRenderStart) => {
        activeRenderStart = hook;
      },
    });
    Object.defineProperty(encoder, "postrender", {
      configurable: true,
      enumerable: false,
      get: () => activePostrender,
      set: (hook: typeof originalPostrender) => {
        if (hook === originalPostrender) {
          activePostrender = hook;
          return;
        }
        Object.defineProperty(encoder, "postrender", {
          configurable: true,
          enumerable: true,
          value: hook,
          writable: true,
        });
        throw new Error("postrender descriptor setter failed");
      },
    });
    const originalRenderStartDescriptor = Object.getOwnPropertyDescriptor(encoder, "renderStart");
    const originalPostrenderDescriptor = Object.getOwnPropertyDescriptor(encoder, "postrender");

    expect(() => new WebGPUFrameTransaction(renderer)).toThrow(
      "postrender descriptor setter failed",
    );

    expect(Object.getOwnPropertyDescriptor(encoder, "renderStart")).toEqual(
      originalRenderStartDescriptor,
    );
    expect(Object.getOwnPropertyDescriptor(encoder, "postrender")).toEqual(
      originalPostrenderDescriptor,
    );
    expect(encoder.renderStart).toBe(originalRenderStart);
    expect(encoder.postrender).toBe(originalPostrender);
  });

  test("rolls back a first lifecycle assignment that mutates before throwing", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const encoder = renderer.encoder;
    const originalRenderStart = encoder.renderStart;
    const originalPostrender = encoder.postrender;
    let activeRenderStart = originalRenderStart;
    let postrenderWrites = 0;
    const writes: string[] = [];
    Object.defineProperty(encoder, "renderStart", {
      configurable: true,
      get: () => activeRenderStart,
      set: (hook: typeof originalRenderStart) => {
        activeRenderStart = hook;
        writes.push(`renderStart:${hook === originalRenderStart ? "original" : "hook"}`);
        if (hook !== originalRenderStart) throw new Error("renderStart hook setter failed");
      },
    });
    Object.defineProperty(encoder, "postrender", {
      configurable: true,
      get: () => originalPostrender,
      set: () => {
        postrenderWrites += 1;
      },
    });

    expect(() => new WebGPUFrameTransaction(renderer)).toThrow("renderStart hook setter failed");

    expect(writes).toEqual(["renderStart:hook", "renderStart:original"]);
    expect(postrenderWrites).toBe(0);
    expect(encoder.renderStart).toBe(originalRenderStart);
    expect(encoder.postrender).toBe(originalPostrender);
  });

  test("keeps renderer hooks live until the final owner is destroyed", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const originalRenderStart = renderer.encoder.renderStart;
    const originalPostrender = renderer.encoder.postrender;
    const first = new WebGPUFrameTransaction(renderer);
    const second = new WebGPUFrameTransaction(renderer);

    first.queue("palette", 70, {
      encode: () => events.push("first"),
      cancel: (reason) => events.push(`first:${reason}`),
    });
    second.queue("palette", 70, { encode: () => events.push("second") });
    first.destroy();
    expect(
      first.queue("cull", 71, {
        encode: () => events.push("late"),
        cancel: (reason) => events.push(`late:${reason}`),
      }),
    ).toBe(false);

    renderer.encoder.renderStart();
    renderer.encoder.postrender();
    second.destroy();

    expect(events).toEqual([
      "first:destroyed",
      "late:destroyed",
      "pixi:renderStart",
      "second",
      "pixi:postrender",
      "encoder:finish",
      "queue:submit",
    ]);
    expect(renderer.encoder.renderStart).toBe(originalRenderStart);
    expect(renderer.encoder.postrender).toBe(originalPostrender);
  });

  test("defers final-owner retirement until its encoded frame is submitted", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const originalRenderStart = renderer.encoder.renderStart;
    const originalPostrender = renderer.encoder.postrender;
    const transaction = new WebGPUFrameTransaction(renderer);
    let releases = 0;
    let retired = 0;

    transaction.queue("palette", 110, {
      encode: () => events.push("palette"),
      complete: () => {
        releases += 1;
        events.push("palette:complete");
      },
      cancel: (reason) => {
        releases += 1;
        events.push(`palette:${reason}`);
      },
    });
    renderer.encoder.renderStart();
    transaction.destroy(() => {
      retired += 1;
      events.push("retire");
    });

    expect(retired).toBe(0);
    expect(releases).toBe(0);
    expect(renderer.encoder.renderStart).not.toBe(originalRenderStart);
    expect(renderer.encoder.postrender).not.toBe(originalPostrender);

    renderer.encoder.postrender();

    expect(events).toEqual([
      "pixi:renderStart",
      "palette",
      "pixi:postrender",
      "encoder:finish",
      "queue:submit",
      "palette:complete",
      "retire",
    ]);
    expect(releases).toBe(1);
    expect(retired).toBe(1);
    expect(renderer.encoder.renderStart).toBe(originalRenderStart);
    expect(renderer.encoder.postrender).toBe(originalPostrender);
  });

  test("retires a final in-flight owner after Pixi submission fails", () => {
    const events: string[] = [];
    const controls: FakeRendererControls = {};
    const renderer = fakeRenderer(events, controls);
    const originalRenderStart = renderer.encoder.renderStart;
    const originalPostrender = renderer.encoder.postrender;
    const transaction = new WebGPUFrameTransaction(renderer);
    let releases = 0;
    let retired = 0;

    transaction.queue("palette", 115, {
      encode: () => events.push("palette"),
      complete: () => {
        releases += 1;
        events.push("palette:complete");
      },
      fail: (error) => {
        releases += 1;
        events.push(`palette:failed:${String(error)}`);
      },
    });
    renderer.encoder.renderStart();
    transaction.destroy(() => {
      retired += 1;
      events.push("retire");
    });
    controls.submitError = new Error("destroyed frame submit failed");

    expect(() => renderer.encoder.postrender()).toThrow("destroyed frame submit failed");

    expect(events).toEqual([
      "pixi:renderStart",
      "palette",
      "pixi:postrender",
      "encoder:finish",
      "queue:submit",
      "palette:failed:Error: destroyed frame submit failed",
      "retire",
    ]);
    expect(releases).toBe(1);
    expect(retired).toBe(1);
    expect(transaction.stats).toMatchObject({
      encodedWork: 0,
      failedWork: 1,
      fusedSubmissions: 0,
      submissions: 0,
    });
    expect(renderer.encoder.renderStart).toBe(originalRenderStart);
    expect(renderer.encoder.postrender).toBe(originalPostrender);
  });

  test("retires one in-flight owner while keeping shared hooks for the surviving owner", () => {
    const events: string[] = [];
    const renderer = fakeRenderer(events);
    const originalRenderStart = renderer.encoder.renderStart;
    const originalPostrender = renderer.encoder.postrender;
    const first = new WebGPUFrameTransaction(renderer);
    const second = new WebGPUFrameTransaction(renderer);
    const releases = new Map<string, number>();
    const release = (name: string): void => {
      releases.set(name, (releases.get(name) ?? 0) + 1);
      events.push(`${name}:complete`);
    };

    first.queue("palette", 120, {
      encode: () => events.push("first"),
      complete: () => release("first"),
    });
    second.queue("palette", 120, {
      encode: () => events.push("second"),
      complete: () => release("second"),
    });
    renderer.encoder.renderStart();
    first.destroy(() => events.push("first:retire"));
    renderer.encoder.postrender();

    expect(releases).toEqual(
      new Map([
        ["first", 1],
        ["second", 1],
      ]),
    );
    expect(events.slice(-3)).toEqual(["first:complete", "second:complete", "first:retire"]);
    expect(renderer.encoder.renderStart).not.toBe(originalRenderStart);
    expect(renderer.encoder.postrender).not.toBe(originalPostrender);

    second.queue("cull", 121, {
      encode: () => events.push("second:fresh"),
      complete: () => release("second:fresh"),
    });
    renderer.encoder.renderStart();
    renderer.encoder.postrender();
    second.destroy(() => events.push("second:retire"));

    expect(releases.get("second:fresh")).toBe(1);
    expect(events.at(-1)).toBe("second:retire");
    expect(renderer.encoder.renderStart).toBe(originalRenderStart);
    expect(renderer.encoder.postrender).toBe(originalPostrender);
  });

  test("keeps overlapping dense palette commits ordered in independent slices", () => {
    const commandWrites: unknown[] = [];
    const uniformWrites: unknown[] = [];
    const pipelines: string[] = [];
    const submits: unknown[] = [];
    const computePassDescriptors: Array<GPUComputePassDescriptor | undefined> = [];
    let computePassCount = 0;
    let failComputePassAt = Number.POSITIVE_INFINITY;
    const transforms = { label: "transforms", size: 1_024, usage: 0x0080 };
    const device = {
      limits: {
        maxStorageBufferBindingSize: 1_048_576,
        maxBufferSize: 1_048_576,
      },
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createComputePipeline: ({ compute }: { compute: { entryPoint: string } }) => ({
        entryPoint: compute.entryPoint,
      }),
      createBuffer: ({ label, size, usage }: { label: string; size: number; usage: number }) => ({
        label,
        size,
        usage,
        destroy() {},
      }),
      createBindGroup: ({ entries }: { entries: readonly GPUBindGroupEntry[] }) => ({ entries }),
      createCommandEncoder: () => ({
        beginComputePass: (descriptor?: GPUComputePassDescriptor) => {
          computePassDescriptors.push(descriptor);
          computePassCount += 1;
          if (computePassCount === failComputePassAt) {
            throw new Error("injected palette encode failure");
          }
          return {
            setBindGroup() {},
            setPipeline: (pipeline: { entryPoint: string }) => pipelines.push(pipeline.entryPoint),
            dispatchWorkgroups() {},
            end() {},
          };
        },
        finish: () => ({ label: "pixi-frame" }),
      }),
      queue: {
        writeBuffer: (buffer: { label: string }) => {
          if (buffer.label.includes("commands")) commandWrites.push(buffer);
          if (buffer.label.includes("uniforms")) uniformWrites.push(buffer);
        },
        submit: (commands: unknown) => submits.push(commands),
      },
    };
    const encoder = {
      commandEncoder: null as GPUCommandEncoder | null,
      renderStart() {
        this.commandEncoder = device.createCommandEncoder() as unknown as GPUCommandEncoder;
      },
      postrender() {
        const commandEncoder = this.commandEncoder;
        if (commandEncoder === null) throw new Error("missing fake command encoder");
        device.queue.submit([commandEncoder.finish()]);
        this.commandEncoder = null;
      },
    };
    const renderer = {
      gpu: { device },
      buffer: { updateBuffer() {}, getGPUBuffer: () => transforms },
      encoder,
    } as unknown as WebGPURenderer;
    const restoreGpuGlobals = installWebGpuGlobals({
      GPUShaderStage: { COMPUTE: 4 },
      GPUBufferUsage: { STORAGE: 0x0080, COPY_DST: 0x0008, UNIFORM: 0x0040 },
    });
    try {
      const transaction = new WebGPUFrameTransaction(renderer);
      const querySet = {} as GPUQuerySet;
      const detachTimestampObserver = observeWebGPUFrameTimestamps(renderer, {
        beginFrame: () => ({
          querySet,
          paletteStartQuery: 2,
          paletteEndQuery: 3,
          cullStartQuery: 4,
          cullEndQuery: 5,
        }),
      });
      const pass = new PaletteStoragePass(renderer, transaction);
      expect(pass.initialize()).toBe(true);
      expect(pass.ensureTransforms(64).ok).toBe(true);
      const first = new Float32Array([10, 11]).buffer;
      const second = new Float32Array([20, 21]).buffer;
      expect(first.byteLength).toBe(PALETTE_DENSE_MOVE_STRIDE);
      expect(
        pass.dispatchMovesDetailed({ mode: "dense", baseSlot: 7, commands: first, count: 1 }).ok,
      ).toBe(true);
      expect(
        pass.dispatchMovesDetailed({ mode: "dense", baseSlot: 7, commands: second, count: 1 }).ok,
      ).toBe(true);
      expect(submits).toHaveLength(0);
      expect(commandWrites).toHaveLength(2);
      expect(commandWrites[0]).not.toBe(commandWrites[1]);
      expect(uniformWrites).toHaveLength(2);
      expect(uniformWrites[0]).not.toBe(uniformWrites[1]);

      renderer.encoder.renderStart();
      renderer.encoder.postrender();

      expect(pipelines).toEqual(["patch_xy_dense", "patch_xy_dense"]);
      expect(computePassDescriptors.slice(0, 2)).toEqual([
        { timestampWrites: { querySet, beginningOfPassWriteIndex: 2 } },
        { timestampWrites: { querySet, endOfPassWriteIndex: 3 } },
      ]);
      expect(submits).toHaveLength(1);
      expect(transaction.stats).toMatchObject({
        queuedPaletteSlices: 2,
        encodedWork: 2,
        fusedSubmissions: 1,
        submissions: 1,
      });

      expect(
        pass.dispatchMovesDetailed({ mode: "dense", baseSlot: 7, commands: first, count: 1 }).ok,
      ).toBe(true);
      expect(
        pass.dispatchMovesDetailed({ mode: "dense", baseSlot: 7, commands: second, count: 1 }).ok,
      ).toBe(true);
      expect(
        pass.dispatchMovesDetailed({ mode: "dense", baseSlot: 7, commands: first, count: 1 }).ok,
      ).toBe(true);
      failComputePassAt = computePassCount + 2;
      expect(() => renderer.encoder.renderStart()).toThrow("injected palette encode failure");

      expect(submits).toHaveLength(1);
      expect(transaction.stats).toMatchObject({
        pendingPaletteSlices: 0,
        encodedWork: 2,
        failedWork: 1,
        cancelledWork: 2,
        fusedSubmissions: 1,
        submissions: 1,
      });
      expect(pass.requiresFullSync).toBe(true);

      failComputePassAt = Number.POSITIVE_INFINITY;
      expect(
        pass.dispatchMovesDetailed({ mode: "dense", baseSlot: 7, commands: second, count: 1 }).ok,
      ).toBe(true);
      expect(commandWrites[5]).toBe(commandWrites[2]);
      renderer.encoder.renderStart();
      renderer.encoder.postrender();
      expect(submits).toHaveLength(2);
      expect(transaction.stats).toMatchObject({
        pendingPaletteSlices: 0,
        encodedWork: 3,
        fusedSubmissions: 2,
        submissions: 2,
      });
      transaction.destroy();
      detachTimestampObserver();
      pass.destroy();
    } finally {
      restoreGpuGlobals();
    }
  });
});

interface FakeRendererControls {
  submitError?: Error | undefined;
}

function fakeRenderer(events: string[], controls: FakeRendererControls = {}): WebGPURenderer {
  const device = createFakeDevice(events, controls);
  const gpu: { device: GPUDevice } = { device };
  const encoder = fakeEncoder(events, () => gpu.device);
  return {
    gpu,
    encoder,
  } as unknown as WebGPURenderer;
}

function fakeEncoder(events: string[], currentDevice: () => GPUDevice): WebGPURenderer["encoder"] {
  const encoder: {
    commandEncoder: GPUCommandEncoder | null;
    renderStart(): void;
    postrender(): void;
  } = {
    commandEncoder: null,
    renderStart() {
      events.push("pixi:renderStart");
      this.commandEncoder = currentDevice().createCommandEncoder();
    },
    postrender() {
      events.push("pixi:postrender");
      const commandEncoder = this.commandEncoder;
      if (commandEncoder === null) throw new Error("missing fake command encoder");
      currentDevice().queue.submit([commandEncoder.finish()]);
      this.commandEncoder = null;
    },
  };
  return encoder as unknown as WebGPURenderer["encoder"];
}

function createFakeDevice(
  events: string[],
  controls: FakeRendererControls = {},
  eventPrefix = "",
): GPUDevice {
  return {
    createCommandEncoder(): GPUCommandEncoder {
      return {
        finish() {
          events.push(`${eventPrefix}encoder:finish`);
          return {} as GPUCommandBuffer;
        },
      } as GPUCommandEncoder;
    },
    queue: {
      submit() {
        events.push(`${eventPrefix}queue:submit`);
        if (controls.submitError !== undefined) throw controls.submitError;
      },
    },
  } as unknown as GPUDevice;
}

function replaceFakeDevice(
  renderer: WebGPURenderer,
  events: string[],
  eventPrefix: string,
): GPUDevice {
  const device = createFakeDevice(events, {}, eventPrefix);
  (renderer.gpu as unknown as { device: GPUDevice }).device = device;
  return device;
}

function fakePrototypeRenderer(
  events: string[],
  controls: FakeRendererControls = {},
): WebGPURenderer {
  const renderer = fakeRenderer(events, controls);
  const encoder = renderer.encoder;
  const prototype = Object.create(Object.getPrototypeOf(encoder) as object) as object;
  Object.defineProperties(prototype, {
    renderStart: {
      configurable: true,
      value: encoder.renderStart,
      writable: true,
    },
    postrender: {
      configurable: true,
      value: encoder.postrender,
      writable: true,
    },
  });
  Object.setPrototypeOf(encoder, prototype);
  Reflect.deleteProperty(encoder, "renderStart");
  Reflect.deleteProperty(encoder, "postrender");
  return renderer;
}

function replaceFakeEncoder(renderer: WebGPURenderer, events: string[]): WebGPURenderer["encoder"] {
  const device = renderer.gpu.device;
  const replacement = fakeEncoder(events, () => device);
  (renderer as unknown as { encoder: WebGPURenderer["encoder"] }).encoder = replacement;
  return replacement;
}
