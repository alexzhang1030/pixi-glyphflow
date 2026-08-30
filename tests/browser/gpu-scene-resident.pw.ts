import { expect, test, type Page } from "@playwright/test";

import type { BrowserFixtureResult } from "../../benchmarks/browser/fixtures";
import { GPU_SCENE_RESIDENT_CANONICAL_TRUTH } from "../../benchmarks/gpu-scene-resident-truth";
import { hasWebGpuAdapter } from "./webgpu-support";

interface GpuSceneResidentFixtureState {
  readonly done: boolean;
  readonly result?: Readonly<BrowserFixtureResult>;
  readonly error?: string;
}

test("keeps the real WebGPU scene resident across camera and position phases", async ({ page }) => {
  await page.goto("/tests/browser/gpu-scene-resident.html?probe=1");
  test.skip(!(await hasWebGpuAdapter(page)), "WebGPU adapter unavailable");
  const state = await loadFixture(page);
  expect(state.error).toBeUndefined();
  const result = state.result;
  expect(result).toBeDefined();
  if (result === undefined) throw new Error("GPU-resident fixture returned no result");
  const expected = GPU_SCENE_RESIDENT_CANONICAL_TRUTH.browserSmoke;

  expect(result.counters).toMatchObject({
    residentLabels: 100_000,
    gpuResidentLabels: 100_000,
    prototypeCount: 1,
    submittedLabels: 5_000,
    submittedGlyphs: 5_000,
    submittedGlyphsSource: "gpu-indirect-readback",
    submittedGlyphsHashSource: "gpu-instances-out-readback",
    drawCalls: 1,
    drawCallsSource: "logical-mesh-count",
    observedDrawCalls: 0,
    observedDrawCallsSource: "unavailable-webgpu",
    rendererAdapter: "webgpu",
    cullPath: "compute-cull",
    palettePath: "storage",
    residencyRequested: "gpu-scene",
    residencyActive: "gpu-scene",
    frameTransactionSubmissions: 6,
    frameTransactionFusedSubmissions: 6,
    frameTransactionStandaloneSubmissions: 0,
    diagnosticReadbackSubmissions: 2,
    timestampReadbackSubmissions: 6,
    timestampFusedResolves: 6,
    timestampStandaloneSubmissions: 0,
  });
  expect(result.counters.residencyFallbackReason).toBeUndefined();
  expect(result.counters.submittedGlyphsHash).toBe(expected.output.submittedGlyphsHash);
  expect(result.counters.renderedPixelHash).toBe(expected.output.renderedPixelHash);
  expect(result.counters.renderedPixelHashRepeat).toBe(result.counters.renderedPixelHash);
  expect(result.counters.nonTransparentPixels).toBe(expected.output.nonTransparentPixels);
  expect(result.counters.nonTransparentPixelsRepeat).toBe(result.counters.nonTransparentPixels);

  const phases = result.timings.phases;
  expect(phases).toBeDefined();
  if (phases === undefined) throw new Error("GPU-resident phase telemetry is missing");
  expect(phases.camera.frameMs).toHaveLength(2);
  expect(phases.positionMutation.frameMs).toHaveLength(2);
  expect(phases.camera.frameBudgetMs).toBe(16.67);
  expect(phases.camera.frameOverBudgetCount).toBe(
    phases.camera.frameMs.filter((sample) => sample > 16.67).length,
  );
  expect(phases.positionMutation.frameBudgetMs).toBe(16.67);
  expect(phases.positionMutation.frameOverBudgetCount).toBe(
    phases.positionMutation.frameMs.filter((sample) => sample > 16.67).length,
  );
  expect(phases.camera.shapedLabelsDelta).toBe(0);
  expect(phases.positionMutation.shapedLabelsDelta).toBe(0);
  expect(phases.camera.admittedLabelsTotal).toBe(0);
  expect(phases.positionMutation.admittedLabelsTotal).toBe(0);
  expect(phases.camera.cullingQueriesDelta).toBe(0);
  expect(phases.positionMutation.cullingQueriesDelta).toBe(0);
  expect(phases.camera.transformUploadBytes).toEqual([0, 0]);
  expect(phases.camera.cullRecordUploadBytes).toEqual([0, 0]);
  expect(phases.positionMutation.transformUploadBytes).toEqual([80_016, 80_016]);
  expect(phases.positionMutation.cullRecordUploadBytes).toEqual([0, 0]);
  expect(phases.camera.frameTransactionSubmissionDeltas).toEqual([1, 1]);
  expect(phases.camera.frameTransactionFusedSubmissionDeltas).toEqual([1, 1]);
  expect(phases.camera.frameTransactionStandaloneSubmissionDeltas).toEqual([0, 0]);
  expect(phases.positionMutation.frameTransactionSubmissionDeltas).toEqual([1, 1]);
  expect(phases.positionMutation.frameTransactionFusedSubmissionDeltas).toEqual([1, 1]);
  expect(phases.positionMutation.frameTransactionStandaloneSubmissionDeltas).toEqual([0, 0]);
  expect(result.invariants.submittedCountExact).toBe(true);
  expect(result.invariants.submittedHashStable).toBe(true);
  expect(result.invariants.submittedGlyphsReadback).toBe(true);
  expect(result.invariants.pixelsRendered).toBe(true);
  expect(result.invariants.pixelReadbackRepeatable).toBe(true);
  expect(result.invariants.canonicalOutputConfigurationKnown).toBe(true);
  expect(result.invariants.canonicalSubmittedIdentity).toBe(true);
  expect(result.invariants.canonicalRenderedPixelHash).toBe(true);
  expect(result.invariants.canonicalNonTransparentPixels).toBe(true);
  expect(result.invariants.canonicalOutputIdentity).toBe(true);
  expect(result.invariants.cameraProductSubmissionExact).toBe(true);
  expect(result.invariants.cameraFusedSubmissionExact).toBe(true);
  expect(result.invariants.cameraStandaloneSubmissionZero).toBe(true);
  expect(result.invariants.positionProductSubmissionExact).toBe(true);
  expect(result.invariants.positionFusedSubmissionExact).toBe(true);
  expect(result.invariants.positionStandaloneSubmissionZero).toBe(true);
  expect(result.invariants.timestampFusedResolveExact).toBe(true);
  expect(result.invariants.timestampStandaloneSubmissionZero).toBe(true);
  expect(result.timings.gpuTiming).toMatchObject({
    renderer: "webgpu",
    method: "timestamp-query",
    timestampWrites: true,
    resolveQuerySet: true,
    readback: true,
    fusedTimestampResolves: 6,
    standaloneTimestampSubmissions: 0,
  });
});

async function loadFixture(page: Page): Promise<Readonly<GpuSceneResidentFixtureState>> {
  await page.goto("/tests/browser/gpu-scene-resident.html");
  await page.waitForFunction(() => window.__gpuSceneResidentFixture?.done === true);
  return page.evaluate(() => window.__gpuSceneResidentFixture);
}
