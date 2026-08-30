import {
  SymbolContinuityIndex,
  type MutableSymbolContinuityMatch,
  type SymbolContinuityFrameResult,
} from "../src/culling/SymbolContinuityIndex";

export interface SymbolContinuityBenchmarkOptions {
  readonly symbolCount?: number;
  readonly warmupFrames?: number;
  readonly sampleFrames?: number;
}

export interface SymbolContinuityTimingPercentiles {
  readonly p50: number;
  readonly p95: number;
}

export interface SymbolContinuityBenchmarkTimings {
  readonly growthMs: number;
  readonly resolvePlaceMs: Readonly<SymbolContinuityTimingPercentiles>;
  readonly endFrameMs: Readonly<SymbolContinuityTimingPercentiles>;
  readonly frameMs: Readonly<SymbolContinuityTimingPercentiles>;
  /** One committed-state checkpoint outside sampled frame timings. */
  readonly checkpointHashMs: number;
}

export interface SymbolContinuityBenchmarkCounters {
  readonly resolvedCandidates: number;
  readonly seenSymbols: number;
  readonly placedSymbols: number;
  readonly collisionLoserSymbols: number;
  readonly tileOverlapCandidates: number;
  readonly stableContinuityIds: number;
  readonly retainedCandidateWins: number;
  readonly priorityWins: number;
  readonly abortFixtureRecovered: boolean;
  readonly liveSymbols: number;
  readonly trackedSymbols: number;
  readonly allocatedBytes: number;
  /** Complete hash of the final committed sampled frame. */
  readonly stateHash: number;
  /** Historical sampled-frame accumulator, available for every-frame diagnostics. */
  readonly sampledStateHash: number | null;
}

export interface SymbolContinuityBenchmarkModeResult {
  readonly stateHashMode: "manual" | "every-frame";
  readonly timings: Readonly<SymbolContinuityBenchmarkTimings>;
  readonly counters: Readonly<SymbolContinuityBenchmarkCounters>;
}

export interface SymbolContinuityBenchmarkResult {
  readonly workload: "symbol-continuity-tile-overlap-handoff";
  readonly configuration: Readonly<{
    symbolCount: number;
    warmupFrames: number;
    sampleFrames: number;
    overlapStride: 8;
    priorityWinStride: 32;
    collisionLoserStride: 16;
  }>;
  readonly modes: Readonly<{
    manual: Readonly<SymbolContinuityBenchmarkModeResult>;
    everyFrame: Readonly<SymbolContinuityBenchmarkModeResult>;
  }>;
  readonly countersMatch: boolean;
}

export const SYMBOL_CONTINUITY_BENCHMARK_DEFAULTS: Readonly<{
  symbolCount: 100_000;
  warmupFrames: 5;
  sampleFrames: 20;
}> = Object.freeze({ symbolCount: 100_000, warmupFrames: 5, sampleFrames: 20 });

const OVERLAP_STRIDE = 8;
const PRIORITY_WIN_STRIDE = 32;
const COLLISION_LOSER_STRIDE = 16;

/**
 * Reproducible 100k logical-symbol fixture with overlapping tile candidates, retained-candidate
 * ties, priority overrides, persistent collision losers, rollback recovery, and sampled tails.
 */
export function runSymbolContinuityBenchmark(
  options: SymbolContinuityBenchmarkOptions = {},
): Readonly<SymbolContinuityBenchmarkResult> {
  const symbolCount = options.symbolCount ?? SYMBOL_CONTINUITY_BENCHMARK_DEFAULTS.symbolCount;
  const warmupFrames = options.warmupFrames ?? SYMBOL_CONTINUITY_BENCHMARK_DEFAULTS.warmupFrames;
  const sampleFrames = options.sampleFrames ?? SYMBOL_CONTINUITY_BENCHMARK_DEFAULTS.sampleFrames;
  assertPositiveSafeInteger("symbolCount", symbolCount);
  if (symbolCount * 2 + 1 > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Symbol continuity benchmark symbolCount exceeds candidate key space");
  }
  if (!Number.isSafeInteger(warmupFrames) || warmupFrames < 5) {
    throw new RangeError("Symbol continuity benchmark warmupFrames must be at least 5");
  }
  if (!Number.isSafeInteger(sampleFrames) || sampleFrames < 20) {
    throw new RangeError("Symbol continuity benchmark sampleFrames must be at least 20");
  }

  const manual = runModeBenchmark("manual", symbolCount, warmupFrames, sampleFrames);
  const everyFrame = runModeBenchmark("every-frame", symbolCount, warmupFrames, sampleFrames);
  return Object.freeze({
    workload: "symbol-continuity-tile-overlap-handoff",
    configuration: Object.freeze({
      symbolCount,
      warmupFrames,
      sampleFrames,
      overlapStride: OVERLAP_STRIDE,
      priorityWinStride: PRIORITY_WIN_STRIDE,
      collisionLoserStride: COLLISION_LOSER_STRIDE,
    }),
    modes: Object.freeze({ manual, everyFrame }),
    countersMatch: modeCountersMatch(manual.counters, everyFrame.counters),
  });
}

function runModeBenchmark(
  stateHashMode: "manual" | "every-frame",
  symbolCount: number,
  warmupFrames: number,
  sampleFrames: number,
): Readonly<SymbolContinuityBenchmarkModeResult> {
  const continuity = new SymbolContinuityIndex({
    initialCapacity: Math.min(symbolCount, 1_024),
    maxTrackedSymbols: symbolCount,
    fadeInMs: 80,
    fadeOutMs: 120,
    retentionMs: 240,
    stateHashMode,
  });
  const growthStarted = performance.now();
  continuity.reserve(symbolCount);
  const growthMs = performance.now() - growthStarted;
  const continuityIds = new Uint32Array(symbolCount);
  const match = createMatchOutput();

  let frameIndex = 0;
  continuity.beginFrame(frameFor(frameIndex));
  for (let index = 0; index < symbolCount; index += 1) {
    const candidateKey = index * 2;
    if (index % COLLISION_LOSER_STRIDE === 0) {
      continuity.resolve(index, candidateKey, 0, (index & 31) + 1, index, match);
    } else {
      continuity.resolveAndPlace(index, candidateKey, 0, (index & 31) + 1, index, match);
    }
    continuityIds[index] = match.continuityId;
  }
  continuity.endFrame();

  for (let warmup = 0; warmup < warmupFrames; warmup += 1) {
    frameIndex += 1;
    runFrame(continuity, continuityIds, match, symbolCount, frameIndex);
  }

  const resolvePlaceSamples = new Float64Array(sampleFrames);
  const endFrameSamples = new Float64Array(sampleFrames);
  const frameSamples = new Float64Array(sampleFrames);
  let resolvedCandidates = 0;
  let seenSymbols = 0;
  let placedSymbols = 0;
  let collisionLoserSymbols = 0;
  let tileOverlapCandidates = 0;
  let stableContinuityIds = 0;
  let retainedCandidateWins = 0;
  let priorityWins = 0;
  let sampledStateHash = stateHashMode === "every-frame" ? 0x811c_9dc5 : null;
  let lastEveryFrameHash: number | undefined;

  for (let sample = 0; sample < sampleFrames; sample += 1) {
    frameIndex += 1;
    const measurement = runFrame(continuity, continuityIds, match, symbolCount, frameIndex);
    resolvePlaceSamples[sample] = measurement.resolvePlaceMs;
    endFrameSamples[sample] = measurement.endFrameMs;
    frameSamples[sample] = measurement.resolvePlaceMs + measurement.endFrameMs;
    resolvedCandidates += measurement.frame.resolvedCandidates;
    seenSymbols += measurement.frame.seenSymbols;
    placedSymbols += measurement.frame.placedSymbols;
    collisionLoserSymbols += measurement.frame.collisionLoserSymbols;
    tileOverlapCandidates += measurement.tileOverlapCandidates;
    stableContinuityIds += measurement.stableContinuityIds;
    retainedCandidateWins += measurement.retainedCandidateWins;
    priorityWins += measurement.priorityWins;
    if (stateHashMode === "every-frame") {
      const frameHash = measurement.frame.stateHash;
      if (frameHash === undefined || sampledStateHash === null) {
        throw new Error("Symbol continuity every-frame benchmark hash is unavailable");
      }
      lastEveryFrameHash = frameHash;
      sampledStateHash = Math.imul(sampledStateHash ^ frameHash, 0x0100_0193) >>> 0;
    } else if (measurement.frame.stateHash !== undefined) {
      throw new Error("Symbol continuity manual benchmark produced a frame hash");
    }
  }

  const abortFrame = frameFor(frameIndex + 1);
  continuity.beginFrame(abortFrame);
  let capacityRaised = false;
  try {
    continuity.resolve(symbolCount, symbolCount * 2, 0, 1, symbolCount, match);
  } catch (error) {
    capacityRaised = error instanceof RangeError;
  }
  continuity.abortFrame();
  continuity.beginFrame(abortFrame);
  const retry = continuity.resolve(0, 0, 0, 1, 0, match);
  const abortFixtureRecovered =
    capacityRaised && retry.continuityId === continuityIds[0] && continuity.stats.liveSymbols > 0;
  continuity.abortFrame();

  const checkpointStarted = performance.now();
  const stateHash = continuity.computeStateHash();
  const checkpointHashMs = performance.now() - checkpointStarted;
  if (lastEveryFrameHash !== undefined && lastEveryFrameHash !== stateHash) {
    throw new Error("Symbol continuity frame and checkpoint hashes diverged");
  }

  const stats = continuity.stats;
  const result: Readonly<SymbolContinuityBenchmarkModeResult> = Object.freeze({
    stateHashMode,
    timings: Object.freeze({
      growthMs,
      resolvePlaceMs: percentiles(resolvePlaceSamples),
      endFrameMs: percentiles(endFrameSamples),
      frameMs: percentiles(frameSamples),
      checkpointHashMs,
    }),
    counters: Object.freeze({
      resolvedCandidates,
      seenSymbols,
      placedSymbols,
      collisionLoserSymbols,
      tileOverlapCandidates,
      stableContinuityIds,
      retainedCandidateWins,
      priorityWins,
      abortFixtureRecovered,
      liveSymbols: stats.liveSymbols,
      trackedSymbols: stats.trackedSymbols,
      allocatedBytes: stats.allocatedBytes,
      stateHash,
      sampledStateHash,
    }),
  });
  continuity.destroy();
  return result;
}

interface FrameMeasurement {
  readonly resolvePlaceMs: number;
  readonly endFrameMs: number;
  readonly frame: Readonly<SymbolContinuityFrameResult>;
  readonly tileOverlapCandidates: number;
  readonly stableContinuityIds: number;
  readonly retainedCandidateWins: number;
  readonly priorityWins: number;
}

function runFrame(
  continuity: SymbolContinuityIndex,
  continuityIds: Uint32Array,
  match: MutableSymbolContinuityMatch,
  symbolCount: number,
  frameIndex: number,
): Readonly<FrameMeasurement> {
  let tileOverlapCandidates = 0;
  let stableContinuityIds = 0;
  let retainedCandidateWins = 0;
  let priorityWins = 0;
  continuity.beginFrame(frameFor(frameIndex));
  const resolveStarted = performance.now();
  for (let index = 0; index < symbolCount; index += 1) {
    const retainedCandidate = index * 2;
    const overlappingCandidate = retainedCandidate + 1;
    const priority = (index & 31) + 1;
    if (index % OVERLAP_STRIDE === 0) {
      const priorityOverride = index % PRIORITY_WIN_STRIDE === 0;
      const collisionLoser = index % COLLISION_LOSER_STRIDE === 0;
      if (priorityOverride) {
        if (collisionLoser) {
          continuity.resolve(index, overlappingCandidate, 1, priority + 1, index * 2, match);
        } else {
          continuity.resolveAndPlace(
            index,
            overlappingCandidate,
            1,
            priority + 1,
            index * 2,
            match,
          );
        }
        continuity.resolveAndPlace(index, retainedCandidate, 0, priority, index * 2 + 1, match);
      } else {
        continuity.resolveAndPlace(index, overlappingCandidate, 1, priority, index * 2, match);
        if (collisionLoser) {
          continuity.resolve(index, retainedCandidate, 0, priority, index * 2 + 1, match);
        } else {
          continuity.resolveAndPlace(index, retainedCandidate, 0, priority, index * 2 + 1, match);
        }
      }
      tileOverlapCandidates += 1;
      if (priorityOverride) {
        priorityWins += Number(match.targetCandidateKey === overlappingCandidate);
      } else {
        retainedCandidateWins += Number(match.targetCandidateKey === retainedCandidate);
      }
    } else if (index % COLLISION_LOSER_STRIDE === 0) {
      continuity.resolve(index, retainedCandidate, 0, priority, index, match);
    } else {
      continuity.resolveAndPlace(index, retainedCandidate, 0, priority, index, match);
    }
    stableContinuityIds += Number(match.continuityId === continuityIds[index]);
  }
  const resolvePlaceMs = performance.now() - resolveStarted;
  const endStarted = performance.now();
  const frame = continuity.endFrame();
  const endFrameMs = performance.now() - endStarted;
  return Object.freeze({
    resolvePlaceMs,
    endFrameMs,
    frame,
    tileOverlapCandidates,
    stableContinuityIds,
    retainedCandidateWins,
    priorityWins,
  });
}

function frameFor(frameIndex: number) {
  return {
    sceneRevision: frameIndex,
    cameraRevision: frameIndex,
    zoomRevision: Math.floor(frameIndex / 4),
    timeMs: frameIndex * 16,
  };
}

function createMatchOutput(): MutableSymbolContinuityMatch {
  return {
    continuityId: 0,
    phase: "retired",
    opacity: 0,
    targetCandidateKey: 0,
    targetAnchor: 0,
    priority: 0,
    insertionOrder: 0,
    candidateSelected: false,
    sceneRevision: 0,
    cameraRevision: 0,
    zoomRevision: 0,
  };
}

function percentiles(samples: Float64Array): Readonly<SymbolContinuityTimingPercentiles> {
  const sorted = Array.from(samples).sort((left, right) => left - right);
  const p50Index = Math.max(0, Math.ceil(sorted.length * 0.5) - 1);
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return Object.freeze({ p50: sorted[p50Index] ?? 0, p95: sorted[p95Index] ?? 0 });
}

function modeCountersMatch(
  left: Readonly<SymbolContinuityBenchmarkCounters>,
  right: Readonly<SymbolContinuityBenchmarkCounters>,
): boolean {
  return (
    left.resolvedCandidates === right.resolvedCandidates &&
    left.seenSymbols === right.seenSymbols &&
    left.placedSymbols === right.placedSymbols &&
    left.collisionLoserSymbols === right.collisionLoserSymbols &&
    left.tileOverlapCandidates === right.tileOverlapCandidates &&
    left.stableContinuityIds === right.stableContinuityIds &&
    left.retainedCandidateWins === right.retainedCandidateWins &&
    left.priorityWins === right.priorityWins &&
    left.abortFixtureRecovered === right.abortFixtureRecovered &&
    left.liveSymbols === right.liveSymbols &&
    left.trackedSymbols === right.trackedSymbols &&
    left.allocatedBytes === right.allocatedBytes &&
    left.stateHash === right.stateHash
  );
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Symbol continuity benchmark ${name} must be a positive safe integer`);
  }
}

if (import.meta.main) {
  console.log(JSON.stringify(runSymbolContinuityBenchmark(), null, 2));
}
