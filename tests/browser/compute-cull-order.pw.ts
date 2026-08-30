import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { hasWebGpuAdapter } from "./webgpu-support";

test("keeps WebGPU compute cull after instance ranges leave draw order", async ({
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
  await testInfo.attach("compute-cull-order-state", {
    body: JSON.stringify({ webgl, webgpu, webgpuAvailable }, undefined, 2),
    contentType: "application/json",
  });

  expect(
    messages.filter((message) => /createBindGroup|Required member is undefined/i.test(message)),
  ).toEqual([]);
  assertFixture(webgl, "webgl");
  assertFixture(webgpu, webgpuAvailable ? "webgpu" : "webgl");
});

type FixtureState = typeof window.__glyphflowComputeCullOrder;
type RendererAdapter = "webgl" | "webgpu";

async function loadFixture(page: Page, renderer: RendererAdapter): Promise<FixtureState> {
  await page.goto(`/tests/browser/compute-cull-order.html?renderer=${renderer}`);
  await page.waitForFunction(() => window.__glyphflowComputeCullOrder?.done === true);
  return page.evaluate(() => window.__glyphflowComputeCullOrder);
}

function assertFixture(state: FixtureState, renderer: RendererAdapter): void {
  expect(state.error).toBeUndefined();
  expect(state.result).toMatchObject({
    rendererAdapter: renderer,
    cullPath: renderer === "webgpu" ? "compute-cull" : "cpu-grid",
    drawCalls: 1,
  });
  expect(state.result?.palettePath === "texture" || state.result?.palettePath === "storage").toBe(
    true,
  );
  if (renderer === "webgl") expect(state.result?.palettePath).toBe("texture");
  expect(state.result?.submittedGlyphs).toBeGreaterThan(0);
}
