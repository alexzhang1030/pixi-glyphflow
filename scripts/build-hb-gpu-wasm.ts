import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const HARFBUZZ_VERSION = "14.4.0";
const HARFBUZZ_COMMIT = "36cb489cb02ce4b92099669ba9f9bea348eff93f";
const HARFBUZZ_SOURCE_URL = `https://github.com/harfbuzz/harfbuzz/archive/${HARFBUZZ_COMMIT}.tar.gz`;
const HARFBUZZ_SOURCE_SHA256 = "0afa12c8ef4bc4ffebd99e5d2a4a2c56dfe329c661feda08a9bc878b7352be89";
const EMSCRIPTEN_VERSION = "4.0.16";
const EMSCRIPTEN_IMAGE =
  "emscripten/emsdk@sha256:69820cfa8dd489d1ddd13bb394b9b9a80b491fb6a3b44715622b5cba0e5f49fb";
const EMSCRIPTEN_IMAGE_DIGEST =
  "sha256:69820cfa8dd489d1ddd13bb394b9b9a80b491fb6a3b44715622b5cba0e5f49fb";
const SOURCE_DATE_EPOCH = "1787772600";
const WASM_FILE = "hb-gpu-encoder.wasm";
const LICENSE_FILE = "LICENSE.harfbuzz.txt";
const PROVENANCE_FILE = "provenance.json";

const projectRoot = resolve(import.meta.dir, "..");
const shimPath = resolve(projectRoot, "src/hb-gpu/native/hb-gpu-encoder.cc");
const outputDirectory = resolve(projectRoot, readArgument("--output-dir") ?? "src/hb-gpu/wasm");
const suppliedSourceArchive = readArgument("--source-archive");
const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "pixi-glyphflow-hb-wasm-"));
const sourceDirectory = resolve(temporaryDirectory, "source");
const buildDirectory = resolve(temporaryDirectory, "out");
const sourceArchive =
  suppliedSourceArchive === undefined
    ? resolve(temporaryDirectory, "harfbuzz-14.4.0.tar.gz")
    : resolve(projectRoot, suppliedSourceArchive);

try {
  await mkdir(sourceDirectory, { recursive: true });
  await mkdir(buildDirectory, { recursive: true });
  if (suppliedSourceArchive === undefined) await downloadSource(sourceArchive);
  const sourceBytes = new Uint8Array(await readFile(sourceArchive));
  assertSha256(sourceBytes, HARFBUZZ_SOURCE_SHA256, "HarfBuzz source archive");
  await run(["tar", "-xzf", sourceArchive, "-C", sourceDirectory, "--strip-components=1"]);
  const mesonSource = await readFile(resolve(sourceDirectory, "meson.build"), "utf8");
  if (!mesonSource.includes(`version: '${HARFBUZZ_VERSION}'`)) {
    throw new Error(`HarfBuzz source version differs from ${HARFBUZZ_VERSION}`);
  }

  await requirePinnedImage();
  const compileArguments = compileArgv(sourceDirectory, buildDirectory);
  await run(compileArguments);
  const compilerVersion = firstLine(
    await run(["docker", "run", "--rm", EMSCRIPTEN_IMAGE, "em++", "--version"]),
  );
  if (!compilerVersion.includes(EMSCRIPTEN_VERSION)) {
    throw new Error(
      `Pinned image returned ${compilerVersion}; expected Emscripten ${EMSCRIPTEN_VERSION}`,
    );
  }

  const wasmBytes = new Uint8Array(await readFile(resolve(buildDirectory, WASM_FILE)));
  const licenseBytes = new Uint8Array(await readFile(resolve(sourceDirectory, "COPYING")));
  const shimBytes = new Uint8Array(await readFile(shimPath));
  const wasmSha256 = sha256(wasmBytes);
  const licenseSha256 = sha256(licenseBytes);
  const provenance = {
    schemaVersion: 1,
    artifact: "pixi-glyphflow-hb-gpu-draw-encoder",
    abiVersion: 1,
    resultStructBytes: 28,
    harfbuzz: {
      version: HARFBUZZ_VERSION,
      commit: HARFBUZZ_COMMIT,
      sourceUrl: HARFBUZZ_SOURCE_URL,
      sourceSha256: HARFBUZZ_SOURCE_SHA256,
      licenseFile: LICENSE_FILE,
      licenseSha256,
      experimentalGpuApi: true,
    },
    toolchain: {
      emscriptenVersion: EMSCRIPTEN_VERSION,
      image: EMSCRIPTEN_IMAGE,
      imageDigest: EMSCRIPTEN_IMAGE_DIGEST,
      compilerVersion,
      sourceDateEpoch: Number(SOURCE_DATE_EPOCH),
    },
    build: {
      shim: "src/hb-gpu/native/hb-gpu-encoder.cc",
      shimSha256: sha256(shimBytes),
      dockerArgvTemplate: compileArguments.map((argument, index) =>
        compileArguments[index - 1] === "--user"
          ? "<uid>:<gid>"
          : argument
              .replace(sourceDirectory, "<source>")
              .replace(buildDirectory, "<output>")
              .replace(projectRoot, "<project>"),
      ),
      reproduction:
        "bun scripts/build-hb-gpu-wasm.ts --source-archive <verified-harfbuzz-14.4.0.tar.gz>",
    },
    output: {
      file: WASM_FILE,
      sha256: wasmSha256,
      rawBytes: wasmBytes.byteLength,
      gzipBytes: gzipSync(wasmBytes, { level: 9 }).byteLength,
    },
  } as const;

  await mkdir(outputDirectory, { recursive: true });
  await Bun.write(resolve(outputDirectory, WASM_FILE), wasmBytes);
  await Bun.write(resolve(outputDirectory, LICENSE_FILE), licenseBytes);
  await Bun.write(
    resolve(outputDirectory, PROVENANCE_FILE),
    `${JSON.stringify(provenance, undefined, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      outputDirectory,
      harfbuzzVersion: HARFBUZZ_VERSION,
      emscriptenVersion: EMSCRIPTEN_VERSION,
      wasmSha256,
      rawBytes: provenance.output.rawBytes,
      gzipBytes: provenance.output.gzipBytes,
    }),
  );
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true });
}

function compileArgv(sourceDirectory: string, buildDirectory: string): string[] {
  const user = `${String(process.getuid?.() ?? 0)}:${String(process.getgid?.() ?? 0)}`;
  const exportedFunctions = [
    "_malloc",
    "_free",
    "_hb_gpu_encoder_abi_version",
    "_hb_gpu_encoder_harfbuzz_version",
    "_hb_gpu_encoder_result_size",
    "_hb_gpu_encoder_last_error",
    "_hb_gpu_encoder_live_fonts",
    "_hb_gpu_encoder_live_results",
    "_hb_gpu_encoder_create",
    "_hb_gpu_encoder_destroy",
    "_hb_gpu_encoder_clear_result",
    "_hb_gpu_encoder_encode",
  ];

  return [
    "docker",
    "run",
    "--rm",
    "--network=none",
    "--user",
    user,
    "--env",
    `SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}`,
    "--env",
    "TZ=UTC",
    "--env",
    "LC_ALL=C",
    "--volume",
    `${sourceDirectory}:/harfbuzz:ro`,
    "--volume",
    `${projectRoot}:/project:ro`,
    "--volume",
    `${buildDirectory}:/out`,
    EMSCRIPTEN_IMAGE,
    "em++",
    "-std=c++17",
    "-Oz",
    "-flto",
    "-I/harfbuzz/src",
    "-DHB_HAS_GPU",
    "-DHB_EXPERIMENTAL_API",
    "/harfbuzz/src/harfbuzz-world.cc",
    "/project/src/hb-gpu/native/hb-gpu-encoder.cc",
    "-sSTANDALONE_WASM=1",
    "-sFILESYSTEM=0",
    "-sALLOW_MEMORY_GROWTH=1",
    "-sMALLOC=emmalloc",
    "-sASSERTIONS=0",
    "-sSTACK_SIZE=65536",
    "-sINITIAL_MEMORY=16777216",
    `-sEXPORTED_FUNCTIONS=${JSON.stringify(exportedFunctions)}`,
    "--no-entry",
    "-o",
    `/out/${WASM_FILE}`,
  ];
}

async function requirePinnedImage(): Promise<void> {
  let output: string;
  try {
    output = await run([
      "docker",
      "image",
      "inspect",
      EMSCRIPTEN_IMAGE,
      "--format",
      "{{json .RepoDigests}}",
    ]);
  } catch (error) {
    throw new Error(
      `Pinned Emscripten image is unavailable. Run: docker pull ${EMSCRIPTEN_IMAGE}`,
      { cause: error },
    );
  }
  if (!output.includes(EMSCRIPTEN_IMAGE_DIGEST)) {
    throw new Error(`Docker image metadata omits ${EMSCRIPTEN_IMAGE_DIGEST}`);
  }
}

async function downloadSource(output: string): Promise<void> {
  const response = await fetch(HARFBUZZ_SOURCE_URL, {
    headers: { "User-Agent": "pixi-glyphflow-hb-gpu-builder" },
  });
  if (!response.ok) {
    throw new Error(
      `HarfBuzz source download failed: ${String(response.status)} ${response.statusText}`,
    );
  }
  await Bun.write(output, await response.arrayBuffer());
}

async function run(argv: readonly string[]): Promise<string> {
  const process = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${argv[0] ?? "command"} exited ${String(exitCode)}: ${stderr.trim() || stdout.trim()}`,
    );
  }

  return stdout.trim();
}

function readArgument(name: string): string | undefined {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Bun.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

function assertSha256(bytes: Uint8Array, expected: string, label: string): void {
  const actual = sha256(bytes);
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, received ${actual}`);
  }
}

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);

  return hasher.digest("hex");
}

function firstLine(value: string): string {
  const line = value.split("\n", 1)[0]?.trim();
  if (line === undefined || line.length === 0) throw new Error("Compiler version is empty");

  return line;
}
