import { expect, test, type Page } from "@playwright/test";

import type { BrowserFixtureResult } from "../../benchmarks/browser/fixtures";
import { GPU_SCENE_RESIDENT_CANONICAL_TRUTH } from "../../benchmarks/gpu-scene-resident-truth";
import { hasWebGpuAdapter } from "./webgpu-support";

interface FixtureState {
  readonly done: boolean;
  readonly result?: Readonly<BrowserFixtureResult>;
  readonly error?: string;
}

test("keeps both resident fill shaders byte-identical to the formal general reference", async ({
  page,
  context,
}) => {
  test.setTimeout(120_000);
  await page.goto("/tests/browser/gpu-scene-resident.html?probe=1");
  test.skip(!(await hasWebGpuAdapter(page)), "WebGPU adapter unavailable");

  const residentSingle = await loadFormalFixture(page, "product");
  const residentMultiPage = await context.newPage();
  const residentMulti = await loadFormalFixture(residentMultiPage, "resident-fill");
  await residentMultiPage.close();
  const generalPage = await context.newPage();
  const general = await loadFormalFixture(generalPage, "general");
  await generalPage.close();

  expect(residentSingle.error).toBeUndefined();
  expect(residentMulti.error).toBeUndefined();
  expect(general.error).toBeUndefined();
  expect(residentSingle.result).toBeDefined();
  expect(residentMulti.result).toBeDefined();
  expect(general.result).toBeDefined();
  const residentSingleResult = residentSingle.result;
  const residentMultiResult = residentMulti.result;
  const generalResult = general.result;
  if (
    residentSingleResult === undefined ||
    residentMultiResult === undefined ||
    generalResult === undefined
  ) {
    throw new Error("Formal GPU-resident reference fixture returned no result");
  }

  const expected = GPU_SCENE_RESIDENT_CANONICAL_TRUTH.formal.output;
  expect(residentSingleResult.counters).toMatchObject({
    submittedGlyphs: expected.submittedGlyphs,
    submittedGlyphsHash: expected.submittedGlyphsHash,
    renderedPixelHash: expected.renderedPixelHash,
    renderedPixelHashRepeat: expected.renderedPixelHash,
    nonTransparentPixels: expected.nonTransparentPixels,
    nonTransparentPixelsRepeat: expected.nonTransparentPixels,
  });
  expect(residentMultiResult.counters).toMatchObject({
    submittedGlyphs: residentSingleResult.counters.submittedGlyphs,
    submittedGlyphsHash: residentSingleResult.counters.submittedGlyphsHash,
    renderedPixelHash: residentSingleResult.counters.renderedPixelHash,
    renderedPixelHashRepeat: residentSingleResult.counters.renderedPixelHashRepeat,
    nonTransparentPixels: residentSingleResult.counters.nonTransparentPixels,
    nonTransparentPixelsRepeat: residentSingleResult.counters.nonTransparentPixelsRepeat,
  });
  expect(generalResult.counters).toMatchObject({
    submittedGlyphs: residentSingleResult.counters.submittedGlyphs,
    submittedGlyphsHash: residentSingleResult.counters.submittedGlyphsHash,
    renderedPixelHash: residentSingleResult.counters.renderedPixelHash,
    renderedPixelHashRepeat: residentSingleResult.counters.renderedPixelHashRepeat,
    nonTransparentPixels: residentSingleResult.counters.nonTransparentPixels,
    nonTransparentPixelsRepeat: residentSingleResult.counters.nonTransparentPixelsRepeat,
  });
  expectExactPositionUploads(residentSingleResult);
  expectExactPositionUploads(residentMultiResult);
  expectExactPositionUploads(generalResult);
});

function expectExactPositionUploads(result: Readonly<BrowserFixtureResult>): void {
  const position = result.timings.phases?.positionMutation;
  expect(position).toBeDefined();
  if (position === undefined) throw new Error("Formal position phase telemetry is missing");
  expect(position.transformUploadBytes).toHaveLength(120);
  expect(position.transformUploadBytes?.every((bytes) => bytes === 800_016)).toBe(true);
  expect(position.cullRecordUploadBytes).toHaveLength(120);
  expect(position.cullRecordUploadBytes?.every((bytes) => bytes === 0)).toBe(true);
}

async function loadFormalFixture(
  page: Page,
  variant: "product" | "resident-fill" | "general",
): Promise<FixtureState> {
  if (variant !== "product") {
    await page.route("**/src/render/PixiRendererBackend.ts*", async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      const target =
        'return residentPrototypeGlyphs === 1 ? "resident-fill-single" : "resident-fill";';
      expect(source).toContain(target);
      await route.fulfill({
        response,
        body: source.replace(target, `return "${variant}";`),
      });
    });
  }
  await page.route("**/tests/browser/gpu-scene-resident.ts*", async (route) => {
    const response = await route.fetch();
    let source = await response.text();
    const replacements = [
      ["width: 320", "width: 1280"],
      ["height: 180", "height: 800"],
      ["labelCount: 1e5", "labelCount: 1e6"],
      ["mutationCount: 1e4", "mutationCount: 1e5"],
      ["warmupFrames: 1", "warmupFrames: 10"],
      ["sampleFrames: 2", "sampleFrames: 120"],
    ] as const;
    for (const [before, after] of replacements) {
      expect(source).toContain(before);
      source = source.replaceAll(before, after);
    }
    await route.fulfill({ response, body: source });
  });
  await page.goto("/tests/browser/gpu-scene-resident.html");
  await page.waitForFunction(() => window.__gpuSceneResidentFixture?.done === true);
  return page.evaluate<FixtureState>(() => window.__gpuSceneResidentFixture);
}
