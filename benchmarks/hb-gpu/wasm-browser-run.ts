import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { chromium } from "@playwright/test";

import { benchmarkRuntime } from "../runtime";
import { HB_GPU_DRAW_PINNED_VERSION } from "./schema";

const projectRoot = resolve(import.meta.dir, "../..");
const port = readPositiveInteger("--port", 4175);
const outputPath = resolve(
  projectRoot,
  readArgument("--output") ??
    `benchmarks/hb-gpu/results/hb-gpu-draw-wasm-browser-${HB_GPU_DRAW_PINNED_VERSION}.json`,
);
const url = `http://127.0.0.1:${String(port)}/benchmarks/hb-gpu/wasm-browser.html`;
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
  await page.waitForFunction(() => window.__hbGpuWasmBrowser?.done === true, undefined, {
    timeout: 30_000,
  });
  const state = await page.evaluate(() => window.__hbGpuWasmBrowser);
  if (state === undefined) throw new Error("Hb GPU Wasm browser state is unavailable");
  if (state.error !== undefined) throw new Error(state.error);
  if (state.result === undefined) throw new Error("Hb GPU Wasm browser result is unavailable");

  const packageMetadata = (await Bun.file(resolve(projectRoot, "package.json")).json()) as {
    readonly version: string;
  };
  const sourceArtifact = `benchmarks/hb-gpu/results/hb-gpu-draw-native-${HB_GPU_DRAW_PINNED_VERSION}.json`;
  const provenanceFile = "src/hb-gpu/wasm/provenance.json";
  const artifact = {
    schemaVersion: 1,
    benchmark: "hb-gpu-draw-wasm-browser",
    packageVersion: packageMetadata.version,
    capturedAt: new Date().toISOString(),
    runtime: benchmarkRuntime(),
    browser: {
      engine: "chrome",
      version: browser.version(),
      headless: true,
      viewport: { width: 320, height: 180 },
    },
    sourceArtifact,
    sourceArtifactSha256: await sha256File(resolve(projectRoot, sourceArtifact)),
    provenanceFile,
    provenanceSha256: await sha256File(resolve(projectRoot, provenanceFile)),
    sourceSha256: {
      html: await sha256File(resolve(import.meta.dir, "wasm-browser.html")),
      browser: await sha256File(resolve(import.meta.dir, "wasm-browser.ts")),
      worker: await sha256File(resolve(projectRoot, "src/hb-gpu/worker.ts")),
      runtime: await sha256File(resolve(projectRoot, "src/hb-gpu/HbGpuWasmRuntime.ts")),
      shim: await sha256File(resolve(projectRoot, "src/hb-gpu/native/hb-gpu-encoder.cc")),
      build: await sha256File(resolve(projectRoot, "scripts/build-hb-gpu-wasm.ts")),
    },
    command: "bun benchmarks/hb-gpu/wasm-browser-run.ts",
    result: state.result,
    consoleMessages,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await Bun.write(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
  await runCommand(["bunx", "oxfmt", outputPath]);
  console.log(
    JSON.stringify({
      outputPath,
      status: artifact.result.decision.status,
      reasons: artifact.result.decision.reasons,
      wasmRawBytes: artifact.result.wasm.rawBytes,
      wasmGzipBytes: artifact.result.wasm.gzipBytes,
      coldStartMs: artifact.result.coldEncodeMs[0],
      warmP50Ms: artifact.result.warmEncodeMs.p50,
      warmP95Ms: artifact.result.warmEncodeMs.p95,
      warmGlyphsPerSecond: artifact.result.warmGlyphsPerSecond,
      parityHash: artifact.result.parity.actualHash,
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
  const process = Bun.spawn([...argv], {
    cwd: projectRoot,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${argv[0] ?? "process"} exited with ${String(exitCode)}: ${stderr.trim()}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);

  return hasher.digest("hex");
}
