import { describe, expect, test } from "bun:test";

import { KeyedTaskScheduler, WorkerQueueOverflowError } from "../src/worker/KeyedTaskScheduler";

describe("KeyedTaskScheduler", () => {
  test("serializes one family while independent families start in parallel", async () => {
    const scheduler = new KeyedTaskScheduler<string>({ maxQueueDepth: 4 });
    const fixtureGate = deferred<void>();
    const starts: string[] = [];

    const firstFixture = scheduler.schedule("Fixture", "fixture-1", async () => {
      starts.push("fixture-1");
      await fixtureGate.promise;
      return 1;
    });
    const secondFixture = scheduler.schedule("Fixture", "fixture-2", () => {
      starts.push("fixture-2");
      return 2;
    });
    const otherFamily = scheduler.schedule("Other", "other-1", () => {
      starts.push("other-1");
      return 3;
    });

    await eventually(() => starts.length === 2);
    expect(starts).toEqual(["fixture-1", "other-1"]);
    expect(await otherFamily).toBe(3);
    expect(scheduler.stats).toMatchObject({ depth: 2, active: 1, queued: 1 });

    fixtureGate.resolve();
    expect(await Promise.all([firstFixture, secondFixture, otherFamily])).toEqual([1, 2, 3]);
    expect(starts).toEqual(["fixture-1", "other-1", "fixture-2"]);
    expect(scheduler.stats).toMatchObject({ depth: 0, active: 0, queued: 0 });
  });

  test("bounds admitted work and reports overflow", async () => {
    const scheduler = new KeyedTaskScheduler<string>({ maxQueueDepth: 2 });
    const gate = deferred<void>();
    const first = scheduler.schedule("A", "a", () => gate.promise);
    const second = scheduler.schedule("B", "b", () => gate.promise);

    expect(() => scheduler.schedule("C", "c", () => undefined)).toThrow(WorkerQueueOverflowError);
    expect(scheduler.stats).toMatchObject({ depth: 2, peakDepth: 2, overflows: 1 });

    gate.resolve();
    await Promise.all([first, second]);
  });

  test("cancels queued work observably and drains active work", async () => {
    const scheduler = new KeyedTaskScheduler<{ readonly revision: number }>({
      maxQueueDepth: 3,
    });
    const gate = deferred<void>();
    const active = scheduler.schedule("Fixture", { revision: 0 }, () => gate.promise);
    const queued = scheduler.schedule("Fixture", { revision: 1 }, () => undefined);

    const cancelled = scheduler.cancelQueued(
      (metadata) => metadata.revision === 1,
      () => new Error("superseded"),
    );

    expect(cancelled).toBe(1);
    await expect(queued).rejects.toThrow("superseded");
    expect(scheduler.stats).toMatchObject({ depth: 1, cancellations: 1 });

    gate.resolve();
    await active;
    await scheduler.whenIdle();
    expect(scheduler.stats.depth).toBe(0);
  });

  test("updates queue accounting before a command promise settles", async () => {
    const scheduler = new KeyedTaskScheduler<string>({ maxQueueDepth: 1 });

    expect(await scheduler.schedule("Fixture", "shape", () => 42)).toBe(42);
    expect(scheduler.stats).toMatchObject({ depth: 0, active: 0, queued: 0 });
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Timed out waiting for scheduler state");
}
