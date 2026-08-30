import { expect, test } from "@playwright/test";

import { hasWebGpuAdapter } from "./webgpu-support";

test("rehydrates sparse glyph strips with stable WebGPU pixels", async ({ page }, testInfo) => {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  await page.goto("/tests/browser/outline-sparse-strip.html");
  const webgpuAvailable = await hasWebGpuAdapter(page);
  await page.waitForFunction(() => window.__glyphflowSparseStrip?.done === true);
  const state = await page.evaluate(() => window.__glyphflowSparseStrip);
  await testInfo.attach("browser-console", {
    body: messages.join("\n"),
    contentType: "text/plain",
  });
  await testInfo.attach("outline-sparse-strip-state", {
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
    pixelHeights: [256, 512],
    mismatchedChannels: 0,
    stableHash: true,
    dispatchGroupCount: 2,
  });
  expect(state.result?.atlasWidth).toBeGreaterThan(0);
  expect(state.result?.atlasHeight).toBeGreaterThanOrEqual(512);
  expect(state.result?.visiblePixelsByBucket).toHaveLength(2);
  expect(state.result?.visiblePixelsByBucket[0]).toBeGreaterThan(100);
  expect(state.result?.visiblePixelsByBucket[1]).toBeGreaterThan(
    state.result?.visiblePixelsByBucket[0] ?? 0,
  );
  expect(state.result?.maxChannelDelta).toBeLessThanOrEqual(2);
  expect(state.result?.firstHash).toBe(state.result?.repeatedHash);
  expect(state.result?.maxRecordsPerTileRow).toBeGreaterThan(0);
  expect(state.result?.dispatchInvocationCount).toBeGreaterThanOrEqual(
    state.result?.effectivePixelCount ?? 0,
  );
  expect(state.result?.dispatchToEffectiveRatio).toBeLessThanOrEqual(1.15);
  expect(state.result?.allocatedBytes).toBeLessThan(state.result?.denseEquivalentBytes ?? 0);
});
