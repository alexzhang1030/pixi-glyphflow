import { HbGpuDrawWorkerEncoder } from "../../src/hb-gpu";

const WARMUP_ITERATIONS = 16;
const MEASURED_ITERATIONS = 200;
const MINIMUM_WARM_GLYPHS_PER_SECOND = 10_000;
const MAXIMUM_COLD_START_MS = 100;

const scene = [
  { corpusId: "cjkv", glyphId: 130 },
  { corpusId: "arabic", glyphId: 22 },
  { corpusId: "devanagari", glyphId: 12 },
  { corpusId: "hebrew", glyphId: 10 },
  { corpusId: "thai", glyphId: 10 },
] as const;

interface NativeArtifact {
  readonly harfbuzz: { readonly version: string };
  readonly corpora: readonly {
    readonly id: string;
    readonly fontFile: string;
    readonly glyphs: readonly {
      readonly glyphId: number;
      readonly blobHex: string;
      readonly extents: GlyphExtents;
    }[];
  }[];
}

interface GlyphExtents {
  readonly xBearing: number;
  readonly yBearing: number;
  readonly width: number;
  readonly height: number;
}

interface WasmProvenance {
  readonly abiVersion: number;
  readonly harfbuzz: { readonly version: string };
  readonly toolchain: { readonly emscriptenVersion: string; readonly imageDigest: string };
  readonly output: {
    readonly sha256: string;
    readonly rawBytes: number;
    readonly gzipBytes: number;
  };
}

interface ParityRecord {
  readonly corpusId: string;
  readonly glyphId: number;
  readonly blobHex: string;
  readonly extents: GlyphExtents;
  readonly upem: number;
}

interface TimingSummary {
  readonly count: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

interface HbGpuWasmBrowserResult {
  readonly harfbuzzVersion: string;
  readonly abiVersion: number;
  readonly toolchain: WasmProvenance["toolchain"];
  readonly wasm: WasmProvenance["output"] & { readonly fetchedSha256: string };
  readonly corpusCount: number;
  readonly glyphs: readonly {
    readonly corpusId: string;
    readonly glyphId: number;
    readonly blobBytes: number;
  }[];
  readonly parity: {
    readonly mismatchCount: number;
    readonly actualHash: string;
    readonly expectedHash: string;
  };
  readonly coldEncodeMs: readonly number[];
  readonly warmEncodeMs: Readonly<TimingSummary>;
  readonly warmGlyphsPerSecond: number;
  readonly iterations: { readonly warmup: number; readonly measured: number };
  readonly resources: {
    readonly syncedFontsBeforeRelease: number;
    readonly syncedFontsAfterRelease: number;
    readonly releasedFonts: number;
  };
  readonly worker: {
    readonly starts: number;
    readonly requests: number;
    readonly encodedGlyphs: number;
  };
  readonly acceptance: {
    readonly minimumWarmGlyphsPerSecond: number;
    readonly maximumColdStartMs: number;
  };
  readonly decision: { readonly status: "go" | "pause"; readonly reasons: readonly string[] };
}

interface HbGpuWasmBrowserState {
  readonly done: boolean;
  readonly error?: string;
  readonly result?: Readonly<HbGpuWasmBrowserResult>;
}

declare global {
  interface Window {
    __hbGpuWasmBrowser: HbGpuWasmBrowserState;
  }
}

window.__hbGpuWasmBrowser = { done: false };
void benchmark()
  .then((result) => {
    window.__hbGpuWasmBrowser = { done: true, result };
  })
  .catch((error: unknown) => {
    window.__hbGpuWasmBrowser = {
      done: true,
      error: error instanceof Error ? error.message : String(error),
    };
  });

async function benchmark(): Promise<Readonly<HbGpuWasmBrowserResult>> {
  const [nativeArtifact, provenance, wasmBytes] = await Promise.all([
    fetchJson<NativeArtifact>("./results/hb-gpu-draw-native-14.4.0.json"),
    fetchJson<WasmProvenance>("../../src/hb-gpu/wasm/provenance.json"),
    fetchBytes("../../src/hb-gpu/wasm/hb-gpu-encoder.wasm").then((bytes) => bytes.buffer),
  ]);
  const wasmSha256 = await sha256(new Uint8Array(wasmBytes));
  if (wasmSha256 !== provenance.output.sha256) {
    throw new Error("Hb GPU Wasm SHA-256 differs from provenance");
  }

  const encoder = new HbGpuDrawWorkerEncoder({
    workerFactory: () =>
      new Worker(new URL("../../src/hb-gpu/worker.ts", import.meta.url), {
        type: "module",
        name: "hb-gpu-wasm-browser-benchmark",
      }),
    wasmUrl: new URL("../../src/hb-gpu/wasm/hb-gpu-encoder.wasm", import.meta.url),
  });
  const actualRecords: ParityRecord[] = [];
  const expectedRecords: ParityRecord[] = [];
  const coldEncodeMs: number[] = [];
  const requests: Array<{ readonly fontKey: string; readonly glyphId: number }> = [];
  let mismatchCount = 0;
  try {
    for (const target of scene) {
      const corpus = nativeArtifact.corpora.find((candidate) => candidate.id === target.corpusId);
      if (corpus === undefined) throw new Error(`Native corpus is unavailable: ${target.corpusId}`);
      const expected = corpus.glyphs.find((glyph) => glyph.glyphId === target.glyphId);
      if (expected === undefined) {
        throw new Error(
          `Native glyph is unavailable: ${target.corpusId}/${String(target.glyphId)}`,
        );
      }
      const fontBytes = await fetchBytes(`../../${corpus.fontFile}`);
      const fontKey = `${corpus.id}\u00001`;
      const start = performance.now();
      const actual = await encoder.encode({ fontKey, fontBytes, glyphId: target.glyphId });
      coldEncodeMs.push(performance.now() - start);
      const actualRecord: ParityRecord = {
        corpusId: corpus.id,
        glyphId: target.glyphId,
        blobHex: toHex(actual.packedCurveBlob),
        extents: actual.extents,
        upem: actual.upem,
      };
      const expectedRecord: ParityRecord = {
        corpusId: corpus.id,
        glyphId: target.glyphId,
        blobHex: expected.blobHex,
        extents: expected.extents,
        upem: 1_000,
      };
      if (JSON.stringify(actualRecord) !== JSON.stringify(expectedRecord)) mismatchCount += 1;
      actualRecords.push(actualRecord);
      expectedRecords.push(expectedRecord);
      requests.push({ fontKey, glyphId: target.glyphId });
    }

    for (let iteration = 0; iteration < WARMUP_ITERATIONS; iteration += 1) {
      const request = requests[iteration % requests.length];
      if (request === undefined) throw new Error("Warmup request is unavailable");
      await encoder.encode(request);
    }
    const warmEncodeMs: number[] = [];
    for (let iteration = 0; iteration < MEASURED_ITERATIONS; iteration += 1) {
      const request = requests[iteration % requests.length];
      if (request === undefined) throw new Error("Measured request is unavailable");
      const start = performance.now();
      await encoder.encode(request);
      warmEncodeMs.push(performance.now() - start);
    }

    const statsBeforeRelease = encoder.stats;
    const releasedFonts: boolean[] = [];
    for (const request of requests) releasedFonts.push(await encoder.releaseFont(request.fontKey));
    const statsAfterRelease = encoder.stats;
    const warm = summarize(warmEncodeMs);
    const warmGlyphsPerSecond = 1_000 / warm.mean;
    const actualHash = await sha256(new TextEncoder().encode(JSON.stringify(actualRecords)));
    const expectedHash = await sha256(new TextEncoder().encode(JSON.stringify(expectedRecords)));
    const decisionReasons: string[] = [];
    if (mismatchCount !== 0 || actualHash !== expectedHash) decisionReasons.push("native-parity");
    if (warmGlyphsPerSecond < MINIMUM_WARM_GLYPHS_PER_SECOND) {
      decisionReasons.push("warm-throughput");
    }
    if ((coldEncodeMs[0] ?? Number.POSITIVE_INFINITY) > MAXIMUM_COLD_START_MS) {
      decisionReasons.push("cold-start");
    }
    if (releasedFonts.some((released) => !released) || statsAfterRelease.syncedFonts !== 0) {
      decisionReasons.push("resource-release");
    }

    return Object.freeze({
      harfbuzzVersion: nativeArtifact.harfbuzz.version,
      abiVersion: provenance.abiVersion,
      toolchain: provenance.toolchain,
      wasm: { ...provenance.output, fetchedSha256: wasmSha256 },
      corpusCount: actualRecords.length,
      glyphs: actualRecords.map((record) => ({
        corpusId: record.corpusId,
        glyphId: record.glyphId,
        blobBytes: record.blobHex.length / 2,
      })),
      parity: { mismatchCount, actualHash, expectedHash },
      coldEncodeMs: Object.freeze(coldEncodeMs),
      warmEncodeMs: summarize(warmEncodeMs),
      warmGlyphsPerSecond,
      iterations: { warmup: WARMUP_ITERATIONS, measured: MEASURED_ITERATIONS },
      resources: {
        syncedFontsBeforeRelease: statsBeforeRelease.syncedFonts,
        syncedFontsAfterRelease: statsAfterRelease.syncedFonts,
        releasedFonts: releasedFonts.filter(Boolean).length,
      },
      worker: {
        starts: statsAfterRelease.workerStarts,
        requests: statsAfterRelease.requests,
        encodedGlyphs: statsAfterRelease.encodedGlyphs,
      },
      acceptance: {
        minimumWarmGlyphsPerSecond: MINIMUM_WARM_GLYPHS_PER_SECOND,
        maximumColdStartMs: MAXIMUM_COLD_START_MS,
      },
      decision: {
        status: decisionReasons.length === 0 ? ("go" as const) : ("pause" as const),
        reasons: Object.freeze(decisionReasons),
      },
    });
  } finally {
    await encoder.destroy();
  }
}

function summarize(samples: readonly number[]): Readonly<TimingSummary> {
  if (samples.length === 0) throw new Error("Timing samples are empty");
  const sorted = [...samples].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);

  return Object.freeze({
    count: sorted.length,
    mean: total / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  });
}

function percentile(sorted: readonly number[], ratio: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);

  return sorted[index] ?? 0;
}

async function fetchJson<T>(url: string): Promise<T> {
  return fetch(url)
    .then(requireResponse)
    .then((response) => response.json() as Promise<T>);
}

async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = requireResponse(await fetch(url));

  return new Uint8Array(await response.arrayBuffer());
}

function requireResponse(response: Response): Response {
  if (!response.ok) {
    throw new Error(`Fixture fetch failed: ${String(response.status)} ${response.url}`);
  }

  return response;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", copy.buffer);

  return toHex(new Uint8Array(hash));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export {};
