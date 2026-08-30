import { expect, test, type Page } from "@playwright/test";

import type { BrowserFixtureResult } from "../../benchmarks/browser/fixtures";
import { hasWebGpuAdapter } from "./webgpu-support";

interface GpuSceneV2FixtureState {
  readonly done: boolean;
  readonly result?: Readonly<BrowserFixtureResult>;
  readonly pixels?: Readonly<{
    readonly count: number;
    readonly alphaSum: number;
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  }>;
  readonly error?: string;
}

test("records two real-renderer GPU Scene v2 phases and timer-query capability", async ({
  page,
}) => {
  const webGpuAvailable = await hasWebGpuAdapter(page);
  const submittedGlyphs = new Map<"webgl" | "webgpu", number>();
  const pixelProfiles = new Map<
    "webgl" | "webgpu",
    NonNullable<GpuSceneV2FixtureState["pixels"]>
  >();
  for (const renderer of ["webgl", "webgpu"] as const) {
    if (renderer === "webgpu" && !webGpuAvailable) continue;
    const state = await loadFixture(page, renderer);
    expect(state.error).toBeUndefined();
    const result = state.result;
    expect(result).toBeDefined();
    if (result === undefined) throw new Error("GPU Scene v2 fixture returned no result");
    expect(state.pixels).toBeDefined();
    const pixels = state.pixels;
    if (pixels === undefined) throw new Error("GPU Scene v2 fixture returned no pixels");
    expect(pixels.count).toBeGreaterThan(100);
    expect(pixels.alphaSum).toBeGreaterThan(10_000);
    pixelProfiles.set(renderer, pixels);
    expect(result.counters.residentLabels).toBe(20_000);
    expect(result.counters.submittedGlyphs).toBeGreaterThan(0);
    submittedGlyphs.set(renderer, result.counters.submittedGlyphs ?? 0);
    expect(result.invariants.submittedGlyphsReadback).toBe(true);
    expect(result.counters.submittedGlyphsSource).toBe(
      renderer === "webgpu" && result.counters.cullPath === "compute-cull"
        ? "gpu-indirect-readback"
        : "cpu-submit",
    );
    expect(result.counters.drawCalls).toBeGreaterThan(0);
    expect(result.timings.phases?.camera.frameMs).toHaveLength(2);
    expect(result.timings.phases?.positionMutation.frameMs).toHaveLength(2);
    expect(result.timings.phases?.positionMutation.mutationMs).toHaveLength(2);
    const phases = result.timings.phases;
    expect(phases).toBeDefined();
    if (phases === undefined) throw new Error("GPU Scene v2 phase telemetry is missing");
    for (const phase of [phases.camera, phases.positionMutation]) {
      expect(phase.visibilitySelectionMs).toHaveLength(2);
      expect(phase.renderPreparationMs).toHaveLength(2);
      expect(phase.renderCoordinatorMs).toHaveLength(2);
      expect(phase.surfaceApplyMs).toHaveLength(2);
      expect(phase.offscreenInspectedLabels).toHaveLength(2);
      expect(phase.offscreenMaterializedLabels).toHaveLength(2);
      expect(phase.offscreenAdmissionDeferred).toHaveLength(2);
      expect(Math.max(...phase.offscreenInspectedLabels)).toBeLessThanOrEqual(2_048);
      expect(Math.max(...phase.offscreenMaterializedLabels)).toBeLessThanOrEqual(2_048);
      expect(
        phase.offscreenMaterializedLabels.every(
          (count, index) => count <= (phase.offscreenInspectedLabels[index] ?? -1),
        ),
      ).toBe(true);
      expect(phase.admittedLabelsTotal).toBe(
        phase.offscreenMaterializedLabels.reduce((sum, count) => sum + count, 0),
      );
      expect(phase.shapedLabelsDelta).toBeGreaterThanOrEqual(0);
    }
    expect(result.counters.offscreenMaxInspectedLabels).toBeLessThanOrEqual(2_048);
    expect(result.counters.offscreenMaxMaterializedLabels).toBeLessThanOrEqual(2_048);
    expect(result.invariants.offscreenInspectionWithinBudget).toBe(true);
    expect(result.invariants.offscreenMaterializationWithinBudget).toBe(true);
    expect(result.invariants.offscreenMaterializationWithinInspection).toBe(true);
    expect(result.invariants.viewportFrameEvents).toBe(6);
    expect(result.invariants.viewportCommits).toBeGreaterThanOrEqual(6);
    expect(result.counters.coalescedEvents).toBeGreaterThanOrEqual(6);
    expect(result.timings.gpuTiming?.renderer).toBe(renderer);
    if (renderer === "webgpu" && result.timings.gpuTiming?.supported === true) {
      expect(result.timings.gpuTiming).toMatchObject({
        method: "timestamp-query",
        timestampWrites: true,
        resolveQuerySet: true,
        readback: true,
      });
    }
    if (renderer === "webgl" && result.timings.gpuTiming?.supported === true) {
      expect(result.timings.gpuTiming).toMatchObject({
        method: "ext-disjoint-timer-query-webgl2",
        timerQuery: true,
        readback: true,
      });
    }
  }
  if (webGpuAvailable) {
    expect(submittedGlyphs.get("webgpu")).toBe(submittedGlyphs.get("webgl"));
    const webglPixels = pixelProfiles.get("webgl");
    const webgpuPixels = pixelProfiles.get("webgpu");
    if (webglPixels === undefined || webgpuPixels === undefined) {
      throw new Error("GPU Scene v2 cross-renderer pixels are missing");
    }
    expect(relativeDifference(webglPixels.count, webgpuPixels.count)).toBeLessThan(0.05);
    expect(relativeDifference(webglPixels.alphaSum, webgpuPixels.alphaSum)).toBeLessThan(0.05);
    expect(Math.abs(webglPixels.minX - webgpuPixels.minX)).toBeLessThanOrEqual(1);
    expect(Math.abs(webglPixels.maxX - webgpuPixels.maxX)).toBeLessThanOrEqual(1);
    expect(Math.abs(webglPixels.minY - webgpuPixels.minY)).toBeLessThanOrEqual(1);
    expect(Math.abs(webglPixels.maxY - webgpuPixels.maxY)).toBeLessThanOrEqual(1);
  }
});

function relativeDifference(first: number, second: number): number {
  return Math.abs(first - second) / Math.max(first, second, 1);
}

async function loadFixture(
  page: Page,
  renderer: "webgl" | "webgpu",
): Promise<Readonly<GpuSceneV2FixtureState>> {
  await page.goto(`/tests/browser/gpu-scene-v2.html?renderer=${renderer}`);
  await page.waitForFunction(() => window.__gpuSceneV2Fixture?.done === true);

  return page.evaluate(() => window.__gpuSceneV2Fixture);
}
