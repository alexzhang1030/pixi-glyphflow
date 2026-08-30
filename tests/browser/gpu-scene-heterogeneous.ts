import { Application } from "pixi.js";

import type { BrowserFixtureResult } from "../../benchmarks/browser/fixtures";
import { requestBenchmarkWebGpu } from "../../benchmarks/browser/timing";
import { runGlyphflowWorkload } from "../../benchmarks/browser/workloads";
import type { BrowserBenchmarkConfiguration } from "../../benchmarks/schema";

interface GpuSceneHeterogeneousFixtureState {
  readonly done: boolean;
  readonly result?: Readonly<BrowserFixtureResult>;
  readonly error?: string;
}

declare global {
  interface Window {
    __gpuSceneHeterogeneousFixture: GpuSceneHeterogeneousFixtureState;
  }
}

window.__gpuSceneHeterogeneousFixture = { done: false };

void run().catch((error: unknown) => {
  window.__gpuSceneHeterogeneousFixture = {
    done: true,
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  };
});

async function run(): Promise<void> {
  if (new URLSearchParams(window.location.search).has("probe")) {
    window.__gpuSceneHeterogeneousFixture = { done: true };
    return;
  }
  const gpu = await requestBenchmarkWebGpu({ powerPreference: "high-performance" });
  if (gpu === undefined) throw new Error("Heterogeneous GPU-scene fixture requires WebGPU");
  const app = new Application();
  await app.init({
    width: 320,
    height: 180,
    backgroundAlpha: 0,
    antialias: false,
    preference: "webgpu",
    preserveDrawingBuffer: true,
    gpu,
  });
  app.stop();
  document.body.append(app.canvas);
  const configuration: BrowserBenchmarkConfiguration = Object.freeze({
    fixture: "glyphflow",
    workload: "gpu-scene-heterogeneous-64",
    renderer: "webgpu",
    labelCount: 10_000,
    mutationCount: 1_000,
    warmupFrames: 1,
    sampleFrames: 1,
    width: 320,
    height: 180,
  });
  const result = await runGlyphflowWorkload(app, configuration);
  window.__gpuSceneHeterogeneousFixture = { done: true, result };
  app.destroy();
}
