import { describe, expect, test } from "bun:test";

import {
  runSymbolContinuityBenchmark,
  SYMBOL_CONTINUITY_BENCHMARK_DEFAULTS,
} from "../benchmarks/symbol-continuity";
import { SymbolContinuityIndex } from "../src/culling/SymbolContinuityIndex";

describe("SymbolContinuityIndex", () => {
  test("selects overlapping tile candidates by priority, retained identity, then order", () => {
    const index = new SymbolContinuityIndex({ fadeInMs: 0 });

    index.beginFrame(frame(0, 0, 0, 0));
    const initial = index.resolveAndPlace("road:42", "tile-a", "center", 5, 10);
    const later = index.resolveAndPlace("road:42", "tile-b", "top", 5, 20);
    expect(initial).toMatchObject({ targetCandidateKey: "tile-a", candidateSelected: true });
    expect(later).toMatchObject({ targetCandidateKey: "tile-a", candidateSelected: false });
    expect(index.endFrame()).toMatchObject({
      resolvedCandidates: 2,
      seenSymbols: 1,
      placedSymbols: 1,
      collisionLoserSymbols: 0,
    });

    index.beginFrame(frame(1, 1, 1, 16));
    const earlierOrder = index.resolve("road:42", "tile-b", "top", 5, 0);
    const retained = index.resolve("road:42", "tile-a", "center", 5, 100);
    expect(earlierOrder.targetCandidateKey).toBe("tile-b");
    expect(retained).toMatchObject({
      continuityId: initial.continuityId,
      targetCandidateKey: "tile-a",
      targetAnchor: "center",
      priority: 5,
      insertionOrder: 100,
      candidateSelected: true,
    });
    index.place(retained.continuityId);
    index.endFrame();

    index.beginFrame(frame(2, 2, 2, 32));
    index.resolve("road:42", "tile-a", "center", 5, 0);
    const priorityWinner = index.resolve("road:42", "tile-b", "top", 6, 999);
    expect(priorityWinner).toMatchObject({
      targetCandidateKey: "tile-b",
      targetAnchor: "top",
      priority: 6,
    });
    index.place(priorityWinner.continuityId);
    index.endFrame();

    index.beginFrame(frame(3, 3, 3, 48));
    index.resolve("road:42", "tile-c", "left", 6, 20);
    const orderWinner = index.resolve("road:42", "tile-d", "right", 6, 10);
    expect(orderWinner).toMatchObject({
      targetCandidateKey: "tile-d",
      targetAnchor: "right",
      insertionOrder: 10,
    });
    index.place(orderWinner.continuityId);
    index.endFrame();

    index.beginFrame(frame(4, 4, 4, 64));
    index.resolve("road:42", "tile-d", "left", 6, 0);
    const retainedAnchor = index.resolve("road:42", "tile-d", "right", 6, 100);
    expect(retainedAnchor).toMatchObject({
      targetCandidateKey: "tile-d",
      targetAnchor: "right",
      insertionOrder: 100,
    });
    index.place(retainedAnchor.continuityId);
    index.endFrame();
    expect(index.read(initial.continuityId)).toMatchObject({
      retainedCandidateKey: "tile-d",
      anchor: "right",
      priority: 6,
      insertionOrder: 100,
    });
  });

  test("binds candidate admission to the final target and keeps logical admission explicit", () => {
    const index = new SymbolContinuityIndex({ fadeInMs: 0 });

    index.beginFrame(frame(0, 0, 0, 0));

    const winnerAdmitted = index.resolveAndPlace("winner-admitted", "high", "center", 10, 0);
    index.resolve("winner-admitted", "low", "left", 1, 1);

    const loserAdmitted = index.resolve("loser-admitted", "high", "center", 10, 0);
    index.resolveAndPlace("loser-admitted", "low", "left", 1, 1);

    const replacedWinner = index.resolveAndPlace("replaced-winner", "medium", "center", 5, 0);
    index.resolve("replaced-winner", "higher", "right", 10, 1);

    const sameCandidate = index.resolve("same-candidate", "tile", "center", 5, 0);
    index.resolveAndPlace("same-candidate", "tile", "center", 5, 0);
    index.resolveAndPlace("same-candidate", "tile", "center", 5, 0);

    const logicalAdmission = index.resolve("logical-admission", "low", "left", 1, 0);
    index.place(logicalAdmission.continuityId);
    index.resolve("logical-admission", "high", "right", 10, 1);
    index.place(logicalAdmission.continuityId);

    const anchorLoserAdmitted = index.resolve(
      "anchor-loser-admitted",
      "shared-tile",
      "center",
      10,
      0,
    );
    index.resolveAndPlace("anchor-loser-admitted", "shared-tile", "left", 1, 1);

    const admittedAnchorReplaced = index.resolveAndPlace(
      "admitted-anchor-replaced",
      "shared-tile",
      "center",
      5,
      0,
    );
    index.resolve("admitted-anchor-replaced", "shared-tile", "right", 10, 1);

    const admittedAnchorReplacement = index.resolve(
      "admitted-anchor-replacement",
      "shared-tile",
      "center",
      5,
      0,
    );
    index.resolveAndPlace("admitted-anchor-replacement", "shared-tile", "right", 10, 1);

    expect(index.endFrame()).toMatchObject({
      resolvedCandidates: 17,
      seenSymbols: 8,
      placedSymbols: 4,
      collisionLoserSymbols: 4,
    });
    expect(index.read(winnerAdmitted.continuityId)).toMatchObject({
      phase: "visible",
      retainedCandidateKey: "high",
    });
    expect(index.read(loserAdmitted.continuityId)).toMatchObject({
      phase: "exiting",
      retainedCandidateKey: "high",
    });
    expect(index.read(replacedWinner.continuityId)).toMatchObject({
      phase: "exiting",
      retainedCandidateKey: "higher",
    });
    expect(index.read(sameCandidate.continuityId)).toMatchObject({
      phase: "visible",
      retainedCandidateKey: "tile",
    });
    expect(index.read(logicalAdmission.continuityId)).toMatchObject({
      phase: "visible",
      retainedCandidateKey: "high",
    });
    expect(index.read(anchorLoserAdmitted.continuityId)).toMatchObject({
      phase: "exiting",
      anchor: "center",
      retainedCandidateKey: "shared-tile",
    });
    expect(index.read(admittedAnchorReplaced.continuityId)).toMatchObject({
      phase: "exiting",
      anchor: "right",
      retainedCandidateKey: "shared-tile",
    });
    expect(index.read(admittedAnchorReplacement.continuityId)).toMatchObject({
      phase: "visible",
      anchor: "right",
      retainedCandidateKey: "shared-tile",
    });
  });

  test("separates source presence from collision placement and preserves loser history", () => {
    const index = new SymbolContinuityIndex({
      fadeInMs: 100,
      fadeOutMs: 200,
      retentionMs: 100,
    });

    index.beginFrame(frame(0, 0, 0, 0));
    const first = index.resolve("station", "tile-a", "center", 8, 0);
    index.place(first.continuityId);
    index.endFrame();

    index.beginFrame(frame(0, 1, 0, 100));
    index.resolve("station", "tile-a", "center", 8, 0);
    index.place(first.continuityId);
    index.endFrame();
    expect(index.read(first.continuityId)).toMatchObject({ phase: "visible", opacity: 1 });

    index.beginFrame(frame(0, 2, 0, 150));
    index.resolve("station", "tile-b", "top", 8, 1);
    const firstLoser = index.endFrame();
    expect(firstLoser).toMatchObject({
      seenSymbols: 1,
      placedSymbols: 0,
      collisionLoserSymbols: 1,
    });
    expect(index.read(first.continuityId)).toMatchObject({
      phase: "exiting",
      opacity: 1,
      anchor: "top",
      retainedCandidateKey: "tile-b",
      sourceRetireAfterMs: Number.POSITIVE_INFINITY,
    });

    index.beginFrame(frame(0, 3, 0, 250));
    const committedBeforeRead = index.read(first.continuityId);
    const statsBeforeRead = index.stats;
    expect(index.read(first.continuityId)).toEqual(committedBeforeRead);
    expect(index.stats).toEqual(statsBeforeRead);
    index.resolve("station", "tile-c", "left", 8, 2);
    index.endFrame();
    expect(index.read(first.continuityId)?.opacity).toBeCloseTo(0.5, 8);

    index.beginFrame(frame(0, 4, 0, 1_000));
    const longLivedLoser = index.resolve("station", "tile-c", "left", 8, 2);
    expect(longLivedLoser.continuityId).toBe(first.continuityId);
    index.endFrame();
    expect(index.read(first.continuityId)).toMatchObject({
      phase: "exiting",
      opacity: 0,
      anchor: "left",
      sourceRetireAfterMs: Number.POSITIVE_INFINITY,
    });

    index.beginFrame(frame(0, 5, 0, 1_010));
    const readmitted = index.resolve("station", "tile-c", "left", 8, 2);
    index.place(readmitted.continuityId);
    index.endFrame();
    expect(index.read(first.continuityId)).toMatchObject({ phase: "entering", opacity: 0 });

    index.beginFrame(frame(0, 6, 0, 1_060));
    index.resolve("station", "tile-c", "left", 8, 2);
    index.place(first.continuityId);
    index.endFrame();
    expect(index.read(first.continuityId)?.opacity).toBeCloseTo(0.5, 8);

    index.beginFrame(frame(0, 7, 0, 1_100));
    index.endFrame();
    expect(index.read(first.continuityId)?.sourceRetireAfterMs).toBe(1_200);

    index.beginFrame(frame(0, 8, 0, 1_300));
    const retired = index.endFrame();
    expect(retired).toMatchObject({ retiredThisFrame: 1, liveSymbols: 0 });
    expect(index.read(first.continuityId)).toMatchObject({ phase: "retired", opacity: 0 });
  });

  test("rolls back staged candidates, ids, reclaimed slots, counters, and retry identity", () => {
    const index = new SymbolContinuityIndex({
      initialCapacity: 2,
      maxTrackedSymbols: 2,
      fadeInMs: 0,
      fadeOutMs: 0,
      retentionMs: 0,
    });

    index.beginFrame(frame(0, 0, 0, 0));
    const stable = index.resolveAndPlace("stable", "tile-a", "center", 2, 0);
    index.endFrame();
    const committedState = index.read(stable.continuityId);
    const committedStats = index.stats;

    const retryFrame = frame(1, 1, 1, 16);
    index.beginFrame(retryFrame);
    index.resolve("stable", "tile-b", "top", 7, 1);
    const provisional = index.resolve("new", "tile-new", "left", 3, 2);
    expect(index.read(provisional.continuityId)).toBeUndefined();
    expect(() => index.resolve("bad", "candidate", "", 1, 3)).toThrow("anchor string");
    expect(() => index.endFrame()).toThrow("requires abortFrame recovery");
    expect(index.read(stable.continuityId)).toEqual(committedState);
    index.abortFrame();

    expect(index.read(stable.continuityId)).toEqual(committedState);
    expect(index.read(provisional.continuityId)).toBeUndefined();
    expect(index.stats).toMatchObject({
      trackedSymbols: committedStats.trackedSymbols,
      liveSymbols: committedStats.liveSymbols,
      resolvedCandidatesTotal: committedStats.resolvedCandidatesTotal,
      abortedFrames: 1,
    });

    index.beginFrame(retryFrame);
    const retried = index.resolveAndPlace("new", "tile-new", "left", 3, 2);
    expect(retried.continuityId).toBe(provisional.continuityId);
    index.endFrame();

    index.beginFrame(frame(2, 2, 2, 32));
    index.endFrame();
    expect(index.read(stable.continuityId)?.phase).toBe("retired");
    const retiredState = index.read(stable.continuityId);

    index.beginFrame(frame(3, 3, 3, 48));
    const reclaimed = index.resolve("replacement", "tile-r", "right", 4, 3);
    expect(index.read(reclaimed.continuityId)).toBeUndefined();
    expect(index.read(stable.continuityId)).toEqual(retiredState);
    index.abortFrame();
    expect(index.read(reclaimed.continuityId)).toBeUndefined();
    expect(index.read(stable.continuityId)).toEqual(retiredState);
    index.abortFrame();

    index.beginFrame(frame(3, 3, 3, 48));
    const committedReplacement = index.resolveAndPlace("replacement", "tile-r", "right", 4, 3);
    expect(committedReplacement.continuityId).toBe(reclaimed.continuityId);
    expect(committedReplacement.continuityId).not.toBe(stable.continuityId);
    index.endFrame();
    expect(index.read(stable.continuityId)).toBeUndefined();
    expect(index.read(committedReplacement.continuityId)).toMatchObject({
      phase: "visible",
      anchor: "right",
      retainedCandidateKey: "tile-r",
    });
  });

  test("recovers from capacity errors through abortFrame", () => {
    const index = new SymbolContinuityIndex({ maxTrackedSymbols: 1, initialCapacity: 1 });
    index.beginFrame(frame(0, 0, 0, 0));
    const resident = index.resolveAndPlace("resident", "tile", "center", 1, 0);
    index.endFrame();

    const failedFrame = frame(1, 1, 1, 16);
    index.beginFrame(failedFrame);
    expect(() => index.resolve("overflow", "tile", "center", 1, 1)).toThrow("capacity reached 1");
    expect(() => index.resolve("resident", "tile", "center", 1, 0)).toThrow(
      "requires abortFrame recovery",
    );
    index.abortFrame();

    index.beginFrame(failedFrame);
    const recovered = index.resolveAndPlace("resident", "tile", "center", 1, 0);
    expect(recovered.continuityId).toBe(resident.continuityId);
    index.endFrame();
    expect(index.stats).toMatchObject({ capacityErrors: 1, abortedFrames: 1 });
  });

  test("hashes typed keys, signed values, f32 priority, revisions, anchor, phase, and deadline", () => {
    const base = hashPlaced({ key: -7, candidate: -11, anchor: -3, priority: 1.25 });
    expect(base).toBe(1_560_529_644);
    expect(hashPlaced({ key: "-7", candidate: -11, anchor: -3, priority: 1.25 })).not.toBe(base);
    expect(hashPlaced({ key: 7, candidate: -11, anchor: -3, priority: 1.25 })).not.toBe(base);
    expect(hashPlaced({ key: -7, candidate: "-11", anchor: -3, priority: 1.25 })).not.toBe(base);
    expect(hashPlaced({ key: -7, candidate: -11, anchor: 3, priority: 1.25 })).not.toBe(base);
    expect(hashPlaced({ key: -7, candidate: -11, anchor: -3, priority: 1.5 })).not.toBe(base);
    expect(
      hashPlaced({ key: -7, candidate: -11, anchor: -3, priority: 1.25, sceneRevision: 2 }),
    ).not.toBe(base);
    expect(hashCollisionLoser()).not.toBe(
      hashPlaced({
        key: "phase",
        candidate: "candidate",
        anchor: "center",
        priority: 1,
      }),
    );
    expect(hashAbsentDeadline(100)).not.toBe(hashAbsentDeadline(200));
    expect(hashRetired("retired-a")).not.toBe(hashRetired("retired-b"));
  });

  test("supports manual committed checkpoints and every-frame diagnostics", () => {
    const manual = new SymbolContinuityIndex({ fadeInMs: 0 });
    manual.beginFrame(frame(1, 2, 3, 10));
    manual.resolveAndPlace(-7, -11, -3, 1.25, 4);
    expect(() => manual.computeStateHash()).toThrow("inactive committed state");
    expect(manual.endFrame().stateHash).toBeUndefined();
    const manualHash = manual.computeStateHash();
    expect(manualHash).toBe(1_560_529_644);

    const everyFrame = new SymbolContinuityIndex({
      fadeInMs: 0,
      stateHashMode: "every-frame",
    });
    everyFrame.beginFrame(frame(1, 2, 3, 10));
    everyFrame.resolveAndPlace(-7, -11, -3, 1.25, 4);
    expect(everyFrame.endFrame().stateHash).toBe(manualHash);
    expect(everyFrame.computeStateHash()).toBe(manualHash);
  });

  test("enforces capacity planning, f32 values, u32 exhaustion, and frame invariants", () => {
    expect(() => new SymbolContinuityIndex({ stateHashMode: "invalid" as never })).toThrow(
      "stateHashMode must be manual or every-frame",
    );
    expect(() => new SymbolContinuityIndex({ initialCapacity: 3, maxTrackedSymbols: 2 })).toThrow(
      "initialCapacity must fit",
    );
    expect(() => new SymbolContinuityIndex({ maxTrackedSymbols: 1_048_577 })).toThrow(
      "implementation limit of 1048576",
    );
    const index = new SymbolContinuityIndex({ initialCapacity: 1, maxTrackedSymbols: 3 });
    index.reserve(3);
    expect(index.stats).toMatchObject({ capacity: 3, maxTrackedSymbols: 3 });
    expect(() => index.reserve(4)).toThrow("reserve exceeds 3");
    expect(() => index.resolve("x", "c", "a", 1, 0)).toThrow("transaction is inactive");
    expect(() => index.beginFrame(frame(-1, 0, 0, 0))).toThrow("sceneRevision");

    index.beginFrame(frame(1, 2, 3, 10));
    expect(() => index.reserve(1)).toThrow("inactive frame transaction");
    expect(() => index.beginFrame(frame(2, 2, 3, 11))).toThrow("already active");
    const rounded = index.resolveAndPlace("x", "c", "a", 1 / 3, 0);
    expect(rounded.priority).toBe(Math.fround(1 / 3));
    index.endFrame();
    expect(() => index.beginFrame(frame(1, 2, 3, 10))).toThrow("identity must advance");
    expect(() => index.beginFrame(frame(0, 3, 3, 11))).toThrow("must be monotonic");

    const exhaustion = new SymbolContinuityIndex({
      initialCapacity: 2,
      maxTrackedSymbols: 2,
      initialContinuityId: 0xffff_ffff,
    });
    exhaustion.beginFrame(frame(0, 0, 0, 0));
    expect(exhaustion.resolve("one", "c1", "a", 1, 0).continuityId).toBe(0xffff_ffff);
    expect(() => exhaustion.resolve("two", "c2", "a", 1, 1)).toThrow("id space is exhausted");
    exhaustion.abortFrame();
    expect(exhaustion.stats).toMatchObject({ trackedSymbols: 0, liveSymbols: 0, abortedFrames: 1 });

    index.destroy();
    expect(() => index.read(rounded.continuityId)).toThrow("has been destroyed");
  });

  test("runs a deterministic 100k-default sampled overlap benchmark", () => {
    expect(SYMBOL_CONTINUITY_BENCHMARK_DEFAULTS).toEqual({
      symbolCount: 100_000,
      warmupFrames: 5,
      sampleFrames: 20,
    });
    const first = runSymbolContinuityBenchmark({ symbolCount: 512 });
    const second = runSymbolContinuityBenchmark({ symbolCount: 512 });

    expect(first).toMatchObject({
      workload: "symbol-continuity-tile-overlap-handoff",
      configuration: {
        symbolCount: 512,
        warmupFrames: 5,
        sampleFrames: 20,
        overlapStride: 8,
        priorityWinStride: 32,
        collisionLoserStride: 16,
      },
      modes: {
        manual: {
          stateHashMode: "manual",
          counters: {
            seenSymbols: 10_240,
            stableContinuityIds: 10_240,
            abortFixtureRecovered: true,
            liveSymbols: 512,
            trackedSymbols: 512,
          },
        },
        everyFrame: {
          stateHashMode: "every-frame",
          counters: {
            seenSymbols: 10_240,
            stableContinuityIds: 10_240,
            abortFixtureRecovered: true,
            liveSymbols: 512,
            trackedSymbols: 512,
          },
        },
      },
      countersMatch: true,
    });
    const manual = first.modes.manual;
    const everyFrame = first.modes.everyFrame;
    expect(manual.counters.resolvedCandidates).toBeGreaterThan(manual.counters.seenSymbols);
    expect(manual.counters.collisionLoserSymbols).toBeGreaterThan(0);
    expect(manual.counters.retainedCandidateWins).toBeGreaterThan(0);
    expect(manual.counters.priorityWins).toBeGreaterThan(0);
    expect(manual.counters.sampledStateHash).toBeNull();
    expect(everyFrame.counters.sampledStateHash).toBe(3_248_079_073);
    expect(manual.counters.stateHash).toBe(2_672_908_799);
    expect(manual.counters.stateHash).toBe(everyFrame.counters.stateHash);
    expect(manual.counters.stateHash).toBe(second.modes.manual.counters.stateHash);
    expect(everyFrame.counters.sampledStateHash).toBe(
      second.modes.everyFrame.counters.sampledStateHash,
    );
    expect(manual.timings.growthMs).toBeGreaterThanOrEqual(0);
    expect(manual.timings.checkpointHashMs).toBeGreaterThanOrEqual(0);
    expect(manual.timings.frameMs.p95).toBeGreaterThanOrEqual(manual.timings.frameMs.p50);
    expect(everyFrame.timings.endFrameMs.p95).toBeGreaterThanOrEqual(
      everyFrame.timings.endFrameMs.p50,
    );
  });
});

interface HashPlacedOptions {
  readonly key: string | number;
  readonly candidate: string | number;
  readonly anchor: string | number;
  readonly priority: number;
  readonly sceneRevision?: number;
}

function hashPlaced(options: HashPlacedOptions): number {
  const index = new SymbolContinuityIndex({ fadeInMs: 0, stateHashMode: "every-frame" });
  index.beginFrame(frame(options.sceneRevision ?? 1, 2, 3, 10));
  index.resolveAndPlace(options.key, options.candidate, options.anchor, options.priority, 4);
  return requireFrameHash(index.endFrame().stateHash);
}

function hashCollisionLoser(): number {
  const index = new SymbolContinuityIndex({ fadeInMs: 0, stateHashMode: "every-frame" });
  index.beginFrame(frame(1, 2, 3, 10));
  index.resolve("phase", "candidate", "center", 1, 4);
  return requireFrameHash(index.endFrame().stateHash);
}

function hashAbsentDeadline(retentionMs: number): number {
  const index = new SymbolContinuityIndex({
    fadeInMs: 0,
    fadeOutMs: 100,
    retentionMs,
    stateHashMode: "every-frame",
  });
  index.beginFrame(frame(0, 0, 0, 0));
  const first = index.resolveAndPlace("deadline", "candidate", "center", 1, 0);
  index.endFrame();
  index.beginFrame(frame(0, 0, 0, 10));
  const absent = index.endFrame();
  expect(index.read(first.continuityId)?.sourceRetireAfterMs).toBe(10 + retentionMs);
  return requireFrameHash(absent.stateHash);
}

function hashRetired(key: string): number {
  const index = new SymbolContinuityIndex({
    fadeInMs: 0,
    fadeOutMs: 0,
    retentionMs: 0,
    stateHashMode: "every-frame",
  });
  index.beginFrame(frame(0, 0, 0, 0));
  index.resolveAndPlace(key, "candidate", "center", 1, 0);
  index.endFrame();
  index.beginFrame(frame(1, 1, 1, 1));
  const retired = index.endFrame();
  expect(retired.retiredThisFrame).toBe(1);
  return requireFrameHash(retired.stateHash);
}

function requireFrameHash(hash: number | undefined): number {
  if (hash === undefined) throw new Error("Expected every-frame state hash");
  return hash;
}

function frame(
  sceneRevision: number,
  cameraRevision: number,
  zoomRevision: number,
  timeMs: number,
) {
  return { sceneRevision, cameraRevision, zoomRevision, timeMs };
}
