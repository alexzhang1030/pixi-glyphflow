import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { chromium } from "@playwright/test";
import { createServer } from "vite";

import {
  BENCHMARK_SCHEMA_VERSION,
  benchmarkRuntime,
  summarize,
  type BrowserBenchmarkFixture,
  type BrowserBenchmarkPageState,
  type BrowserBenchmarkSample,
  type BrowserBenchmarkWorkload,
} from "./schema";

const projectRoot = resolve(import.meta.dir, "..");
const packageMetadata = (await Bun.file(resolve(projectRoot, "package.json")).json()) as {
  readonly version: string;
};
const options = readOptions();
const fixtures: readonly BrowserBenchmarkFixture[] =
  options.fixture === undefined
    ? ["text", "bitmap-text", "glyphflow", "html-text"]
    : [options.fixture];
const server = await createServer({
  root: projectRoot,
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
const address = server.httpServer?.address();
if (address === null || address === undefined || typeof address === "string") {
  throw new Error("Vite benchmark server address is unavailable");
}
const samples: BrowserBenchmarkSample[] = [];
const failures: Array<{
  readonly fixture: BrowserBenchmarkFixture;
  readonly status: "capacity-limit";
  readonly detail: string;
}> = [];

try {
  for (const fixture of fixtures) {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));
      const parameters = new URLSearchParams({
        fixture,
        workload: options.workload,
        renderer: options.renderer,
        labels: String(options.labels),
        mutations: String(options.mutations),
        warmup: String(options.warmupFrames),
        frames: String(options.sampleFrames),
      });
      await page.goto(
        `http://127.0.0.1:${String(address.port)}/playground/benchmark.html?${parameters.toString()}`,
      );
      await withTimeout(
        page.waitForFunction(() => window.__glyphflowBenchmark?.done === true, undefined, {
          timeout: options.timeoutMs,
        }),
        options.timeoutMs,
        `${fixture} benchmark exceeded ${String(options.timeoutMs)} ms`,
      );
      const state = await page.evaluate(
        () => window.__glyphflowBenchmark as BrowserBenchmarkPageState,
      );
      if (state.error !== undefined || state.result === undefined || errors.length > 0) {
        throw new Error(
          [
            state.error,
            state.result === undefined ? "Browser benchmark returned no result" : undefined,
            ...errors,
          ]
            .filter((line): line is string => line !== undefined && line.length > 0)
            .join("\n"),
        );
      }
      samples.push(state.result as BrowserBenchmarkSample);
    } catch (error: unknown) {
      failures.push({
        fixture,
        status: "capacity-limit",
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}

const artifact = {
  schemaVersion: BENCHMARK_SCHEMA_VERSION,
  benchmark: "browser-workloads",
  packageVersion: packageMetadata.version,
  capturedAt: new Date().toISOString(),
  runtime: benchmarkRuntime(),
  workload: options.workload,
  status: failures.length === 0 ? "complete" : "capacity-limit",
  samples,
  failures,
  summaries: Object.fromEntries(
    samples.map((sample) => [
      sample.configuration.fixture,
      {
        setup: summarize([sample.timings.setupMs], "ms"),
        frame: summarize(sample.timings.frameMs, "ms"),
      },
    ]),
  ),
};
const outputPath = resolve(
  import.meta.dir,
  `results/browser-${options.workload}-${packageMetadata.version}.json`,
);
await mkdir(dirname(outputPath), { recursive: true });
await Bun.write(outputPath, `${JSON.stringify(artifact, undefined, 2)}\n`);
console.log(
  JSON.stringify({
    outputPath,
    workload: options.workload,
    fixtures: samples.map((sample) => sample.configuration.fixture),
    failures,
    frameP95Ms: Object.fromEntries(
      samples.map((sample) => [
        sample.configuration.fixture,
        summarize(sample.timings.frameMs, "ms").p95,
      ]),
    ),
  }),
);

interface RunOptions {
  readonly workload: BrowserBenchmarkWorkload;
  readonly fixture: BrowserBenchmarkFixture | undefined;
  readonly renderer: "webgl" | "webgpu";
  readonly labels: number;
  readonly mutations: number;
  readonly warmupFrames: number;
  readonly sampleFrames: number;
  readonly timeoutMs: number;
}

function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function readOptions(): Readonly<RunOptions> {
  const workload = (readArgument("--workload") ?? "static-hud") as BrowserBenchmarkWorkload;
  const fixture = readArgument("--fixture") as BrowserBenchmarkFixture | undefined;
  const renderer = readArgument("--renderer") === "webgpu" ? "webgpu" : "webgl";
  if (
    fixture !== undefined &&
    !["text", "bitmap-text", "html-text", "glyphflow"].includes(fixture)
  ) {
    throw new TypeError(`Unknown benchmark fixture: ${fixture}`);
  }

  return Object.freeze({
    workload,
    fixture,
    renderer,
    labels: readPositiveInteger("--labels", workload === "static-hud" ? 1_000 : 1_000_000),
    mutations: readPositiveInteger("--mutations", 100_000),
    warmupFrames: readNonNegativeInteger("--warmup", 10),
    sampleFrames: readPositiveInteger("--frames", 60),
    timeoutMs: readPositiveInteger("--timeout", 120_000),
  });
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

function readNonNegativeInteger(name: string, fallback: number): number {
  const raw = readArgument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be followed by a non-negative safe integer`);
  }

  return value;
}
