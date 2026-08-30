import { Application } from "pixi.js";

import type { BrowserFixtureResult } from "../../benchmarks/browser/fixtures";
import { requestBenchmarkWebGpu } from "../../benchmarks/browser/timing";
import { runGlyphflowWorkload } from "../../benchmarks/browser/workloads";
import type { BrowserBenchmarkConfiguration } from "../../benchmarks/schema";

interface GpuSceneResidentFixtureState {
  readonly done: boolean;
  readonly result?: Readonly<BrowserFixtureResult>;
  readonly error?: string;
}

declare global {
  interface Window {
    __gpuSceneResidentFixture: GpuSceneResidentFixtureState;
  }
}

window.__gpuSceneResidentFixture = { done: false };

void run().catch((error: unknown) => {
  window.__gpuSceneResidentFixture = {
    done: true,
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  };
});

async function run(): Promise<void> {
  if (new URLSearchParams(window.location.search).has("probe")) {
    window.__gpuSceneResidentFixture = { done: true };
    return;
  }
  const gpu = await requestBenchmarkWebGpu({ powerPreference: "high-performance" });
  if (gpu === undefined) throw new Error("GPU-resident fixture requires WebGPU");
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
    workload: "gpu-scene-resident",
    renderer: "webgpu",
    labelCount: 100_000,
    mutationCount: 10_000,
    warmupFrames: 1,
    sampleFrames: 2,
    width: 320,
    height: 180,
  });
  const result = await runGlyphflowWorkload(app, configuration);
  window.__gpuSceneResidentFixture = { done: true, result };
  app.destroy();
}
