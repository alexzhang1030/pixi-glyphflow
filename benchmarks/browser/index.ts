import { Application } from "pixi.js";

import {
  BENCHMARK_SCHEMA_VERSION,
  type BrowserBenchmarkConfiguration,
  type BrowserBenchmarkFixture,
  type BrowserBenchmarkPageState,
  type BrowserBenchmarkWorkload,
} from "../schema";
import { isBenchmarkWorkload } from "../workloads";
import { runStaticHudFixture } from "./fixtures";
import { runGlyphflowWorkload } from "./workloads";

declare global {
  interface Window {
    __glyphflowBenchmark: BrowserBenchmarkPageState;
  }
}

window.__glyphflowBenchmark = { done: false };

void run().catch((error: unknown) => {
  window.__glyphflowBenchmark = {
    done: true,
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  };
});

async function run(): Promise<void> {
  const configuration = readConfiguration(new URL(window.location.href).searchParams);
  const app = new Application();
  await app.init({
    width: configuration.width,
    height: configuration.height,
    backgroundAlpha: 0,
    antialias: false,
    preference: configuration.renderer,
    preferWebGLVersion: 2,
    preserveDrawingBuffer: true,
  });
  app.stop();
  document.body.append(app.canvas);

  const fixtureResult =
    configuration.workload === "static-hud"
      ? await runStaticHudFixture(app, configuration)
      : configuration.fixture === "glyphflow"
        ? await runGlyphflowWorkload(app, configuration)
        : unsupportedFixture(configuration.fixture, configuration.workload);
  const heapBytes = readHeapBytes();
  window.__glyphflowBenchmark = {
    done: true,
    result: Object.freeze({
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      kind: "pixi-glyphflow-browser-sample",
      capturedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      configuration,
      timings: fixtureResult.timings,
      counters: Object.freeze({
        ...fixtureResult.counters,
        ...(heapBytes === undefined ? {} : { heapBytes }),
      }),
      invariants: fixtureResult.invariants,
    }),
  };
}

function readConfiguration(parameters: URLSearchParams): Readonly<BrowserBenchmarkConfiguration> {
  const workload = (parameters.get("workload") ?? "static-hud") as BrowserBenchmarkWorkload;
  const fixture = (parameters.get("fixture") ?? "glyphflow") as BrowserBenchmarkFixture;
  if (!isFixture(fixture)) throw new TypeError(`Unknown benchmark fixture: ${fixture}`);
  if (!isBenchmarkWorkload(workload)) {
    throw new TypeError(`Unknown benchmark workload: ${workload}`);
  }

  return Object.freeze({
    fixture,
    workload,
    renderer: parameters.get("renderer") === "webgpu" ? "webgpu" : "webgl",
    labelCount: readPositiveInteger(parameters, "labels", 1_000),
    mutationCount: readPositiveInteger(parameters, "mutations", 100_000),
    warmupFrames: readNonNegativeInteger(parameters, "warmup", 10),
    sampleFrames: readPositiveInteger(parameters, "frames", 60),
    width: readPositiveInteger(parameters, "width", 1_280),
    height: readPositiveInteger(parameters, "height", 800),
  });
}

function readPositiveInteger(parameters: URLSearchParams, name: string, fallback: number): number {
  const raw = parameters.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }

  return value;
}

function readNonNegativeInteger(
  parameters: URLSearchParams,
  name: string,
  fallback: number,
): number {
  const raw = parameters.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }

  return value;
}

function isFixture(value: string): value is BrowserBenchmarkFixture {
  return ["bitmap-text", "glyphflow", "html-text", "text"].includes(value);
}

function unsupportedFixture(
  fixture: BrowserBenchmarkFixture,
  workload: BrowserBenchmarkWorkload,
): never {
  throw new RangeError(`${fixture} does not implement the ${workload} workload`);
}

function readHeapBytes(): number | undefined {
  const memory = performance as Performance & { memory?: { usedJSHeapSize: number } };
  return memory.memory?.usedJSHeapSize;
}
