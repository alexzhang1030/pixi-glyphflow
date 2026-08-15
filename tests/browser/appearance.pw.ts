import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { hasWebGpuAdapter } from "./webgpu-support";

test("renders appearance controls consistently across WebGL and WebGPU", async ({
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
  await testInfo.attach("appearance-state", {
    body: JSON.stringify({ webgl, webgpu, webgpuAvailable }, undefined, 2),
    contentType: "application/json",
  });

  const webglResult = assertFixture(webgl, "webgl");
  const webgpuResult = assertFixture(webgpu, webgpuAvailable ? "webgpu" : "webgl");
  if (!webgpuAvailable) return;

  for (const state of [
    "base",
    "bold",
    "vertical",
    "effects",
    "transformed",
    "translucent",
  ] as const) {
    expect(relativeDifference(webglResult[state].count, webgpuResult[state].count)).toBeLessThan(
      0.08,
    );
    expect(Math.abs(webglResult[state].centroidX - webgpuResult[state].centroidX)).toBeLessThan(1);
    expect(Math.abs(webglResult[state].maxAlpha - webgpuResult[state].maxAlpha)).toBeLessThan(4);
  }
});

type FixtureState = typeof window.__glyphflowAppearance;
type RendererAdapter = "webgl" | "webgpu";

async function loadFixture(page: Page, renderer: RendererAdapter): Promise<FixtureState> {
  await page.goto(`/tests/browser/appearance.html?renderer=${renderer}`);
  await page.waitForFunction(() => window.__glyphflowAppearance?.done === true);
  return page.evaluate(() => window.__glyphflowAppearance);
}

function assertFixture(
  state: FixtureState,
  renderer: RendererAdapter,
): NonNullable<FixtureState["result"]> {
  expect(state.error).toBeUndefined();
  expect(state.result).toBeDefined();
  const result = state.result!;
  expect(result.rendererAdapter).toBe(renderer);
  expect(result.base.count).toBeGreaterThan(500);
  expect(result.base.maxAlpha).toBeGreaterThan(245);
  expect(result.bold.count).toBeGreaterThan(result.base.count * 1.05);
  expect(result.vertical.maxY - result.vertical.minY).toBeGreaterThan(
    (result.vertical.maxX - result.vertical.minX) * 1.4,
  );
  expect(result.effects.count).toBeGreaterThan(result.base.count);
  expect(result.effects.redDominant).toBeGreaterThan(100);
  expect(result.effects.greenDominant).toBeGreaterThan(50);
  expect(result.effects.blueDominant).toBeGreaterThan(15);
  expect(result.effects.maxAlpha, JSON.stringify(result)).toBeLessThanOrEqual(130);
  expect(result.transformed.count).toBeGreaterThan(result.base.count * 1.05);
  expect(result.transformed.centroidX).toBeGreaterThan(120);
  expect(result.transformed.centroidX).toBeLessThan(210);
  expect(result.translucent.maxAlpha).toBeGreaterThan(55);
  expect(result.translucent.maxAlpha).toBeLessThan(70);
  expect(result.hidden.count).toBe(0);
  return result;
}

function relativeDifference(first: number, second: number): number {
  return Math.abs(first - second) / Math.max(first, second, 1);
}
