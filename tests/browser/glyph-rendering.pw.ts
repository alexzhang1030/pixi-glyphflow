import { expect, test } from "@playwright/test";

test("renders glyph meshes, uploads transform-only moves, and survives reattachment", async ({
  page,
}, testInfo) => {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  await page.goto("/tests/browser/glyph-rendering.html");
  await page.waitForFunction(() => window.__glyphflow?.done === true);
  const state = await page.evaluate(() => window.__glyphflow);
  await testInfo.attach("browser-console", {
    body: messages.join("\n"),
    contentType: "text/plain",
  });
  await testInfo.attach("fixture-state", {
    body: JSON.stringify(state, undefined, 2),
    contentType: "application/json",
  });

  expect(state.error).toBeUndefined();
  expect(state.result).toBeDefined();
  const result = state.result!;
  expect(result.initialPixels).toBeGreaterThan(500);
  expect(result.movedPixels).toBeGreaterThan(500);
  expect(result.reattachedPixels).toBeGreaterThan(500);
  expect(result.initialStats).toMatchObject({
    rendererAdapter: "webgl",
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
    rendererAdapter: "webgl",
    drawCalls: 1,
    submittedGlyphs: 17,
  });
});
