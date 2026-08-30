import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const HARFBUZZ_VERSION = "11.2.1";
const HARFBUZZ_COMMIT = "33a3f8de60dcad7535f14f07d6710144548853ac";
const EMSCRIPTEN_VERSION = "3.1.12";
const HB_GPU_VERSION_BOUNDARY = "14.4.0-independent";
const sourceDirectory = requiredDirectory("HARFBUZZ_SOURCE_DIR");
const emscriptenSdkRoot = requiredDirectory("HARFBUZZ_EMSDK_ROOT");
const projectRoot = resolve(import.meta.dir, "..");
const outputRoot = resolve(projectRoot, "benchmarks/shaping-simd/wasm");
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "pixi-glyphflow-hb-shaping-"));
const emscriptenRoot = resolve(emscriptenSdkRoot, "emscripten");
const binaryenRoot = emscriptenSdkRoot;
const llvmRoot = resolve(emscriptenSdkRoot, "bin");
const emcc = resolve(emscriptenRoot, "em++");
const wasmDis = resolve(llvmRoot, "wasm-dis");
const configPath = resolve(temporaryRoot, "emscripten-config.py");
const cachePath = resolve(process.env.HARFBUZZ_EM_CACHE ?? resolve(temporaryRoot, "cache"));
const configOverridePath = resolve(temporaryRoot, "config-override.h");
const simdInstructionPattern = /\((?:v128\.|i8x16\.|i16x8\.|i32x4\.|i64x2\.|f32x4\.|f64x2\.)/g;

const exportedFunctions = [
  "_malloc",
  "_free",
  "_hb_blob_create",
  "_hb_blob_destroy",
  "_hb_face_create",
  "_hb_face_reference",
  "_hb_face_destroy",
  "_hb_face_get_upem",
  "_hb_font_create",
  "_hb_font_destroy",
  "_hb_font_set_scale",
  "_hb_font_set_variations",
  "_hb_font_get_h_extents",
  "_hb_font_get_glyph_extents",
  "_hb_buffer_create",
  "_hb_buffer_destroy",
  "_hb_buffer_reference",
  "_hb_buffer_add_utf16",
  "_hb_buffer_guess_segment_properties",
  "_hb_buffer_set_direction",
  "_hb_buffer_set_language",
  "_hb_language_from_string",
  "_hb_buffer_set_script",
  "_hb_script_from_string",
  "_hb_buffer_get_length",
  "_hb_buffer_get_glyph_infos",
  "_hb_glyph_info_get_glyph_flags",
  "_hb_buffer_get_glyph_positions",
  "_hb_buffer_clear_contents",
  "_hb_feature_from_string",
  "_hb_shape",
] as const;

const sharedFlags = [
  "-DHB_TINY",
  "-DHAVE_CONFIG_OVERRIDE_H",
  "-O3",
  "-sMODULARIZE=1",
  "-sEXPORT_ES6=1",
  "-sENVIRONMENT=web,worker",
  "-sFILESYSTEM=0",
  "-sALLOW_MEMORY_GROWTH=1",
  "-sALLOW_TABLE_GROWTH=1",
  "-sEXPORTED_RUNTIME_METHODS=addFunction,removeFunction,stackSave,stackAlloc,stackRestore",
  `-sEXPORTED_FUNCTIONS=${exportedFunctions.join(",")}`,
] as const;

interface AssetRecord {
  readonly wasm: string;
  readonly glue: string;
  readonly sha256: string;
  readonly rawBytes: number;
  readonly gzipBytes: number;
  readonly simdInstructionCount: number;
}

try {
  await Bun.write(
    configPath,
    [
      `LLVM_ROOT = ${pythonString(llvmRoot)}`,
      `NODE_JS = ${pythonString(process.execPath)}`,
      `BINARYEN_ROOT = ${pythonString(binaryenRoot)}`,
      `CACHE = ${pythonString(cachePath)}`,
      "FROZEN_CACHE = False",
      "COMPILER_ENGINE = NODE_JS",
      "JS_ENGINES = [NODE_JS]",
      "",
    ].join("\n"),
  );
  await assertPinnedSource();
  await Bun.write(
    configOverridePath,
    [
      "// HB_TINY supplies the package's current compact shaping boundary.",
      "// Variable-font shaping remains part of HarfBuzzWorkerShaper's public input.",
      "#undef HB_NO_VAR",
      "",
    ].join("\n"),
  );

  const [scalar, simd] = await Promise.all([
    buildVariant("scalar", []),
    buildVariant("simd", ["-msimd128"]),
  ]);
  if (scalar.simdInstructionCount !== 0) {
    throw new Error("Scalar HarfBuzz asset contains SIMD instructions");
  }
  if (simd.simdInstructionCount === 0) {
    throw new Error("SIMD HarfBuzz asset contains zero SIMD instructions");
  }

  const licenseSource = resolve(sourceDirectory, "COPYING");
  const licenseFile = "LICENSE.harfbuzz.txt";
  await mkdir(outputRoot, { recursive: true });
  await Bun.write(resolve(outputRoot, licenseFile), Bun.file(licenseSource));
  const packageRawDeltaBytes = simd.rawBytes + (await fileSize(resolve(outputRoot, simd.glue)));
  const packageGzipDeltaBytes = simd.gzipBytes + (await gzipSize(resolve(outputRoot, simd.glue)));
  const provenance = {
    schemaVersion: 1,
    status: "experimental-opt-in",
    harfbuzz: {
      version: HARFBUZZ_VERSION,
      commit: HARFBUZZ_COMMIT,
      repository: "https://github.com/harfbuzz/harfbuzz",
      licenseFile,
      sourceRole: "worker-shaping",
      hbGpuVersionBoundary: HB_GPU_VERSION_BOUNDARY,
    },
    toolchain: {
      emscriptenVersion: EMSCRIPTEN_VERSION,
      sharedFlags,
      variantFlags: { scalar: [], simd: ["-msimd128"] },
      configOverride: ["#undef HB_NO_VAR"],
    },
    assets: { scalar, simd },
    packageDecision: {
      status: "pause",
      reason: "human-approval-required",
      rawDeltaBytes: packageRawDeltaBytes,
      gzipDeltaBytes: packageGzipDeltaBytes,
    },
  } as const;
  const provenancePath = resolve(outputRoot, "provenance.json");
  await Bun.write(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  await run(["bunx", "oxfmt", provenancePath]);
  console.log(JSON.stringify(provenance, undefined, 2));
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}

async function buildVariant(
  variant: "scalar" | "simd",
  variantFlags: readonly string[],
): Promise<Readonly<AssetRecord>> {
  const temporaryDirectory = resolve(temporaryRoot, variant);
  const destinationDirectory = resolve(outputRoot, variant);
  const jsPath = resolve(temporaryDirectory, "harfbuzz.js");
  const wasmPath = resolve(temporaryDirectory, "harfbuzz.wasm");
  const watPath = resolve(temporaryDirectory, "harfbuzz.wat");
  await mkdir(temporaryDirectory, { recursive: true });
  await run([
    emcc,
    resolve(sourceDirectory, "src/harfbuzz.cc"),
    `-I${resolve(sourceDirectory, "src")}`,
    `-I${temporaryRoot}`,
    ...sharedFlags,
    ...variantFlags,
    "-o",
    jsPath,
  ]);
  await run([wasmDis, "--all-features", wasmPath, "-o", watPath]);
  const wat = await Bun.file(watPath).text();
  const simdInstructionCount = [...wat.matchAll(simdInstructionPattern)].length;
  const wasm = await Bun.file(wasmPath).bytes();
  const glue = await Bun.file(jsPath).bytes();
  await mkdir(destinationDirectory, { recursive: true });
  await Promise.all([
    Bun.write(resolve(destinationDirectory, "harfbuzz.wasm"), wasm),
    Bun.write(resolve(destinationDirectory, "harfbuzz.js"), glue),
  ]);

  return Object.freeze({
    wasm: `${variant}/harfbuzz.wasm`,
    glue: `${variant}/harfbuzz.js`,
    sha256: sha256(wasm),
    rawBytes: wasm.byteLength,
    gzipBytes: Bun.gzipSync(wasm, { level: 9 }).byteLength,
    simdInstructionCount,
  });
}

async function assertPinnedSource(): Promise<void> {
  const [commit, meson] = await Promise.all([
    run(["git", "-C", sourceDirectory, "rev-parse", "HEAD"]),
    Bun.file(resolve(sourceDirectory, "meson.build")).text(),
  ]);
  if (commit.trim() !== HARFBUZZ_COMMIT) {
    throw new Error(
      `HarfBuzz source commit ${commit.trim()} differs from pinned ${HARFBUZZ_COMMIT}`,
    );
  }
  if (!meson.includes(`version: '${HARFBUZZ_VERSION}'`)) {
    throw new Error(`HarfBuzz source version differs from pinned ${HARFBUZZ_VERSION}`);
  }
  const emccVersion = await run([emcc, "--version"]);
  if (
    !emccVersion.includes(`emcc (Emscripten`) ||
    !emccVersion.includes(`) ${EMSCRIPTEN_VERSION} (`)
  ) {
    throw new Error(`Emscripten version differs from pinned ${EMSCRIPTEN_VERSION}`);
  }
}

async function run(argv: readonly string[]): Promise<string> {
  const child = Bun.spawn([...argv], {
    cwd: projectRoot,
    env: { ...process.env, EM_CONFIG: configPath },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${argv[0] ?? "process"} exited with ${String(exitCode)}: ${stderr.trim() || stdout.trim()}`,
    );
  }

  return `${stdout}${stderr}`;
}

function requiredDirectory(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} must point to an existing local directory`);
  }

  return resolve(value);
}

function pythonString(value: string): string {
  return JSON.stringify(value);
}

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);

  return hasher.digest("hex");
}

async function fileSize(path: string): Promise<number> {
  return (await Bun.file(path).bytes()).byteLength;
}

async function gzipSize(path: string): Promise<number> {
  return Bun.gzipSync(await Bun.file(path).bytes(), { level: 9 }).byteLength;
}
