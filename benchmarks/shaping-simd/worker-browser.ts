import { FontRegistry } from "../../src/FontRegistry";
import type { PositionedRun } from "../../src/layout/types";
import { HarfBuzzWorkerShaper, type WorkerLike } from "../../src/shaping/HarfBuzzWorkerShaper";
import { detectWasmSimdCapability, evaluateShapingSimdBenchmark } from "../../src/shaping/simd";
import type { HarfBuzzShapeInput } from "../../src/shaping/types";
import type { PackagedHarfBuzzVariant } from "./packaged-runtime";

const WARMUP_SHAPES = 25;
const MEASURED_SHAPES = 250;
const ISOLATED_RUNS = 5;

const corpora = [
  {
    id: "cjkv",
    family: "Noto Sans CJKV",
    font: "../../site/public/fonts/noto-sans-cjkv-demo.ttf",
    text: "字形測試流動地圖標籤",
    language: "zh",
    script: "Hani",
    direction: "ltr" as const,
  },
  {
    id: "arabic",
    family: "Noto Sans Arabic",
    font: "../../site/public/fonts/noto-sans-arabic-demo.ttf",
    text: "السلام عليكم تدفق النص والخريطة",
    language: "ar",
    script: "Arab",
    direction: "rtl" as const,
  },
  {
    id: "devanagari",
    family: "Noto Sans Devanagari",
    font: "../../site/public/fonts/noto-sans-devanagari-demo.ttf",
    text: "नमस्ते दुनिया पाठ प्रवाह मानचित्र",
    language: "hi",
    script: "Deva",
    direction: "ltr" as const,
  },
  {
    id: "hebrew",
    family: "Noto Sans Hebrew",
    font: "../../site/public/fonts/noto-sans-hebrew-demo.ttf",
    text: "שלום עולם זרימת טקסט ומפה",
    language: "he",
    script: "Hebr",
    direction: "rtl" as const,
  },
  {
    id: "thai",
    family: "Noto Sans Thai",
    font: "../../site/public/fonts/noto-sans-thai-demo.ttf",
    text: "สวัสดีครับ การไหลของข้อความและแผนที่",
    language: "th",
    script: "Thai",
    direction: "ltr" as const,
  },
] as const;

interface IsolatedResult {
  readonly durationMs: number;
  readonly parityRecords: readonly RunRecord[];
  readonly parityHash: string;
}

interface RunRecord {
  readonly id: string;
  readonly glyphCount: number;
  readonly direction: string;
  readonly glyphIds: readonly number[];
  readonly clusters: readonly number[];
  readonly clusterEnds: readonly number[];
  readonly x: readonly number[];
  readonly y: readonly number[];
  readonly xAdvance: readonly number[];
  readonly yAdvance: readonly number[];
  readonly bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
}

export interface ShapingSimdWorkerBrowserResult {
  readonly capability: ReturnType<typeof detectWasmSimdCapability>;
  readonly corpora: readonly string[];
  readonly workload: {
    readonly warmupShapes: number;
    readonly measuredShapes: number;
    readonly isolatedRuns: number;
    readonly execution: string;
  };
  readonly parity: {
    readonly exact: boolean;
    readonly scalarHash: string;
    readonly simdHash: string;
  };
  readonly baseline: ReturnType<typeof evaluateShapingSimdBenchmark>["baseline"];
  readonly variant: ReturnType<typeof evaluateShapingSimdBenchmark>["variant"];
  readonly workers: { readonly scalar: number; readonly simd: number };
  readonly report: ReturnType<typeof evaluateShapingSimdBenchmark>;
}

declare global {
  interface Window {
    __shapingSimdWorker?: {
      readonly done: boolean;
      readonly error?: string;
      readonly result?: ShapingSimdWorkerBrowserResult;
    };
  }
}

window.__shapingSimdWorker = { done: false };
void benchmark()
  .then((result) => {
    window.__shapingSimdWorker = { done: true, result };
  })
  .catch((error: unknown) => {
    window.__shapingSimdWorker = {
      done: true,
      error: error instanceof Error ? error.message : String(error),
    };
  });

async function benchmark(): Promise<Readonly<ShapingSimdWorkerBrowserResult>> {
  const capability = detectWasmSimdCapability();
  if (!capability.supported)
    throw new Error("Chrome must expose WebAssembly SIMD for this benchmark");
  const fontSources = await Promise.all(
    corpora.map(async (corpus) => ({
      family: corpus.family,
      bytes: await fetchBytes(corpus.font),
    })),
  );
  const scalarResults: IsolatedResult[] = [];
  const simdResults: IsolatedResult[] = [];
  for (let run = 0; run < ISOLATED_RUNS; run += 1) {
    const order: readonly PackagedHarfBuzzVariant[] =
      run % 2 === 0 ? ["scalar", "simd"] : ["simd", "scalar"];
    for (const variant of order) {
      const result = await runIsolated(variant, fontSources);
      (variant === "scalar" ? scalarResults : simdResults).push(result);
    }
  }
  const scalarParity = scalarResults[0];
  const simdParity = simdResults[0];
  if (scalarParity === undefined || simdParity === undefined) {
    throw new Error("Isolated shaping result is unavailable");
  }
  const scalarStable = scalarResults.every(
    (result) => result.parityHash === scalarParity.parityHash,
  );
  const simdStable = simdResults.every((result) => result.parityHash === simdParity.parityHash);
  const exact =
    scalarStable &&
    simdStable &&
    JSON.stringify(scalarParity.parityRecords) === JSON.stringify(simdParity.parityRecords);
  const report = evaluateShapingSimdBenchmark({
    simdSupported: capability.supported,
    baselineSamplesMs: scalarResults.map((result) => result.durationMs),
    variantSamplesMs: simdResults.map((result) => result.durationMs),
    baselineHash: scalarParity.parityHash,
    variantHash: simdParity.parityHash,
  });

  return Object.freeze({
    capability,
    corpora: Object.freeze(corpora.map((corpus) => corpus.id)),
    workload: Object.freeze({
      warmupShapes: WARMUP_SHAPES,
      measuredShapes: MEASURED_SHAPES,
      isolatedRuns: ISOLATED_RUNS,
      execution: "fresh-module-worker-per-sample-transferable-positioned-run",
    }),
    parity: Object.freeze({
      exact,
      scalarHash: scalarParity.parityHash,
      simdHash: simdParity.parityHash,
    }),
    baseline: report.baseline,
    variant: report.variant,
    workers: Object.freeze({ scalar: scalarResults.length, simd: simdResults.length }),
    report,
  });
}

async function runIsolated(
  variant: PackagedHarfBuzzVariant,
  fontSources: readonly Readonly<{ family: string; bytes: Uint8Array }>[],
): Promise<Readonly<IsolatedResult>> {
  const registry = new FontRegistry();
  for (const source of fontSources) {
    await registry.register({ family: source.family, source: source.bytes });
  }
  const shaper = new HarfBuzzWorkerShaper(registry, {
    workerFactory: () => createWorker(variant),
  });
  try {
    const parityRecords: RunRecord[] = [];
    for (let index = 0; index < corpora.length; index += 1) {
      const corpus = corpora[index];
      if (corpus === undefined) throw new Error("Parity corpus is unavailable");
      const run = await shaper.shape(index, 1, corpusInput(corpus, corpus.text));
      parityRecords.push(runRecord(corpus.id, run));
    }
    for (let index = 0; index < WARMUP_SHAPES; index += 1) {
      const corpus = corpora[index % corpora.length];
      if (corpus === undefined) throw new Error("Warmup corpus is unavailable");
      await shaper.shape(index + 10_000, 1, corpusInput(corpus, workloadText(corpus.text, index)));
    }
    const start = performance.now();
    for (let index = 0; index < MEASURED_SHAPES; index += 1) {
      const corpus = corpora[index % corpora.length];
      if (corpus === undefined) throw new Error("Measured corpus is unavailable");
      await shaper.shape(index + 20_000, 1, corpusInput(corpus, workloadText(corpus.text, index)));
    }
    const durationMs = performance.now() - start;

    return Object.freeze({
      durationMs,
      parityRecords: Object.freeze(parityRecords),
      parityHash: await sha256(new TextEncoder().encode(JSON.stringify(parityRecords))),
    });
  } finally {
    shaper.destroy();
    registry.destroy();
  }
}

function createWorker(variant: PackagedHarfBuzzVariant): WorkerLike {
  return (variant === "simd"
    ? new Worker(new URL("./worker-simd.ts", import.meta.url), {
        type: "module",
        name: "pixi-glyphflow-harfbuzz-simd-benchmark",
      })
    : new Worker(new URL("./worker-scalar.ts", import.meta.url), {
        type: "module",
        name: "pixi-glyphflow-harfbuzz-scalar-benchmark",
      })) as unknown as WorkerLike;
}

function corpusInput(corpus: (typeof corpora)[number], text: string): Readonly<HarfBuzzShapeInput> {
  return {
    family: corpus.family,
    text,
    fontSize: 32,
    language: corpus.language,
    script: corpus.script,
    direction: corpus.direction,
    features: ["kern=1", "liga=1"],
  };
}

function workloadText(seed: string, index: number): string {
  return `${seed.repeat(12)} ${String(index)}`;
}

function runRecord(id: string, run: Readonly<PositionedRun>): Readonly<RunRecord> {
  return Object.freeze({
    id,
    glyphCount: run.glyphCount,
    direction: run.direction,
    glyphIds: Object.freeze([...run.glyphIds]),
    clusters: Object.freeze([...run.clusters]),
    clusterEnds: Object.freeze([...(run.clusterEnds ?? [])]),
    x: Object.freeze([...run.x]),
    y: Object.freeze([...run.y]),
    xAdvance: Object.freeze([...run.xAdvance]),
    yAdvance: Object.freeze([...run.yAdvance]),
    bounds: Object.freeze({ ...run.bounds }),
  });
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Font fetch failed with ${String(response.status)}`);

  return new Uint8Array(await response.arrayBuffer());
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
