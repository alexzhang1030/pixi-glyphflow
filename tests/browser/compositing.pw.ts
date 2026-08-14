import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { hasWebGpuAdapter } from "./webgpu-support";

test("orders z-index ties and splits blend-mode draw segments", async ({ page }, testInfo) => {
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
  await testInfo.attach("compositing-state", {
    body: JSON.stringify({ webgl, webgpu, webgpuAvailable }, undefined, 2),
    contentType: "application/json",
  });

  const webglResult = assertFixture(webgl, "webgl");
  const webgpuResult = assertFixture(webgpu, webgpuAvailable ? "webgpu" : "webgl");
  if (!webgpuAvailable) return;

  for (const state of ["blueOnTop", "redOnTop", "additive"] as const) {
    expect(relativeDifference(webglResult[state].count, webgpuResult[state].count)).toBeLessThan(
      0.08,
    );
    expect(relativeDifference(webglResult[state].redSum, webgpuResult[state].redSum)).toBeLessThan(
      0.12,
    );
    expect(
      relativeDifference(webglResult[state].blueSum, webgpuResult[state].blueSum),
    ).toBeLessThan(0.12);
  }
});

type FixtureState = typeof window.__glyphflowCompositing;
type RendererAdapter = "webgl" | "webgpu";

async function loadFixture(page: Page, renderer: RendererAdapter): Promise<FixtureState> {
  await page.goto(`/tests/browser/compositing.html?renderer=${renderer}`);
  await page.waitForFunction(() => window.__glyphflowCompositing?.done === true);
  return page.evaluate(() => window.__glyphflowCompositing);
}

function assertFixture(
  state: FixtureState,
  renderer: RendererAdapter,
): NonNullable<FixtureState["result"]> {
  expect(state.error).toBeUndefined();
  expect(state.result).toBeDefined();
  const result = state.result!;
  expect(result.rendererAdapter).toBe(renderer);
  expect(result.blueOnTop.blueSum, JSON.stringify(result)).toBeGreaterThan(
    result.blueOnTop.redSum * 5,
  );
  expect(result.redOnTop.redSum).toBeGreaterThan(result.redOnTop.blueSum * 5);
  expect(result.additive.redSum, JSON.stringify(result)).toBeGreaterThan(
    result.blueOnTop.redSum * 5,
  );
  expect(result.additive.blueSum).toBeGreaterThan(result.redOnTop.blueSum * 5);
  expect(result.initialDrawCalls).toBe(1);
  expect(result.raisedDrawCalls).toBe(2);
  expect(result.additiveDrawCalls).toBe(2);
  return result;
}

function relativeDifference(first: number, second: number): number {
  return Math.abs(first - second) / Math.max(first, second, 1);
}
