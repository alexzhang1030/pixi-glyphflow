export type TransportBenchmarkDecisionReason =
  | "shape-hash-mismatch"
  | "glyph-view-copied"
  | "cluster-end-view-copied"
  | "improvement-within-variance";

export interface TransportBenchmarkInput {
  readonly structuredCloneSamplesMs: readonly number[];
  readonly sabSamplesMs: readonly number[];
  readonly hashesMatch: boolean;
  readonly zeroCopyView: boolean;
  readonly clusterEndsZeroCopyView: boolean;
}

export interface TransportBenchmarkMeasurement {
  readonly meanMs: number;
  readonly standardDeviationMs: number;
  readonly samplesMs: readonly number[];
}

export interface TransportBenchmarkDecision {
  readonly status: "advance" | "pause";
  readonly reasons: readonly TransportBenchmarkDecisionReason[];
  readonly structuredClone: Readonly<TransportBenchmarkMeasurement>;
  readonly sabRing: Readonly<TransportBenchmarkMeasurement>;
  readonly improvementMs: number;
  readonly improvementRatio: number;
  readonly varianceThresholdMs: number;
}

export function evaluateTransportBenchmark(
  input: Readonly<TransportBenchmarkInput>,
): Readonly<TransportBenchmarkDecision> {
  const structuredClone = summarize("structuredCloneSamplesMs", input.structuredCloneSamplesMs);
  const sabRing = summarize("sabSamplesMs", input.sabSamplesMs);
  const improvementMs = structuredClone.meanMs - sabRing.meanMs;
  const improvementRatio =
    structuredClone.meanMs === 0 ? 0 : improvementMs / structuredClone.meanMs;
  const varianceThresholdMs = Math.hypot(
    structuredClone.standardDeviationMs,
    sabRing.standardDeviationMs,
  );
  const reasons: TransportBenchmarkDecisionReason[] = [];
  if (!input.hashesMatch) reasons.push("shape-hash-mismatch");
  if (!input.zeroCopyView) reasons.push("glyph-view-copied");
  if (!input.clusterEndsZeroCopyView) reasons.push("cluster-end-view-copied");
  if (improvementMs <= varianceThresholdMs) reasons.push("improvement-within-variance");

  return Object.freeze({
    status: reasons.length === 0 ? "advance" : "pause",
    reasons: Object.freeze(reasons),
    structuredClone,
    sabRing,
    improvementMs,
    improvementRatio,
    varianceThresholdMs,
  });
}

function summarize(
  name: string,
  samples: readonly number[],
): Readonly<TransportBenchmarkMeasurement> {
  if (samples.length < 2 || samples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    throw new TypeError(`${name} must contain at least two finite non-negative samples`);
  }
  const meanMs = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
  const varianceMs2 =
    samples.reduce((sum, sample) => sum + (sample - meanMs) ** 2, 0) / (samples.length - 1);
  return Object.freeze({
    meanMs,
    standardDeviationMs: Math.sqrt(varianceMs2),
    samplesMs: Object.freeze([...samples]),
  });
}
