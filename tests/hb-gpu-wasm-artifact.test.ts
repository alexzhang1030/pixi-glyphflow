import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

const HARFBUZZ_VERSION = "14.4.0";
const HARFBUZZ_COMMIT = "36cb489cb02ce4b92099669ba9f9bea348eff93f";
const HARFBUZZ_SOURCE_SHA256 = "0afa12c8ef4bc4ffebd99e5d2a4a2c56dfe329c661feda08a9bc878b7352be89";
const EMSCRIPTEN_VERSION = "4.0.16";
const EMSCRIPTEN_IMAGE_DIGEST =
  "sha256:69820cfa8dd489d1ddd13bb394b9b9a80b491fb6a3b44715622b5cba0e5f49fb";
const WASM_SHA256 = "81aa7c58ce797ed760d4a40722c53aa261fde343e26cb9508482d5cd9abf493d";
const WASM_RAW_BYTES = 221_915;
const WASM_GZIP_BYTES = 82_626;

interface Provenance {
  readonly schemaVersion: number;
  readonly artifact: string;
  readonly abiVersion: number;
  readonly resultStructBytes: number;
  readonly harfbuzz: {
    readonly version: string;
    readonly commit: string;
    readonly sourceUrl: string;
    readonly sourceSha256: string;
    readonly licenseFile: string;
    readonly licenseSha256: string;
    readonly experimentalGpuApi: boolean;
  };
  readonly toolchain: {
    readonly emscriptenVersion: string;
    readonly image: string;
    readonly imageDigest: string;
    readonly sourceDateEpoch: number;
  };
  readonly build: {
    readonly shim: string;
    readonly shimSha256: string;
    readonly dockerArgvTemplate: readonly string[];
    readonly reproduction: string;
  };
  readonly output: {
    readonly file: string;
    readonly sha256: string;
    readonly rawBytes: number;
    readonly gzipBytes: number;
  };
}

interface BrowserArtifact {
  readonly schemaVersion: number;
  readonly benchmark: string;
  readonly sourceArtifact: string;
  readonly sourceArtifactSha256: string;
  readonly provenanceFile: string;
  readonly provenanceSha256: string;
  readonly sourceSha256: {
    readonly html: string;
    readonly browser: string;
    readonly worker: string;
    readonly runtime: string;
    readonly shim: string;
    readonly build: string;
  };
  readonly result: {
    readonly harfbuzzVersion: string;
    readonly abiVersion: number;
    readonly wasm: {
      readonly file: string;
      readonly sha256: string;
      readonly fetchedSha256: string;
      readonly rawBytes: number;
      readonly gzipBytes: number;
    };
    readonly corpusCount: number;
    readonly glyphs: readonly { readonly corpusId: string }[];
    readonly parity: {
      readonly mismatchCount: number;
      readonly actualHash: string;
      readonly expectedHash: string;
    };
    readonly coldEncodeMs: readonly number[];
    readonly warmGlyphsPerSecond: number;
    readonly resources: {
      readonly syncedFontsBeforeRelease: number;
      readonly syncedFontsAfterRelease: number;
      readonly releasedFonts: number;
    };
    readonly acceptance: {
      readonly minimumWarmGlyphsPerSecond: number;
      readonly maximumColdStartMs: number;
    };
    readonly decision: { readonly status: string; readonly reasons: readonly string[] };
  };
  readonly consoleMessages: readonly string[];
}

describe("Hb GPU Wasm artifacts", () => {
  test("pins the compiler, HarfBuzz source, license, shim, and Wasm bytes", async () => {
    const provenancePath = new URL("../src/hb-gpu/wasm/provenance.json", import.meta.url);
    const provenance = (await Bun.file(provenancePath).json()) as Provenance;
    const wasmBytes = new Uint8Array(
      await Bun.file(
        new URL("../src/hb-gpu/wasm/hb-gpu-encoder.wasm", import.meta.url),
      ).arrayBuffer(),
    );
    const licensePath = new URL(
      `../src/hb-gpu/wasm/${provenance.harfbuzz.licenseFile}`,
      import.meta.url,
    );
    const shimPath = new URL(`../${provenance.build.shim}`, import.meta.url);

    expect(provenance).toMatchObject({
      schemaVersion: 1,
      artifact: "pixi-glyphflow-hb-gpu-draw-encoder",
      abiVersion: 1,
      resultStructBytes: 28,
      harfbuzz: {
        version: HARFBUZZ_VERSION,
        commit: HARFBUZZ_COMMIT,
        sourceSha256: HARFBUZZ_SOURCE_SHA256,
        licenseFile: "LICENSE.harfbuzz.txt",
        experimentalGpuApi: true,
      },
      toolchain: {
        emscriptenVersion: EMSCRIPTEN_VERSION,
        imageDigest: EMSCRIPTEN_IMAGE_DIGEST,
        sourceDateEpoch: 1_787_772_600,
      },
      output: {
        file: "hb-gpu-encoder.wasm",
        sha256: WASM_SHA256,
        rawBytes: WASM_RAW_BYTES,
        gzipBytes: WASM_GZIP_BYTES,
      },
    });
    expect(provenance.harfbuzz.sourceUrl).toContain(HARFBUZZ_COMMIT);
    expect(provenance.toolchain.image).toContain(EMSCRIPTEN_IMAGE_DIGEST);
    expect(provenance.build.dockerArgvTemplate).toContain("--network=none");
    expect(provenance.build.dockerArgvTemplate).toContain("SOURCE_DATE_EPOCH=1787772600");
    expect(provenance.build.reproduction).toContain("--source-archive");
    expect(await sha256(wasmBytes)).toBe(WASM_SHA256);
    expect(wasmBytes.byteLength).toBe(WASM_RAW_BYTES);
    expect(gzipSync(wasmBytes, { level: 9 }).byteLength).toBe(WASM_GZIP_BYTES);
    expect(await sha256File(licensePath)).toBe(provenance.harfbuzz.licenseSha256);
    expect(await sha256File(shimPath)).toBe(provenance.build.shimSha256);
  });

  test("keeps the browser Worker result reproducible and inside its Go gates", async () => {
    const artifact = (await Bun.file(
      new URL("../benchmarks/hb-gpu/results/hb-gpu-draw-wasm-browser-14.4.0.json", import.meta.url),
    ).json()) as BrowserArtifact;

    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.benchmark).toBe("hb-gpu-draw-wasm-browser");
    expect(artifact.result.harfbuzzVersion).toBe(HARFBUZZ_VERSION);
    expect(artifact.result.abiVersion).toBe(1);
    expect(artifact.result.wasm).toEqual({
      file: "hb-gpu-encoder.wasm",
      sha256: WASM_SHA256,
      rawBytes: WASM_RAW_BYTES,
      gzipBytes: WASM_GZIP_BYTES,
      fetchedSha256: WASM_SHA256,
    });
    expect(artifact.result.glyphs.map((glyph) => glyph.corpusId)).toEqual([
      "cjkv",
      "arabic",
      "devanagari",
      "hebrew",
      "thai",
    ]);
    expect(artifact.result.corpusCount).toBe(5);
    expect(artifact.result.parity.mismatchCount).toBe(0);
    expect(artifact.result.parity.actualHash).toBe(artifact.result.parity.expectedHash);
    expect(artifact.result.coldEncodeMs[0]).toBeLessThanOrEqual(
      artifact.result.acceptance.maximumColdStartMs,
    );
    expect(artifact.result.warmGlyphsPerSecond).toBeGreaterThanOrEqual(
      artifact.result.acceptance.minimumWarmGlyphsPerSecond,
    );
    expect(artifact.result.resources).toEqual({
      syncedFontsBeforeRelease: 5,
      syncedFontsAfterRelease: 0,
      releasedFonts: 5,
    });
    expect(artifact.result.decision).toEqual({ status: "go", reasons: [] });
    expect(artifact.consoleMessages.some((message) => message.startsWith("pageerror:"))).toBe(
      false,
    );

    const root = new URL("../", import.meta.url);
    expect(await sha256File(new URL(artifact.sourceArtifact, root))).toBe(
      artifact.sourceArtifactSha256,
    );
    expect(await sha256File(new URL(artifact.provenanceFile, root))).toBe(
      artifact.provenanceSha256,
    );
    const sourcePaths = {
      html: "benchmarks/hb-gpu/wasm-browser.html",
      browser: "benchmarks/hb-gpu/wasm-browser.ts",
      worker: "src/hb-gpu/worker.ts",
      runtime: "src/hb-gpu/HbGpuWasmRuntime.ts",
      shim: "src/hb-gpu/native/hb-gpu-encoder.cc",
      build: "scripts/build-hb-gpu-wasm.ts",
    } as const;
    for (const key of Object.keys(sourcePaths) as (keyof typeof sourcePaths)[]) {
      expect(await sha256File(new URL(sourcePaths[key], root)), key).toBe(
        artifact.sourceSha256[key],
      );
    }
  });
});

async function sha256File(path: URL): Promise<string> {
  return sha256(new Uint8Array(await Bun.file(path).arrayBuffer()));
}

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);

  return hasher.digest("hex");
}
