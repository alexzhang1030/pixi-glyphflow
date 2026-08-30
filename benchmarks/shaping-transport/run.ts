import {
  SabShapeTransport,
  detectSabShapeTransportCapability,
  type ShapeResultResponse,
} from "../../src/worker/SabShapeTransport";
import { benchmarkRuntime } from "../runtime";
import { hashShapeResult } from "../shaping-simd/hash";
import { evaluateTransportBenchmark } from "./evaluate";

const GLYPH_COUNT = 4_096;
const WARMUP_ITERATIONS = 256;
const SAMPLE_COUNT = 30;
const ITERATIONS_PER_SAMPLE = 2_048;
const NUMERIC_COLUMN_COUNT = 8;
const SLOT_PAYLOAD_BYTES = 160 * 1024;

const fixture = createFixture(GLYPH_COUNT);
const producer = SabShapeTransport.create({ slotCount: 2, slotPayloadBytes: SLOT_PAYLOAD_BYTES });
const consumer = SabShapeTransport.attach(producer.buffer);
let sink = 0;

for (let iteration = 0; iteration < WARMUP_ITERATIONS; iteration += 1) {
  runStructuredClone();
  runSab();
}

const structuredCloneSamplesMs: number[] = [];
const sabSamplesMs: number[] = [];
for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
  if (sample % 2 === 0) {
    structuredCloneSamplesMs.push(measure(runStructuredClone));
    sabSamplesMs.push(measure(runSab));
  } else {
    sabSamplesMs.push(measure(runSab));
    structuredCloneSamplesMs.push(measure(runStructuredClone));
  }
}

producer.tryWrite(fixture);
const lease = consumer.tryRead();
if (lease === undefined) throw new Error("SAB transport did not publish the verification result");
const structuredCloneHash = hashShapeResult(structuredClone(fixture));
const sabHash = hashShapeResult(lease.result);
const zeroCopyView = lease.result.run.glyphIds.buffer === producer.buffer;
const clusterEndsZeroCopyView = lease.result.run.clusterEnds?.buffer === producer.buffer;
const evaluation = evaluateTransportBenchmark({
  structuredCloneSamplesMs,
  sabSamplesMs,
  hashesMatch: structuredCloneHash === sabHash,
  zeroCopyView,
  clusterEndsZeroCopyView,
});
lease.release();
producer.destroy();

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      benchmark: "shape-result-transport",
      capturedAt: new Date().toISOString(),
      runtime: benchmarkRuntime(),
      capability: detectSabShapeTransportCapability({
        SharedArrayBuffer,
        Atomics,
        crossOriginIsolated: true,
      }),
      workload: {
        glyphCount: GLYPH_COUNT,
        numericPayloadBytes: GLYPH_COUNT * NUMERIC_COLUMN_COUNT * Uint32Array.BYTES_PER_ELEMENT,
        slotPayloadBytes: SLOT_PAYLOAD_BYTES,
        warmupIterations: WARMUP_ITERATIONS,
        sampleCount: SAMPLE_COUNT,
        iterationsPerSample: ITERATIONS_PER_SAMPLE,
      },
      structuredClone: evaluation.structuredClone,
      sabRing: evaluation.sabRing,
      invariants: {
        structuredCloneHash,
        sabHash,
        hashesMatch: structuredCloneHash === sabHash,
        zeroCopyView,
        clusterEndsZeroCopyView,
        sink,
      },
      measurementDecision: {
        status: evaluation.status,
        reasons: evaluation.reasons,
        improvementMs: evaluation.improvementMs,
        improvementRatio: evaluation.improvementRatio,
        varianceThresholdMs: evaluation.varianceThresholdMs,
      },
    },
    undefined,
    2,
  ),
);

function runStructuredClone(): void {
  const cloned = structuredClone(fixture);
  sink ^= cloned.run.glyphIds[cloned.run.glyphCount - 1] ?? 0;
}

function runSab(): void {
  if (!producer.tryWrite(fixture)) throw new Error("SAB transport hit unexpected backpressure");
  const current = consumer.tryRead();
  if (current === undefined) throw new Error("SAB transport did not expose a published result");
  sink ^= current.result.run.glyphIds[current.result.run.glyphCount - 1] ?? 0;
  current.release();
}

function measure(operation: () => void): number {
  const start = performance.now();
  for (let iteration = 0; iteration < ITERATIONS_PER_SAMPLE; iteration += 1) operation();
  return performance.now() - start;
}

function createFixture(glyphCount: number): Readonly<ShapeResultResponse> {
  return {
    type: "shape-result",
    requestId: 1,
    labelId: 1,
    sourceRevision: 1,
    fontRevision: 1,
    run: {
      source: "harfbuzz",
      text: "سلام multilingual shaping transport",
      fontFamily: "TransportFixture",
      fontRevision: 1,
      glyphCount,
      direction: "rtl",
      glyphIds: Uint32Array.from({ length: glyphCount }, (_, index) => index + 1),
      clusters: Uint32Array.from({ length: glyphCount }, (_, index) => index % 31),
      clusterEnds: Uint32Array.from({ length: glyphCount }, (_, index) => (index % 31) + 1),
      x: Float32Array.from({ length: glyphCount }, (_, index) => index * 8.25),
      y: new Float32Array(glyphCount),
      xAdvance: new Float32Array(glyphCount).fill(8.25),
      yAdvance: new Float32Array(glyphCount),
      lineIndices: new Uint32Array(glyphCount),
      variationKey: "wdth=92,wght=625",
      bounds: { x: 0.1, y: -2.2, width: glyphCount * 8.25, height: 16.4 },
    },
  };
}
