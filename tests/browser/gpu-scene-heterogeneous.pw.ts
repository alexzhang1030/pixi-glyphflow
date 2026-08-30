import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import type { BrowserFixtureResult } from "../../benchmarks/browser/fixtures";
import { hasWebGpuAdapter } from "./webgpu-support";

interface GpuSceneHeterogeneousFixtureState {
  readonly done: boolean;
  readonly result?: Readonly<BrowserFixtureResult>;
  readonly error?: string;
}

test("keeps the 10K heterogeneous scene on the resident bridge", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/tests/browser/gpu-scene-heterogeneous.html?probe=1");
  test.skip(!(await hasWebGpuAdapter(page)), "WebGPU adapter unavailable");

  const result = requireResult(await loadFixture(page));
  expect(result.counters).toMatchObject({
    residentLabels: 10_000,
    gpuResidentLabels: 10_000,
    prototypeCount: 64,
    paintCount: 8,
    prototypePaintPairCount: 512,
    gpuScenePerLabelObjectCount: 0,
    collisionEnabled: false,
    submittedGlyphsSource: "gpu-indirect-readback",
    submittedGlyphsHashSource: "gpu-instances-out-readback",
    expectedSubmittedGlyphsSource: "cpu-prototype-bounds",
    drawCalls: 1,
    drawCallsSource: "logical-mesh-count",
    rendererAdapter: "webgpu",
    cullPath: "compute-cull",
    palettePath: "storage",
    residencyRequested: "gpu-scene",
    residencyActive: "gpu-scene",
    deferredSpatialLabels: 1_000,
    cullRecordUploadBytes: 320_000,
    frameTransactionSubmissions: 4,
    frameTransactionFusedSubmissions: 4,
    frameTransactionStandaloneSubmissions: 0,
    diagnosticReadbackSubmissions: 2,
    timestampReadbackSubmissions: 4,
    timestampFusedResolves: 4,
    timestampStandaloneSubmissions: 0,
  });
  expect(result.counters.residencyFallbackReason).toBeUndefined();
  expect(result.counters.frameTransactionCumulativeSubmissions).toBeGreaterThanOrEqual(4);
  expect(result.counters.frameTransactionCumulativeFusedSubmissions).toBeGreaterThanOrEqual(4);
  expect(result.counters.frameTransactionCumulativeStandaloneSubmissions).toBe(0);
  expect(result.counters.cameraSubmittedGlyphs).toBe(result.counters.expectedCameraSubmittedGlyphs);
  expect(result.counters.cameraSubmittedGlyphsHash).toBe(
    result.counters.expectedCameraSubmittedGlyphsHash,
  );
  expect(result.counters.submittedGlyphs).toBe(result.counters.expectedSubmittedGlyphs);
  expect(result.counters.submittedGlyphsHash).toBe(result.counters.expectedSubmittedGlyphsHash);
  expect(result.counters.renderedPixelHashRepeat).toBe(result.counters.renderedPixelHash);
  expect(result.counters.nonTransparentPixelsRepeat).toBe(result.counters.nonTransparentPixels);
  expect(result.counters.nonTransparentPixels).toBeGreaterThan(0);
  expect(result.invariants).toMatchObject({
    prototypePaintInterleaveExact: true,
    gpuScenePerLabelObjectCountZero: true,
    collisionDisabled: true,
    expectedSubmittedIdentity: true,
    cameraExpectedSubmittedIdentity: true,
    positionExpectedSubmittedIdentity: true,
    pixelReadbackRepeatable: true,
    cameraShapedDeltaZero: true,
    positionShapedDeltaZero: true,
    cameraAdmittedDeltaZero: true,
    positionAdmittedDeltaZero: true,
    cameraCullingQueriesDeltaZero: true,
    positionCullingQueriesDeltaZero: true,
    timestampSegmentedExact: true,
    timestampSegmentsValid: true,
  });

  const phases = result.timings.phases;
  expect(phases).toBeDefined();
  if (phases === undefined) throw new Error("Heterogeneous phase telemetry is missing");
  expect(phases.camera.transformUploadBytes).toEqual([0]);
  expect(phases.camera.cullRecordUploadBytes).toEqual([0]);
  expect(phases.positionMutation.transformUploadBytes).toEqual([8_016]);
  expect(phases.positionMutation.cullRecordUploadBytes).toEqual([0]);
  expect(phases.camera.frameTransactionSubmissionDeltas).toEqual([1]);
  expect(phases.camera.frameTransactionFusedSubmissionDeltas).toEqual([1]);
  expect(phases.camera.frameTransactionStandaloneSubmissionDeltas).toEqual([0]);
  expect(phases.positionMutation.frameTransactionSubmissionDeltas).toEqual([1]);
  expect(phases.positionMutation.frameTransactionFusedSubmissionDeltas).toEqual([1]);
  expect(phases.positionMutation.frameTransactionStandaloneSubmissionDeltas).toEqual([0]);
});

test("cross-proves CPU identity and general-shader pixels across two repetitions", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await page.goto("/tests/browser/gpu-scene-heterogeneous.html?probe=1");
  test.skip(!(await hasWebGpuAdapter(page)), "WebGPU adapter unavailable");

  const first = requireResult(await loadFixture(page));
  const secondPage = await context.newPage();
  const second = requireResult(await loadFixture(secondPage));
  await secondPage.close();
  const generalPage = await generalReferencePage(context);
  const general = requireResult(await loadFixture(generalPage));
  await generalPage.close();

  for (const result of [first, second, general]) {
    expect(result.invariants.expectedSubmittedIdentity).toBe(true);
    expect(result.counters.cameraSubmittedGlyphs).toBe(
      result.counters.expectedCameraSubmittedGlyphs,
    );
    expect(result.counters.cameraSubmittedGlyphsHash).toBe(
      result.counters.expectedCameraSubmittedGlyphsHash,
    );
    expect(result.counters.submittedGlyphs).toBe(result.counters.expectedSubmittedGlyphs);
    expect(result.counters.submittedGlyphsHash).toBe(result.counters.expectedSubmittedGlyphsHash);
  }
  const identity = {
    cameraSubmittedGlyphs: first.counters.cameraSubmittedGlyphs,
    cameraSubmittedGlyphsHash: first.counters.cameraSubmittedGlyphsHash,
    submittedGlyphs: first.counters.submittedGlyphs,
    submittedGlyphsHash: first.counters.submittedGlyphsHash,
    renderedPixelHash: first.counters.renderedPixelHash,
    nonTransparentPixels: first.counters.nonTransparentPixels,
  };
  expect(second.counters).toMatchObject(identity);
  expect(general.counters).toMatchObject(identity);
});

async function generalReferencePage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.route("**/src/render/PixiRendererBackend.ts*", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const target =
      'return residentPrototypeGlyphs === 1 ? "resident-fill-single" : "resident-fill";';
    expect(source).toContain(target);
    await route.fulfill({ response, body: source.replace(target, 'return "general";') });
  });
  return page;
}

function requireResult(
  state: Readonly<GpuSceneHeterogeneousFixtureState>,
): Readonly<BrowserFixtureResult> {
  expect(state.error).toBeUndefined();
  expect(state.result).toBeDefined();
  if (state.result === undefined) throw new Error("Heterogeneous fixture returned no result");
  return state.result;
}

async function loadFixture(page: Page): Promise<Readonly<GpuSceneHeterogeneousFixtureState>> {
  await page.goto("/tests/browser/gpu-scene-heterogeneous.html");
  await page.waitForFunction(() => window.__gpuSceneHeterogeneousFixture?.done === true);
  return page.evaluate(() => window.__gpuSceneHeterogeneousFixture);
}
