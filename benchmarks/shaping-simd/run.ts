import { benchmarkShapingVariants, detectWasmSimdCapability } from "../../src/shaping/simd";
import { benchmarkRuntime } from "../runtime";
import { createShapingWasmFixture } from "./wasm-fixture";

const FIXTURE = "multilingual-glyph-id-offset-v1";
const CORPUS_CODE_POINTS = 16_384;
const WARMUP_ITERATIONS = 256;
const SAMPLE_COUNT = 30;
const ITERATIONS_PER_SAMPLE = 4_096;

const capability = detectWasmSimdCapability();
const corpus = createCorpus(CORPUS_CODE_POINTS);
const baseline = createShapingWasmFixture({ corpus, simd: false });
const variant = createShapingWasmFixture({ corpus, simd: capability.supported });
const report = await benchmarkShapingVariants({
  simdSupported: capability.supported,
  baseline,
  variant,
  warmupIterations: WARMUP_ITERATIONS,
  sampleCount: SAMPLE_COUNT,
  iterationsPerSample: ITERATIONS_PER_SAMPLE,
});

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      fixture: FIXTURE,
      capturedAt: new Date().toISOString(),
      runtime: benchmarkRuntime(),
      capability,
      corpusCodePoints: corpus.length,
      baselineKind: baseline.kind,
      variantKind: variant.kind,
      warmupIterations: WARMUP_ITERATIONS,
      sampleCount: SAMPLE_COUNT,
      iterationsPerSample: ITERATIONS_PER_SAMPLE,
      report,
    },
    undefined,
    2,
  ),
);

function createCorpus(length: number): Uint32Array {
  const source = Array.from(
    "office سلام नमस्ते עברית ภาษาไทย 字形 flow 12345",
    (character) => character.codePointAt(0) ?? 0,
  );
  const corpus = new Uint32Array(length);
  for (let index = 0; index < corpus.length; index += 1) {
    corpus[index] = source[index % source.length] ?? 0;
  }
  return corpus;
}
