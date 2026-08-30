export interface WasmSimdValidationScope {
  readonly WebAssembly:
    | {
        validate(bytes: BufferSource): boolean;
      }
    | undefined;
}

export interface WasmSimdCapability {
  readonly supported: boolean;
  readonly webAssembly: boolean;
  readonly reason: "webassembly" | "simd-validation" | undefined;
}

export type ShapingSimdDecisionReason =
  | "simd-unavailable"
  | "result-mismatch"
  | "variant-regression"
  | "within-variance";

export interface ShapingVariantMeasurement {
  readonly samplesMs: readonly number[];
  readonly meanMs: number;
  readonly varianceMs2: number;
  readonly standardDeviationMs: number;
}

export interface ShapingSimdBenchmarkInput {
  readonly simdSupported: boolean;
  readonly baselineSamplesMs: readonly number[];
  readonly variantSamplesMs: readonly number[];
  readonly baselineHash: string;
  readonly variantHash: string;
  readonly varianceMultiplier?: number;
}

export interface ShapingSimdBenchmarkReport {
  readonly decision: "advance" | "hold";
  readonly reasons: readonly ShapingSimdDecisionReason[];
  readonly baseline: Readonly<ShapingVariantMeasurement>;
  readonly variant: Readonly<ShapingVariantMeasurement>;
  readonly baselineHash: string;
  readonly variantHash: string;
  readonly improvementMs: number;
  readonly improvementRatio: number;
  readonly varianceThresholdMs: number;
}

export interface ShapingBenchmarkCandidate {
  run(): void | Promise<void>;
  hash(): string | Promise<string>;
}

export interface ShapingVariantsBenchmarkOptions {
  readonly simdSupported: boolean;
  readonly baseline: ShapingBenchmarkCandidate;
  readonly variant: ShapingBenchmarkCandidate;
  readonly warmupIterations?: number;
  readonly sampleCount?: number;
  readonly iterationsPerSample?: number;
  readonly varianceMultiplier?: number;
  readonly now?: () => number;
}

// () -> v128 { i32.const 0; i8x16.splat }
const WASM_SIMD_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b, 0x03,
  0x02, 0x01, 0x00, 0x0a, 0x08, 0x01, 0x06, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x0b,
]);

export function detectWasmSimdCapability(
  scope: Readonly<WasmSimdValidationScope> = runtimeWasmScope(),
): Readonly<WasmSimdCapability> {
  if (scope.WebAssembly === undefined) {
    return Object.freeze({ supported: false, webAssembly: false, reason: "webassembly" });
  }

  try {
    const supported = scope.WebAssembly.validate(WASM_SIMD_PROBE);
    return Object.freeze({
      supported,
      webAssembly: true,
      reason: supported ? undefined : "simd-validation",
    });
  } catch {
    return Object.freeze({ supported: false, webAssembly: true, reason: "simd-validation" });
  }
}

export function evaluateShapingSimdBenchmark(
  input: Readonly<ShapingSimdBenchmarkInput>,
): Readonly<ShapingSimdBenchmarkReport> {
  const baseline = summarizeSamples("baselineSamplesMs", input.baselineSamplesMs);
  const variant = summarizeSamples("variantSamplesMs", input.variantSamplesMs);
  const varianceMultiplier = input.varianceMultiplier ?? 1;
  if (!Number.isFinite(varianceMultiplier) || varianceMultiplier < 0) {
    throw new RangeError("varianceMultiplier must be a finite non-negative number");
  }
  const improvementMs = baseline.meanMs - variant.meanMs;
  const improvementRatio = improvementMs / baseline.meanMs;
  const varianceThresholdMs =
    Math.sqrt(baseline.varianceMs2 + variant.varianceMs2) * varianceMultiplier;
  const reasons: ShapingSimdDecisionReason[] = [];
  if (!input.simdSupported) reasons.push("simd-unavailable");
  if (input.baselineHash !== input.variantHash) reasons.push("result-mismatch");
  if (improvementMs <= 0) {
    reasons.push("variant-regression");
  } else if (improvementMs <= varianceThresholdMs) {
    reasons.push("within-variance");
  }

  return Object.freeze({
    decision: reasons.length === 0 ? "advance" : "hold",
    reasons: Object.freeze(reasons),
    baseline,
    variant,
    baselineHash: input.baselineHash,
    variantHash: input.variantHash,
    improvementMs,
    improvementRatio,
    varianceThresholdMs,
  });
}

export async function benchmarkShapingVariants(
  options: Readonly<ShapingVariantsBenchmarkOptions>,
): Promise<Readonly<ShapingSimdBenchmarkReport>> {
  const warmupIterations = options.warmupIterations ?? 20;
  const sampleCount = options.sampleCount ?? 20;
  const iterationsPerSample = options.iterationsPerSample ?? 100;
  assertIterationCount("warmupIterations", warmupIterations, 0);
  assertIterationCount("sampleCount", sampleCount, 2);
  assertIterationCount("iterationsPerSample", iterationsPerSample, 1);
  const now = options.now ?? performance.now.bind(performance);

  for (let iteration = 0; iteration < warmupIterations; iteration += 1) {
    const baselineCompletion = options.baseline.run();
    if (baselineCompletion !== undefined) await baselineCompletion;
    const variantCompletion = options.variant.run();
    if (variantCompletion !== undefined) await variantCompletion;
  }

  const baselineSamples: number[] = [];
  const variantSamples: number[] = [];
  for (let sample = 0; sample < sampleCount; sample += 1) {
    if (sample % 2 === 0) {
      baselineSamples.push(await measureCandidate(options.baseline, iterationsPerSample, now));
      variantSamples.push(await measureCandidate(options.variant, iterationsPerSample, now));
    } else {
      variantSamples.push(await measureCandidate(options.variant, iterationsPerSample, now));
      baselineSamples.push(await measureCandidate(options.baseline, iterationsPerSample, now));
    }
  }

  return evaluateShapingSimdBenchmark({
    simdSupported: options.simdSupported,
    baselineSamplesMs: baselineSamples,
    variantSamplesMs: variantSamples,
    baselineHash: await options.baseline.hash(),
    variantHash: await options.variant.hash(),
    ...(options.varianceMultiplier === undefined
      ? {}
      : { varianceMultiplier: options.varianceMultiplier }),
  });
}

async function measureCandidate(
  candidate: ShapingBenchmarkCandidate,
  iterations: number,
  now: () => number,
): Promise<number> {
  const start = now();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const completion = candidate.run();
    if (completion !== undefined) await completion;
  }
  const duration = now() - start;
  if (!Number.isFinite(duration) || duration < 0) {
    throw new RangeError("Benchmark clock must produce finite monotonic durations");
  }
  return duration;
}

function summarizeSamples(
  name: string,
  samples: readonly number[],
): Readonly<ShapingVariantMeasurement> {
  if (samples.length < 2) throw new RangeError(`${name} must contain at least two samples`);
  let sum = 0;
  for (const sample of samples) {
    if (!Number.isFinite(sample) || sample <= 0) {
      throw new RangeError(`${name} must contain finite positive durations`);
    }
    sum += sample;
  }
  const meanMs = sum / samples.length;
  let squaredDeviation = 0;
  for (const sample of samples) squaredDeviation += (sample - meanMs) ** 2;
  const varianceMs2 = squaredDeviation / (samples.length - 1);

  return Object.freeze({
    samplesMs: Object.freeze([...samples]),
    meanMs,
    varianceMs2,
    standardDeviationMs: Math.sqrt(varianceMs2),
  });
}

function runtimeWasmScope(): Readonly<WasmSimdValidationScope> {
  return {
    WebAssembly:
      typeof WebAssembly === "undefined"
        ? undefined
        : {
            validate: WebAssembly.validate.bind(WebAssembly),
          },
  };
}

function assertIterationCount(name: string, value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(
      `${name} must be a safe integer greater than or equal to ${String(minimum)}`,
    );
  }
}
