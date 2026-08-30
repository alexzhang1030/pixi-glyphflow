import { expect, test, type Page } from "@playwright/test";

import { hasWebGpuAdapter } from "./webgpu-support";

type FixtureState = typeof window.__labelCollisionFixture;

test("keeps collision selection and rendered pixels within renderer tolerance", async ({
  page,
}) => {
  const webGpuAvailable = await hasWebGpuAdapter(page);
  const webgl = assertFixture(await loadFixture(page, "webgl"), "webgl");
  if (!webGpuAvailable) return;
  const webgpu = assertFixture(await loadFixture(page, "webgpu"), "webgpu");

  expect(webgpu.result.counters.collisionSelectionHash).toBe(
    webgl.result.counters.collisionSelectionHash,
  );
  expect(relativeDifference(webgl.pixels.count, webgpu.pixels.count)).toBeLessThan(0.05);
  expect(relativeDifference(webgl.pixels.alphaSum, webgpu.pixels.alphaSum)).toBeLessThan(0.05);
  expect(Math.abs(webgl.pixels.minX - webgpu.pixels.minX)).toBeLessThanOrEqual(1);
  expect(Math.abs(webgl.pixels.maxX - webgpu.pixels.maxX)).toBeLessThanOrEqual(1);
  expect(Math.abs(webgl.pixels.minY - webgpu.pixels.minY)).toBeLessThanOrEqual(1);
  expect(Math.abs(webgl.pixels.maxY - webgpu.pixels.maxY)).toBeLessThanOrEqual(1);
});

async function loadFixture(
  page: Page,
  renderer: "webgl" | "webgpu",
): Promise<Readonly<FixtureState>> {
  await page.goto(`/tests/browser/label-collision.html?renderer=${renderer}`);
  await page.waitForFunction(() => window.__labelCollisionFixture?.done === true);
  return page.evaluate(() => window.__labelCollisionFixture);
}

function assertFixture(
  state: Readonly<FixtureState>,
  renderer: "webgl" | "webgpu",
): Readonly<{
  result: NonNullable<FixtureState["result"]>;
  pixels: NonNullable<FixtureState["pixels"]>;
}> {
  expect(state.error).toBeUndefined();
  expect(state.result).toBeDefined();
  expect(state.pixels).toBeDefined();
  const result = state.result!;
  const pixels = state.pixels!;
  expect(result.counters.rendererAdapter).toBe(renderer);
  expect(result.counters.submittedLabels).toBeGreaterThan(0);
  expect(result.counters.submittedLabels).toBeLessThanOrEqual(512);
  expect(result.counters.submittedGlyphs).toBe(result.counters.submittedLabels * 8);
  expect(result.counters.collisionSelectionHash).toBeGreaterThan(0);
  expect(result.invariants.collisionAccountingExact).toBe(true);
  expect(pixels.count).toBeGreaterThan(100);
  expect(pixels.alphaSum).toBeGreaterThan(10_000);
  return { result, pixels };
}

function relativeDifference(first: number, second: number): number {
  return Math.abs(first - second) / Math.max(first, second, 1);
}
