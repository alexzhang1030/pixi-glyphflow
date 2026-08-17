import type { Application, Renderer, WebGPURenderer } from "pixi.js";

export interface CompletedFrameSample {
  readonly frameMs: number;
  readonly cpuMs: number;
  readonly gpuMs: number;
}

/** Render one frame and wait for GPU completion, reporting CPU and GPU separately. */
export async function completeFrame(app: Application): Promise<CompletedFrameSample> {
  const cpuStart = performance.now();
  app.render();
  const afterCpu = performance.now();
  await finishGpu(app.renderer);
  const afterGpu = performance.now();

  return Object.freeze({
    cpuMs: afterCpu - cpuStart,
    gpuMs: afterGpu - afterCpu,
    frameMs: afterGpu - cpuStart,
  });
}

export async function finishGpu(renderer: Renderer): Promise<void> {
  if ("gl" in renderer) {
    renderer.gl.finish();
    return;
  }
  const device = "gpu" in renderer ? (renderer as WebGPURenderer).gpu?.device : undefined;
  if (device !== undefined) {
    await device.queue.onSubmittedWorkDone();
  }
}
