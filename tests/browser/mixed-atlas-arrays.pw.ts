import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { hasWebGpuAdapter } from "./webgpu-support";

test("uploads TinySDF and color glyphs through both atlas arrays", async ({ page }, testInfo) => {
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
  await testInfo.attach("mixed-atlas-state", {
    body: JSON.stringify({ webgl, webgpu, webgpuAvailable }, undefined, 2),
    contentType: "application/json",
  });

  assertFixture(webgl, "webgl");
  assertFixture(webgpu, webgpuAvailable ? "webgpu" : "webgl");
});

type FixtureState = typeof window.__glyphflowMixedAtlas;
type RendererAdapter = "webgl" | "webgpu";

async function loadFixture(page: Page, renderer: RendererAdapter): Promise<FixtureState> {
  await page.goto(`/tests/browser/mixed-atlas-arrays.html?renderer=${renderer}`);
  await page.waitForFunction(() => window.__glyphflowMixedAtlas?.done === true);
  return page.evaluate(() => window.__glyphflowMixedAtlas);
}

function assertFixture(state: FixtureState, renderer: RendererAdapter): void {
  expect(state.error, state.error).toBeUndefined();
  expect(state.result).toBeDefined();
  const result = state.result!;
  expect(result.rendererAdapter).toBe(renderer);
  expect(result.pixels).toBeGreaterThan(200);
  expect(result.drawCalls).toBe(1);
  // Tiny 256² pages plus emoji force at least two R layers (or R + RGBA).
  expect(result.atlasTextureCount).toBeGreaterThanOrEqual(2);
  expect(result.atlasTextureCount).toBeLessThanOrEqual(32);
}
