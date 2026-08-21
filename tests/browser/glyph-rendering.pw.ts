import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { hasWebGpuAdapter } from "./webgpu-support";

test("renders glyph meshes, uploads transform-only moves, and survives reattachment", async ({
  page,
}, testInfo) => {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  const webgl = await loadFixture(page, "webgl");
  const webgpuAvailable = await hasWebGpuAdapter(page);
  const webgpu = await loadFixture(page, "webgpu");
  await testInfo.attach("browser-console", {
    body: messages.join("\n"),
    contentType: "text/plain",
  });
  await testInfo.attach("fixture-state", {
    body: JSON.stringify({ webgl, webgpu, webgpuAvailable }, undefined, 2),
    contentType: "application/json",
  });

  const webglResult = assertFixture(webgl, "webgl");
  const webgpuResult = assertFixture(webgpu, webgpuAvailable ? "webgpu" : "webgl");
  if (!webgpuAvailable) return;

  expect(relativeDifference(webglResult.initialPixels, webgpuResult.initialPixels)).toBeLessThan(
    0.05,
  );
  expect(relativeDifference(webglResult.movedPixels, webgpuResult.movedPixels)).toBeLessThan(0.05);
  expect(
    relativeDifference(webglResult.reattachedPixels, webgpuResult.reattachedPixels),
  ).toBeLessThan(0.05);
  expect(Math.abs(webglResult.initialCentroidX - webgpuResult.initialCentroidX)).toBeLessThan(1);
  expect(Math.abs(webglResult.movedCentroidX - webgpuResult.movedCentroidX)).toBeLessThan(1);
});

type FixtureState = typeof window.__glyphflow;
type RendererAdapter = "webgl" | "webgpu";

async function loadFixture(page: Page, renderer: RendererAdapter): Promise<FixtureState> {
  await page.goto(`/tests/browser/glyph-rendering.html?renderer=${renderer}`);
  await page.waitForFunction(() => window.__glyphflow?.done === true);
  return page.evaluate(() => window.__glyphflow);
}

function assertFixture(
  state: FixtureState,
  renderer: RendererAdapter,
): NonNullable<FixtureState["result"]> {
  expect(state.error).toBeUndefined();
  expect(state.result).toBeDefined();
  const result = state.result!;
  expect(result.initialPixels).toBeGreaterThan(500);
  expect(result.movedPixels).toBeGreaterThan(500);
  expect(result.reattachedPixels).toBeGreaterThan(500);
  expect(result.initialStats).toMatchObject({
    rendererAdapter: renderer,
    cullPath: renderer === "webgpu" ? "compute-cull" : "cpu-grid",
    drawCalls: 1,
    submittedGlyphs: 17,
    atlasTextureCount: 1,
  });
  expect(result.movedStats.instanceUploadBytes).toBe(result.initialStats.instanceUploadBytes);
  expect(Number(result.movedStats.transformUploadBytes)).toBeGreaterThan(
    Number(result.initialStats.transformUploadBytes),
  );
  expect(result.reattachedStats).toMatchObject({
    revision: 2,
    rendererAdapter: renderer,
    cullPath: renderer === "webgpu" ? "compute-cull" : "cpu-grid",
    drawCalls: 1,
    submittedGlyphs: 17,
  });
  expect(result.movedCentroidX - result.initialCentroidX).toBeGreaterThan(25);
  expect(Math.abs(result.reattachedCentroidX - result.movedCentroidX)).toBeLessThan(1);
  return result;
}

function relativeDifference(first: number, second: number): number {
  return Math.abs(first - second) / Math.max(first, second, 1);
}
