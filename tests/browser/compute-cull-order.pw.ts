import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { hasWebGpuAdapter } from "./webgpu-support";

test("keeps WebGPU compute cull after instance ranges leave draw order", async ({ page }) => {
  const webgpuAvailable = await hasWebGpuAdapter(page);
  const webgl = await loadFixture(page, "webgl");
  assertFixture(webgl, "webgl");

  const webgpu = await loadFixture(page, "webgpu");
  assertFixture(webgpu, webgpuAvailable ? "webgpu" : "webgl");
});

type FixtureState = typeof window.__glyphflow;
type RendererAdapter = "webgl" | "webgpu";

async function loadFixture(page: Page, renderer: RendererAdapter): Promise<FixtureState> {
  await page.goto(`/tests/browser/compute-cull-order.html?renderer=${renderer}`);
  await page.waitForFunction(() => window.__glyphflow?.done === true);
  return page.evaluate(() => window.__glyphflow);
}

function assertFixture(state: FixtureState, renderer: RendererAdapter): void {
  expect(state.error).toBeUndefined();
  expect(state.result).toBeDefined();
  const result = state.result!;
  expect(result.rendererAdapter).toBe(renderer);
  expect(result.cullPath).toBe(renderer === "webgpu" ? "compute-cull" : "cpu-grid");
  expect(result.drawCalls).toBe(1);
  expect(result.submittedGlyphs).toBeGreaterThan(0);
}
