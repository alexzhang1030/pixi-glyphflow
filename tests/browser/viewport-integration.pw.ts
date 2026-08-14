import { expect, test } from "@playwright/test";

test("binds real pixi-viewport interaction storms and 100k position updates", async ({ page }) => {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  await page.goto("/tests/browser/viewport-integration.html");
  await page.waitForFunction(() => window.__glyphflowViewport?.done === true, undefined, {
    timeout: 20_000,
  });
  const state = await page.evaluate(() => window.__glyphflowViewport);

  expect(state.error, messages.join("\n")).toBeUndefined();
  expect(state.result).toBeDefined();
  const result = state.result!;
  expect(result.labelCount).toBe(100_000);
  expect(result.initialRevision).toBe(1);
  expect(result.cameraRevision).toBe(result.initialRevision);
  expect(result.positionRevision).toBe(2);
  expect(result.initialVisible).toBeGreaterThan(0);
  expect(result.initialVisible).toBeLessThan(result.labelCount);
  expect(result.finalVisible).toBeGreaterThan(0);
  expect(result.finalVisible).toBeLessThan(result.labelCount);
  expect(result.stormEvents).toBe(2_000);
  expect(result.coalescedEvents).toBeGreaterThanOrEqual(1_999);
  expect(result.positionUpdates).toBe(100_000);
  expect(result.positionUpdateDurationMs).toBeLessThan(5_000);
  expect(result.pluginEvents.drag).toBeGreaterThan(0);
  expect(result.pluginEvents.decelerate).toBeGreaterThan(0);
  expect(result.pluginEvents.wheel).toBeGreaterThan(0);
  expect(result.pluginEvents.pinch).toBeGreaterThan(0);
  expect(result.pluginsInstalled).toEqual(["drag", "decelerate", "wheel", "pinch"]);
  expect(result.rotatedBoundsFinite).toBe(true);
  expect(result.listenerCounts.bound).toEqual(
    result.listenerCounts.baseline.map((count) => count + 1),
  );
  expect(result.listenerCounts.destroyed).toEqual(result.listenerCounts.baseline);
  expect(result.listenerCounts.released).toEqual(result.listenerCounts.plugins);
  expect(result.layerRemoved).toBe(true);
});
