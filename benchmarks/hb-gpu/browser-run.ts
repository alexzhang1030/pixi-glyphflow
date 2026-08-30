import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { chromium } from "@playwright/test";

import { benchmarkRuntime } from "../runtime";
import { HB_GPU_DRAW_PINNED_VERSION } from "./schema";

const projectRoot = resolve(import.meta.dir, "../..");
const port = readPositiveInteger("--port", 4174);
const outputPath = resolve(
  projectRoot,
  readArgument("--output") ??
    `benchmarks/hb-gpu/results/hb-gpu-draw-browser-${HB_GPU_DRAW_PINNED_VERSION}.json`,
);
const url = `http://127.0.0.1:${String(port)}/benchmarks/hb-gpu/browser.html`;
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
  await page.waitForFunction(() => window.__hbGpuPackedBrowser?.done === true, undefined, {
    timeout: 30_000,
  });
  const state = await page.evaluate(() => window.__hbGpuPackedBrowser);
  if (state === undefined) throw new Error("Hb GPU packed browser state is unavailable");
  if (state.error !== undefined) throw new Error(state.error);
  if (state.result === undefined) throw new Error("Hb GPU packed browser result is unavailable");
  const packageMetadata = (await Bun.file(resolve(projectRoot, "package.json")).json()) as {
    readonly version: string;
  };
  const sourceArtifactPath = resolve(
    projectRoot,
    `benchmarks/hb-gpu/results/hb-gpu-draw-native-${HB_GPU_DRAW_PINNED_VERSION}.json`,
  );
  const sourceArtifactBytes = new Uint8Array(await Bun.file(sourceArtifactPath).arrayBuffer());
  const sourceArtifactHasher = new Bun.CryptoHasher("sha256");
  sourceArtifactHasher.update(sourceArtifactBytes);
  const browserSourceSha256 = await sha256File(resolve(import.meta.dir, "browser.ts"));
  const packedRuntimeSha256 = await sha256File(resolve(import.meta.dir, "packed-runtime.ts"));
  const artifact = {
    schemaVersion: 1,
    benchmark: "hb-gpu-draw-browser",
    packageVersion: packageMetadata.version,
    capturedAt: new Date().toISOString(),
    runtime: benchmarkRuntime(),
    browser: {
      engine: "chrome",
      version: browser.version(),
      headless: true,
      viewport: { width: 320, height: 180 },
    },
    sourceArtifact: `benchmarks/hb-gpu/results/hb-gpu-draw-native-${HB_GPU_DRAW_PINNED_VERSION}.json`,
    sourceArtifactSha256: sourceArtifactHasher.digest("hex"),
    benchmarkSourcesSha256: {
      browser: browserSourceSha256,
      packedRuntime: packedRuntimeSha256,
    },
    command: "bun benchmarks/hb-gpu/browser-run.ts",
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
      adapter: artifact.result.capability.adapterInfo,
      packedPixelHash: artifact.result.packed?.pixelHash,
      packedMaskHash: artifact.result.packed?.maskHash,
      packedGpuTimingNs: artifact.result.packed?.gpuTimingNs,
      rgba16sintStatus: artifact.result.rgba16sint?.status,
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

function readPositiveInteger(name: string, fallback: number): number {
  const raw = readArgument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be followed by a positive safe integer`);
  }
  return value;
}
