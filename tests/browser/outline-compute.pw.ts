import { expect, test } from "@playwright/test";

import { hasWebGpuAdapter } from "./webgpu-support";

test("compiles outline compute and matches the packed-curve pixel golden", async ({
  page,
}, testInfo) => {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  await page.goto("/tests/browser/outline-compute.html");
  const webgpuAvailable = await hasWebGpuAdapter(page);
  await page.waitForFunction(() => window.__glyphflowOutlineCompute?.done === true);
  const state = await page.evaluate(() => window.__glyphflowOutlineCompute);
  await testInfo.attach("browser-console", {
    body: messages.join("\n"),
    contentType: "text/plain",
  });
  await testInfo.attach("outline-compute-state", {
    body: JSON.stringify({ state, webgpuAvailable }, undefined, 2),
    contentType: "application/json",
  });

  expect(state.error, state.error).toBeUndefined();
  if (!webgpuAvailable) {
    expect(state.result).toMatchObject({ capability: "unsupported", status: "unsupported" });
    return;
  }
  expect(messages.filter((message) => /shader|validation|pipeline/i.test(message))).toEqual([]);
  expect(state.result).toMatchObject({
    capability: "supported",
    status: "ready",
    entryCount: 2,
    fragmentCompiled: true,
    mismatchedChannels: 0,
    outlineSourceCalls: 2,
    sharedBatchTexture: true,
    productionAdapter: "webgpu",
    productionGlyphs: 1,
  });
  expect(state.result?.atlasWidth).toBeGreaterThan(0);
  expect(state.result?.atlasHeight).toBeGreaterThan(0);
  expect(state.result?.visiblePixels).toBeGreaterThan(100);
  expect(state.result?.productionPixels).toBeGreaterThan(100);
  expect(state.result?.productionAtlasUploadBytes).toBeGreaterThan(0);
  expect(state.result?.maxChannelDelta).toBeLessThanOrEqual(2);
  expect(state.result?.coldRasterMs).toBeGreaterThanOrEqual(0);
  expect(state.result?.rasterP50Ms).toBeGreaterThanOrEqual(0);
  expect(state.result?.rasterP95Ms).toBeGreaterThanOrEqual(state.result?.rasterP50Ms ?? 0);
});
