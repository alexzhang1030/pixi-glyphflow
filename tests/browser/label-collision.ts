import { Application } from "pixi.js";

import type { BrowserFixtureResult } from "../../benchmarks/browser/fixtures";
import { requestBenchmarkWebGpu } from "../../benchmarks/browser/timing";
import { runGlyphflowWorkload } from "../../benchmarks/browser/workloads";
import type { BrowserBenchmarkConfiguration } from "../../benchmarks/schema";
import { measureCanvasPixelProfile, type PixelProfile } from "./pixels";

interface LabelCollisionFixtureState {
  readonly done: boolean;
  readonly result?: Readonly<BrowserFixtureResult>;
  readonly pixels?: Readonly<PixelProfile>;
  readonly error?: string;
}

declare global {
  interface Window {
    __labelCollisionFixture: LabelCollisionFixtureState;
  }
}

window.__labelCollisionFixture = { done: false };

void run().catch((error: unknown) => {
  window.__labelCollisionFixture = {
    done: true,
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  };
});

async function run(): Promise<void> {
  const requestedRenderer =
    new URL(window.location.href).searchParams.get("renderer") === "webgpu" ? "webgpu" : "webgl";
  const gpu =
    requestedRenderer === "webgpu"
      ? await requestBenchmarkWebGpu({ powerPreference: "high-performance" })
      : undefined;
  const app = new Application();
  await app.init({
    width: 320,
    height: 180,
    backgroundAlpha: 0,
    antialias: false,
    preference: requestedRenderer,
    preferWebGLVersion: 2,
    preserveDrawingBuffer: true,
    ...(gpu === undefined ? {} : { gpu }),
  });
  app.stop();
  document.body.append(app.canvas);
  const configuration: BrowserBenchmarkConfiguration = Object.freeze({
    fixture: "glyphflow",
    workload: "label-collision",
    renderer: requestedRenderer,
    labelCount: 20_000,
    mutationCount: 1,
    warmupFrames: 1,
    sampleFrames: 2,
    width: 320,
    height: 180,
  });
  const result = await runGlyphflowWorkload(app, configuration);
  const pixels = await measureCanvasPixelProfile(app.canvas, 320, 180);
  window.__labelCollisionFixture = { done: true, result, pixels };
  app.destroy();
}
