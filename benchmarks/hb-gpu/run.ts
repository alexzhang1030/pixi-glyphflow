import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { benchmarkRuntime } from "../runtime";
import { summarize } from "../schema";
import {
  evaluateHbGpuDrawArtifact,
  HB_GPU_DRAW_ATLAS_PRESSURE_UNIQUE_GLYPHS,
  HB_GPU_DRAW_CORPUS_COUNT,
  HB_GPU_DRAW_MAX_STORAGE_BYTES_PER_GLYPH_P95,
  HB_GPU_DRAW_MAX_PROJECTED_STORAGE_BYTES,
  HB_GPU_DRAW_MIN_ENCODE_GLYPHS_PER_SECOND,
  HB_GPU_DRAW_PINNED_VERSION,
  HB_GPU_DRAW_SCHEMA_VERSION,
  parseHbGpuNativeSample,
  signExtendedWebGpuStorageBytes,
  type HbGpuNativeSample,
  type HbGpuNativeShaderSourceBytes,
} from "./schema";

const projectRoot = resolve(import.meta.dir, "../..");
const nativeSource = resolve(import.meta.dir, "native.c");
const iterations = readPositiveInteger("--iterations", 128);
const outputPath = resolve(
  projectRoot,
  readArgument("--output") ??
    `benchmarks/hb-gpu/results/hb-gpu-draw-native-${HB_GPU_DRAW_PINNED_VERSION}.json`,
);
const corpora = [
  {
    id: "cjkv",
    fontFile: "site/public/fonts/noto-sans-cjkv-demo.ttf",
    expectedFontSha256: "5fa2f79c0af4a16b5c1c0ae38a46bf059dd8d112a47198450ce37aeacb32582a",
    text: "简体中文 · 上海字流繁體中文 · 臺北字型日本語 · 東京テキスト한국어 · 서울글리프Tiếng Việt · Hà NộiРусский · ПриветΕλληνικά · Γεια",
  },
  {
    id: "arabic",
    fontFile: "site/public/fonts/noto-sans-arabic-demo.ttf",
    expectedFontSha256: "6649353be1ef1953082db55901458866ad151bcbd183a07a3e29b6b5b29fb1f3",
    text: "العربية · مرحبا",
  },
  {
    id: "devanagari",
    fontFile: "site/public/fonts/noto-sans-devanagari-demo.ttf",
    expectedFontSha256: "fa3cdcbea5cf83079b97dff95ba4e3e980538f3b78cbeabca9869a2b9b0bf99d",
    text: "हिन्दी · नमस्ते",
  },
  {
    id: "hebrew",
    fontFile: "site/public/fonts/noto-sans-hebrew-demo.ttf",
    expectedFontSha256: "12ddc32ebd5fc604751c10ed1e60d9e804cdd367ed1c8a62d6ac0f2218c6b55a",
    text: "עברית · שלום",
  },
  {
    id: "thai",
    fontFile: "site/public/fonts/noto-sans-thai-demo.ttf",
    expectedFontSha256: "1886d9681105d3ac85e176044541e8d6e34891d33c556e8c26b00a7d44a4a40a",
    text: "ไทย · สวัสดี",
  },
] as const;

const pkgConfigArgv = ["pkg-config", "--cflags", "--libs", "harfbuzz-gpu", "harfbuzz"];
const pkgConfigFlags = splitArgv(await runText(pkgConfigArgv));
const pkgConfigVersions = (
  await runText(["pkg-config", "--modversion", "harfbuzz-gpu", "harfbuzz"])
)
  .trim()
  .split(/\s+/u);
if (
  pkgConfigVersions.length !== 2 ||
  pkgConfigVersions.some((version) => version !== HB_GPU_DRAW_PINNED_VERSION)
) {
  throw new Error(
    `HarfBuzz GPU spike requires pkg-config harfbuzz-gpu and harfbuzz ${HB_GPU_DRAW_PINNED_VERSION}`,
  );
}

const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "pixi-glyphflow-hb-gpu-"));
const binaryPath = resolve(temporaryDirectory, "hb-gpu-draw-native");
const clangArgv = [
  "clang",
  nativeSource,
  "-O3",
  "-std=c11",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-o",
  binaryPath,
  ...pkgConfigFlags,
];

let corpusResults: readonly ReturnType<typeof createCorpusResult>[] = [];
let nativeShaderSourceBytes: Readonly<HbGpuNativeShaderSourceBytes> | undefined;
let nativeShaderSources: Readonly<HbGpuNativeShaderSources> | undefined;
try {
  await runText(clangArgv);
  const measured: ReturnType<typeof createCorpusResult>[] = [];
  for (const corpus of corpora) {
    const fontPath = resolve(projectRoot, corpus.fontFile);
    const fontBytes = new Uint8Array(await Bun.file(fontPath).arrayBuffer());
    const fontSha256 = sha256(fontBytes);
    if (fontSha256 !== corpus.expectedFontSha256) {
      throw new Error(`${corpus.fontFile} SHA-256 differs from its provenance record`);
    }
    const corpusSha256 = sha256(corpus.text);
    const repeats = [
      await runNative(binaryPath, fontPath, corpus.text, iterations),
      await runNative(binaryPath, fontPath, corpus.text, 1),
    ];
    const firstRepeat = repeats[0];
    if (firstRepeat === undefined) throw new Error(`${corpus.id} produced zero native samples`);
    if (nativeShaderSourceBytes === undefined) {
      nativeShaderSourceBytes = firstRepeat.shaderSourceBytes;
      nativeShaderSources = firstRepeat.shaderSources;
    } else if (
      JSON.stringify(nativeShaderSourceBytes) !== JSON.stringify(firstRepeat.shaderSourceBytes)
    ) {
      throw new Error(`${corpus.id} returned different WGSL shader source sizes`);
    } else if (JSON.stringify(nativeShaderSources) !== JSON.stringify(firstRepeat.shaderSources)) {
      throw new Error(`${corpus.id} returned different WGSL shader sources`);
    }
    measured.push(createCorpusResult(corpus, fontSha256, corpusSha256, repeats));
  }
  corpusResults = Object.freeze(measured);
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

const glyphs = corpusResults.flatMap((corpus) => corpus.glyphs);
const encodeMsSamples = glyphs.map((glyph) => glyph.encodeMs);
const blobByteSamples = glyphs.map((glyph) => glyph.blobCpuBytes);
const storageByteSamples = glyphs.map((glyph) => glyph.signExtendedWebGpuStorageBytes);
const totalEncodeMs = encodeMsSamples.reduce((total, value) => total + value, 0);
const encodeGlyphsPerSecond = (glyphs.length * 1_000) / totalEncodeMs;
const drawFailureCount = corpusResults.reduce(
  (total, corpus) => total + corpus.drawFailureCount,
  0,
);
const encodeFailureCount = corpusResults.reduce(
  (total, corpus) => total + corpus.encodeFailureCount,
  0,
);
const blobMismatchCount = corpusResults.reduce(
  (total, corpus) => total + corpus.blobMismatchCount,
  0,
);
const deterministic = corpusResults.every((corpus) => corpus.deterministic);
const blobCpuBytes = blobByteSamples.reduce((total, value) => total + value, 0);
const totalSignExtendedWebGpuStorageBytes = storageByteSamples.reduce(
  (total, value) => total + value,
  0,
);
const meanSignExtendedBytesPerGlyph = totalSignExtendedWebGpuStorageBytes / glyphs.length;
const meanPackedBlobBytesPerGlyph = blobCpuBytes / glyphs.length;
const atlasPressureProjectedPackedBytes = Math.ceil(
  meanPackedBlobBytesPerGlyph * HB_GPU_DRAW_ATLAS_PRESSURE_UNIQUE_GLYPHS,
);
const atlasPressureProjectedStorageBytes = Math.ceil(
  meanSignExtendedBytesPerGlyph * HB_GPU_DRAW_ATLAS_PRESSURE_UNIQUE_GLYPHS,
);
if (nativeShaderSourceBytes === undefined)
  throw new Error("WGSL shader source metrics are unavailable");
if (nativeShaderSources === undefined) throw new Error("WGSL shader sources are unavailable");
const shaderSourceBytes = Object.freeze({
  ...nativeShaderSourceBytes,
  total:
    nativeShaderSourceBytes.sharedVertex +
    nativeShaderSourceBytes.sharedFragment +
    nativeShaderSourceBytes.drawVertex +
    nativeShaderSourceBytes.drawFragment,
});
const signExtendedBytesPerGlyph = summarize(storageByteSamples, "bytes");
const decision = evaluateHbGpuDrawArtifact({
  harfbuzzVersion: pkgConfigVersions[0] ?? "",
  corpusCount: corpusResults.length,
  drawFailureCount,
  encodeFailureCount,
  deterministic,
  wgslShaderSourceBytes: shaderSourceBytes.total,
  encodeGlyphsPerSecond,
  atlasPressureProjectedPackedBytes,
  atlasPressureProjectedStorageBytes,
  signExtendedBytesPerGlyphP95: signExtendedBytesPerGlyph.p95,
});
const packageMetadata = (await Bun.file(resolve(projectRoot, "package.json")).json()) as {
  readonly version: string;
};
const compilerVersion = (await runText(["clang", "--version"])).split("\n", 1)[0]?.trim();
if (compilerVersion === undefined || compilerVersion.length === 0) {
  throw new Error("clang version output is unavailable");
}

const artifact = {
  schemaVersion: HB_GPU_DRAW_SCHEMA_VERSION,
  benchmark: "hb-gpu-draw-native",
  packageVersion: packageMetadata.version,
  capturedAt: new Date().toISOString(),
  runtime: benchmarkRuntime(),
  harfbuzz: {
    version: pkgConfigVersions[0] ?? "",
    pinnedVersion: HB_GPU_DRAW_PINNED_VERSION,
    pkgConfigModules: Object.freeze(["harfbuzz-gpu", "harfbuzz"]),
    experimentalAbi: true,
  },
  compilerVersion,
  nativeHelperSha256: sha256(new Uint8Array(await Bun.file(nativeSource).arrayBuffer())),
  commands: {
    pkgConfigArgv: Object.freeze(pkgConfigArgv),
    clangArgvTemplate: Object.freeze([
      "clang",
      "benchmarks/hb-gpu/native.c",
      "-O3",
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-o",
      "<temporary>/hb-gpu-draw-native",
      ...pkgConfigFlags,
    ]),
    benchmarkArgvTemplate: Object.freeze([
      "<temporary>/hb-gpu-draw-native",
      "<font-file>",
      "<utf8-corpus>",
      String(iterations),
    ]),
    reproduction: "bun run benchmark:hb-gpu",
  },
  storageModel: {
    encodedTexel: "RGBA16I",
    encodedTexelBytes: 8,
    webgpuElement: "vec4<i32>",
    webgpuElementBytes: 16,
    conversion: "sign-extend-i16-to-i32",
    packedBrowserCandidates: ["array<vec2<u32>>-wgsl-unpack", "rgba16sint-textureLoad"],
  },
  shaderSourceBytes,
  shaderSources: nativeShaderSources,
  corpora: corpusResults,
  totals: {
    shapedGlyphCount: corpusResults.reduce((total, corpus) => total + corpus.shapedGlyphCount, 0),
    uniqueGlyphCount: glyphs.length,
    drawFailureCount,
    encodeFailureCount,
    blobMismatchCount,
    blobCpuBytes,
    meanPackedBlobBytesPerGlyph,
    atlasPressureProjectedPackedBytes,
    signExtendedWebGpuStorageBytes: totalSignExtendedWebGpuStorageBytes,
    meanSignExtendedBytesPerGlyph,
    atlasPressureProjectedStorageBytes,
    encodeMs: summarize(encodeMsSamples, "ms"),
    blobBytesPerGlyph: summarize(blobByteSamples, "bytes"),
    signExtendedBytesPerGlyph,
    encodeGlyphsPerSecond,
    deterministic,
  },
  acceptance: {
    corpusCount: HB_GPU_DRAW_CORPUS_COUNT,
    drawFailureCount: 0,
    encodeFailureCount: 0,
    deterministic: true,
    minimumEncodeGlyphsPerSecond: HB_GPU_DRAW_MIN_ENCODE_GLYPHS_PER_SECOND,
    atlasPressureUniqueGlyphs: HB_GPU_DRAW_ATLAS_PRESSURE_UNIQUE_GLYPHS,
    maximumProjectedStorageBytes: HB_GPU_DRAW_MAX_PROJECTED_STORAGE_BYTES,
    maximumSignExtendedBytesPerGlyphP95: HB_GPU_DRAW_MAX_STORAGE_BYTES_PER_GLYPH_P95,
    wgslShaderSource: "present",
  },
  decision,
  scope: [
    "native-cpu-shape-and-blob-encode",
    "production-vec4-i32-path-paused",
    "packed-browser-gpu-draw-spike-next",
  ],
};

await mkdir(dirname(outputPath), { recursive: true });
await Bun.write(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
await runText(["bunx", "oxfmt", outputPath]);
console.log(
  JSON.stringify({
    outputPath,
    decision: decision.status,
    next: decision.next,
    shapedGlyphCount: artifact.totals.shapedGlyphCount,
    uniqueGlyphCount: artifact.totals.uniqueGlyphCount,
    drawFailureCount,
    encodeFailureCount,
    deterministic,
    encodeGlyphsPerSecond,
    blobCpuBytes,
    atlasPressureProjectedPackedBytes,
    signExtendedWebGpuStorageBytes: totalSignExtendedWebGpuStorageBytes,
    atlasPressureProjectedStorageBytes,
  }),
);

async function runNative(
  binary: string,
  fontPath: string,
  text: string,
  iterationCount: number,
): Promise<Readonly<HbGpuNativeCapture>> {
  const value = JSON.parse(
    await runText([binary, fontPath, text, String(iterationCount)]),
  ) as unknown;
  const sample = parseHbGpuNativeSample(value);
  const nativeRecord = requireRecord(value, "sample");
  const sourceRecord = requireRecord(nativeRecord.shaderSources, "shaderSources");
  const shaderSources = Object.freeze({
    sharedVertex: requireString(sourceRecord.sharedVertex, "shaderSources.sharedVertex"),
    sharedFragment: requireString(sourceRecord.sharedFragment, "shaderSources.sharedFragment"),
    drawVertex: requireString(sourceRecord.drawVertex, "shaderSources.drawVertex"),
    drawFragment: requireString(sourceRecord.drawFragment, "shaderSources.drawFragment"),
  });
  const encoder = new TextEncoder();
  for (const key of Object.keys(shaderSources) as (keyof HbGpuNativeShaderSources)[]) {
    if (encoder.encode(shaderSources[key]).byteLength !== sample.shaderSourceBytes[key]) {
      throw new TypeError(`${key} WGSL byte length differs from shaderSourceBytes`);
    }
  }

  return Object.freeze({ ...sample, shaderSources });
}

function createCorpusResult(
  corpus: (typeof corpora)[number],
  fontSha256: string,
  corpusSha256: string,
  repeats: readonly Readonly<HbGpuNativeCapture>[],
) {
  const primary = repeats[0];
  if (primary === undefined) throw new Error(`${corpus.id} produced zero native samples`);
  if (repeats.some((sample) => sample.harfbuzzVersion !== HB_GPU_DRAW_PINNED_VERSION)) {
    throw new Error(`${corpus.id} loaded a different HarfBuzz version`);
  }
  const repeatDeterminismHashes = repeats.map((sample) =>
    sha256(
      JSON.stringify({
        harfbuzzVersion: sample.harfbuzzVersion,
        fontSha256,
        corpusSha256,
        shapedGlyphIds: sample.shapedGlyphIds,
        shaderSourceBytes: sample.shaderSourceBytes,
        glyphs: sample.glyphs.map((glyph) => ({
          glyphId: glyph.glyphId,
          blobBytes: glyph.blobBytes,
          blobHex: glyph.blobHex,
          extents: glyph.extents,
        })),
      }),
    ),
  );
  const glyphs = primary.glyphs.map((glyph) => ({
    glyphId: glyph.glyphId,
    blobHex: glyph.blobHex,
    blobCpuBytes: glyph.blobBytes,
    signExtendedWebGpuStorageBytes: signExtendedWebGpuStorageBytes(glyph.blobBytes),
    encodeMs: glyph.encodeNs / 1_000_000,
    extents: glyph.extents,
  }));
  const encodeMsSamples = glyphs.map((glyph) => glyph.encodeMs);
  const blobByteSamples = glyphs.map((glyph) => glyph.blobCpuBytes);
  const storageByteSamples = glyphs.map((glyph) => glyph.signExtendedWebGpuStorageBytes);
  const totalEncodeMs = encodeMsSamples.reduce((total, value) => total + value, 0);

  return Object.freeze({
    id: corpus.id,
    fontFile: corpus.fontFile,
    fontSha256,
    corpus: corpus.text,
    corpusSha256,
    corpusUtf8Bytes: new TextEncoder().encode(corpus.text).byteLength,
    shapedGlyphIds: primary.shapedGlyphIds,
    shapedGlyphCount: primary.shapedGlyphIds.length,
    uniqueGlyphCount: glyphs.length,
    emptyBlobGlyphCount: glyphs.filter(
      (glyph) =>
        glyph.blobCpuBytes === 0 &&
        glyph.extents.xBearing === 0 &&
        glyph.extents.yBearing === 0 &&
        glyph.extents.width === 0 &&
        glyph.extents.height === 0,
    ).length,
    drawFailureCount: repeats.reduce((total, sample) => total + sample.drawFailureCount, 0),
    drawFailureGlyphIds: Object.freeze([
      ...new Set(repeats.flatMap((sample) => sample.drawFailureGlyphIds)),
    ]),
    encodeFailureCount: repeats.reduce((total, sample) => total + sample.encodeFailureCount, 0),
    encodeFailureGlyphIds: Object.freeze([
      ...new Set(repeats.flatMap((sample) => sample.encodeFailureGlyphIds)),
    ]),
    blobMismatchCount: repeats.reduce((total, sample) => total + sample.blobMismatchCount, 0),
    blobCpuBytes: blobByteSamples.reduce((total, value) => total + value, 0),
    signExtendedWebGpuStorageBytes: storageByteSamples.reduce((total, value) => total + value, 0),
    shapeMs: primary.shapeNs / 1_000_000,
    encodeMs: summarize(encodeMsSamples, "ms"),
    blobBytesPerGlyph: summarize(blobByteSamples, "bytes"),
    signExtendedBytesPerGlyph: summarize(storageByteSamples, "bytes"),
    encodeGlyphsPerSecond: (glyphs.length * 1_000) / totalEncodeMs,
    glyphs: Object.freeze(glyphs),
    repeatDeterminismHashes: Object.freeze(repeatDeterminismHashes),
    deterministic:
      new Set(repeatDeterminismHashes).size === 1 &&
      repeats.every((sample) => sample.blobMismatchCount === 0),
  });
}

interface HbGpuNativeShaderSources {
  readonly sharedVertex: string;
  readonly sharedFragment: string;
  readonly drawVertex: string;
  readonly drawFragment: string;
}

interface HbGpuNativeCapture extends HbGpuNativeSample {
  readonly shaderSources: Readonly<HbGpuNativeShaderSources>;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);

  return value;
}

async function runText(argv: readonly string[]): Promise<string> {
  const process = Bun.spawn([...argv], {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${argv[0] ?? "process"} exited with ${String(exitCode)}: ${stderr.trim()}`);
  }

  return stdout;
}

function sha256(value: string | Uint8Array): string {
  const hash = new Bun.CryptoHasher("sha256");
  hash.update(value);
  return hash.digest("hex");
}

function splitArgv(value: string): string[] {
  const output: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = (): void => {
    if (current.length > 0) output.push(current);
    current = "";
  };

  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      push();
    } else {
      current += character;
    }
  }
  if (escaped || quote !== undefined) throw new TypeError("pkg-config returned malformed flags");
  push();
  return output;
}

function readArgument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? undefined : Bun.argv[index + 1];
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = readArgument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be followed by a positive safe integer`);
  }

  return value;
}
