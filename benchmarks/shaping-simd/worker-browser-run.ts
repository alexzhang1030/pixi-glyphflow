import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { chromium } from "@playwright/test";

import { benchmarkRuntime } from "../runtime";

const projectRoot = resolve(import.meta.dir, "../..");
const port = readPositiveInteger("--port", 4176);
const outputPath = resolve(
  projectRoot,
  readArgument("--output") ?? "benchmarks/results/shaping-simd-worker-1.2.0.json",
);
const url = `http://127.0.0.1:${String(port)}/benchmarks/shaping-simd/worker-browser.html`;
const server = Bun.spawn(
  ["bunx", "vite", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
  {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  },
);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

try {
  await waitForServer(url, server);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => consoleMessages.push(`pageerror: ${error.message}`));
  await page.goto(url);
  await page.waitForFunction(() => window.__shapingSimdWorker?.done === true, undefined, {
    timeout: 110_000,
  });
  const state = await page.evaluate(() => window.__shapingSimdWorker);
  if (state === undefined) throw new Error("Shaping SIMD Worker browser state is unavailable");
  if (state.error !== undefined) throw new Error(state.error);
  if (state.result === undefined)
    throw new Error("Shaping SIMD Worker browser result is unavailable");

  const packageMetadata = (await Bun.file(resolve(projectRoot, "package.json")).json()) as {
    readonly version: string;
  };
  const provenanceFile = "benchmarks/shaping-simd/wasm/provenance.json";
  const provenance = (await Bun.file(resolve(projectRoot, provenanceFile)).json()) as {
    readonly harfbuzz: { readonly version: string; readonly hbGpuVersionBoundary: string };
    readonly assets: {
      readonly simd: {
        readonly wasm: string;
        readonly glue: string;
        readonly rawBytes: number;
        readonly gzipBytes: number;
      };
    };
    readonly packageDecision: {
      readonly status: string;
      readonly reason: string;
      readonly rawDeltaBytes: number;
      readonly gzipDeltaBytes: number;
    };
  };
  const packageMeasurement = await measurePackageBoundary(provenance);
  const artifact = {
    schemaVersion: 1,
    benchmark: "packaged-harfbuzz-worker-simd",
    packageVersion: packageMetadata.version,
    capturedAt: new Date().toISOString(),
    runtime: benchmarkRuntime(),
    browser: {
      engine: "chrome",
      version: browser.version(),
      headless: true,
      viewport: { width: 320, height: 180 },
    },
    sourceVersions: {
      workerShapingHarfBuzz: provenance.harfbuzz.version,
      hbGpu: provenance.harfbuzz.hbGpuVersionBoundary.split("-")[0],
      relationship: "independent",
    },
    provenanceFile,
    provenanceSha256: await sha256File(resolve(projectRoot, provenanceFile)),
    sourceSha256: {
      html: await sha256File(resolve(import.meta.dir, "worker-browser.html")),
      browser: await sha256File(resolve(import.meta.dir, "worker-browser.ts")),
      runner: await sha256File(resolve(import.meta.dir, "worker-browser-run.ts")),
      worker: await sha256File(resolve(import.meta.dir, "worker.ts")),
      scalarWorker: await sha256File(resolve(import.meta.dir, "worker-scalar.ts")),
      simdWorker: await sha256File(resolve(import.meta.dir, "worker-simd.ts")),
      runtime: await sha256File(resolve(import.meta.dir, "packaged-runtime.ts")),
      shaper: await sha256File(resolve(projectRoot, "src/shaping/HarfBuzzWorkerShaper.ts")),
      selection: await sha256File(resolve(projectRoot, "src/shaping/simd.ts")),
      build: await sha256File(resolve(projectRoot, "scripts/build-harfbuzz-shaping-wasm.ts")),
    },
    command: "bun benchmarks/shaping-simd/worker-browser-run.ts",
    packageBoundary: {
      status: provenance.packageDecision.status,
      reason: provenance.packageDecision.reason,
      defaultPackageIncludesAssets: false,
      experimentalRawDeltaBytes: provenance.packageDecision.rawDeltaBytes,
      experimentalGzipDeltaBytes: provenance.packageDecision.gzipDeltaBytes,
      measurement: packageMeasurement,
    },
    result: state.result,
    consoleMessages,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  await runCommand(["bunx", "oxfmt", outputPath]);
  console.log(
    JSON.stringify({
      outputPath,
      decision: artifact.result.report.decision,
      reasons: artifact.result.report.reasons,
      scalarSamplesMs: artifact.result.baseline.samplesMs,
      simdSamplesMs: artifact.result.variant.samplesMs,
      scalarMeanMs: artifact.result.baseline.meanMs,
      simdMeanMs: artifact.result.variant.meanMs,
      improvementMs: artifact.result.report.improvementMs,
      improvementRatio: artifact.result.report.improvementRatio,
      varianceThresholdMs: artifact.result.report.varianceThresholdMs,
      parityHash: artifact.result.parity.scalarHash,
    }),
  );
} finally {
  await browser?.close();
  server.kill();
  await server.exited;
}

async function waitForServer(
  serverUrl: string,
  process: Readonly<{ exited: Promise<number> }>,
): Promise<void> {
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    const state = await Promise.race([
      fetch(serverUrl)
        .then((response) => (response.ok ? "ready" : "pending"))
        .catch(() => "pending"),
      process.exited.then((exitCode) => `exit:${String(exitCode)}`),
    ]);
    if (state === "ready") return;
    if (state.startsWith("exit:")) throw new Error(`Vite server ${state}`);
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`Vite server did not become ready at ${serverUrl}`);
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

async function runCommand(argv: readonly string[]): Promise<void> {
  await runCommandCapture(argv);
}

async function runCommandCapture(argv: readonly string[], cwd = projectRoot): Promise<string> {
  const process = Bun.spawn([...argv], {
    cwd,
    env: { ...Bun.env, NPM_CONFIG_CACHE: "/tmp/pixi-glyphflow-npm-cache" },
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

async function sha256File(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);

  return hasher.digest("hex");
}

interface NpmPackSummary {
  readonly size: number;
  readonly unpackedSize: number;
  readonly entryCount: number;
}

async function measurePackageBoundary(provenance: {
  readonly assets: { readonly simd: { readonly wasm: string; readonly glue: string } };
}): Promise<Readonly<Record<string, unknown>>> {
  const current = await npmPackSummary(projectRoot);
  const stagingDirectory = await mkdtemp(resolve(tmpdir(), "pixi-glyphflow-shaping-pack-"));
  try {
    await Promise.all([
      cp(resolve(projectRoot, "package.json"), resolve(stagingDirectory, "package.json")),
      cp(resolve(projectRoot, "README.md"), resolve(stagingDirectory, "README.md")),
      cp(resolve(projectRoot, "CHANGELOG.md"), resolve(stagingDirectory, "CHANGELOG.md")),
      cp(resolve(projectRoot, "docs"), resolve(stagingDirectory, "docs"), { recursive: true }),
      cp(resolve(projectRoot, "dist"), resolve(stagingDirectory, "dist"), { recursive: true }),
    ]);
    const candidateDirectory = resolve(stagingDirectory, "dist/shaping/wasm");
    await mkdir(resolve(candidateDirectory, "simd"), { recursive: true });
    const wasmRoot = resolve(projectRoot, "benchmarks/shaping-simd/wasm");
    await Promise.all([
      cp(
        resolve(wasmRoot, provenance.assets.simd.wasm),
        resolve(candidateDirectory, provenance.assets.simd.wasm),
      ),
      cp(
        resolve(wasmRoot, provenance.assets.simd.glue),
        resolve(candidateDirectory, provenance.assets.simd.glue),
      ),
      cp(resolve(wasmRoot, "provenance.json"), resolve(candidateDirectory, "provenance.json")),
      cp(
        resolve(wasmRoot, "LICENSE.harfbuzz.txt"),
        resolve(candidateDirectory, "LICENSE.harfbuzz.txt"),
      ),
    ]);
    const hypotheticalOptIn = await npmPackSummary(stagingDirectory);
    const optionalWasmPath = resolve(projectRoot, "node_modules/harfbuzzjs/dist/harfbuzz.wasm");
    const [optionalWasm, simdWasm, simdGlue] = await Promise.all([
      Bun.file(optionalWasmPath).bytes(),
      Bun.file(resolve(wasmRoot, provenance.assets.simd.wasm)).bytes(),
      Bun.file(resolve(wasmRoot, provenance.assets.simd.glue)).bytes(),
    ]);
    const experimentalRuntimeRawBytes = simdWasm.byteLength + simdGlue.byteLength;
    const experimentalRuntimeGzipBytes = gzipBytes(simdWasm) + gzipBytes(simdGlue);

    return Object.freeze({
      method: "npm-pack-dry-run-json-with-staged-dist-shaping-wasm",
      current,
      hypotheticalOptIn,
      delta: Object.freeze({
        tarballBytes: hypotheticalOptIn.size - current.size,
        unpackedBytes: hypotheticalOptIn.unpackedSize - current.unpackedSize,
        entries: hypotheticalOptIn.entryCount - current.entryCount,
      }),
      existingOptionalShapingAsset: Object.freeze({
        package: "harfbuzzjs@1.6.0",
        wasmRawBytes: optionalWasm.byteLength,
        wasmGzipBytes: gzipBytes(optionalWasm),
      }),
      experimentalRuntimePayload: Object.freeze({
        wasmAndGlueRawBytes: experimentalRuntimeRawBytes,
        wasmAndGlueGzipBytes: experimentalRuntimeGzipBytes,
        rawBytesVersusExistingWasm: experimentalRuntimeRawBytes - optionalWasm.byteLength,
        gzipBytesVersusExistingWasm: experimentalRuntimeGzipBytes - gzipBytes(optionalWasm),
      }),
    });
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }
}

async function npmPackSummary(cwd: string): Promise<Readonly<NpmPackSummary>> {
  const output = await runCommandCapture(["npm", "pack", "--dry-run", "--json"], cwd);
  const parsed = JSON.parse(output) as readonly NpmPackSummary[];
  const summary = parsed[0];
  if (summary === undefined) throw new Error("npm pack returned no package summary");

  return Object.freeze({
    size: summary.size,
    unpackedSize: summary.unpackedSize,
    entryCount: summary.entryCount,
  });
}

function gzipBytes(bytes: Uint8Array<ArrayBufferLike>): number {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);

  return Bun.gzipSync(copy, { level: 9 }).byteLength;
}
