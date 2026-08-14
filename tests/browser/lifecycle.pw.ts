import { expect, test, type Page } from "@playwright/test";

import { hasWebGpuAdapter } from "./webgpu-support";

test("isolates sibling layers, applications, detach, reattach, and destruction", async ({
  page,
}, testInfo) => {
  const states: LifecycleState[] = [];
  let webgpuAvailable = false;
  for (const renderer of ["webgl", "webgpu"] as const) {
    const state = await loadFixture(page, renderer);
    states.push(state);
    if (renderer === "webgl") webgpuAvailable = await hasWebGpuAdapter(page);
    expect(state.error).toBeUndefined();
    expect(state.result).toBeDefined();
    const result = state.result!;
    expect(result).toMatchObject({
      rendererAdapter: renderer === "webgpu" && !webgpuAvailable ? "webgl" : renderer,
      primaryRevision: 1,
      reattachedRevision: 1,
      primaryInitialChildren: 1,
      detachedChildren: 0,
      reattachedChildren: 1,
      primaryDestroyed: true,
      primaryRemovedFromStage: true,
    });
    expect(result.siblingBeforePixels).toBeGreaterThan(500);
    expect(result.siblingAfterDetachPixels).toBe(result.siblingBeforePixels);
    expect(result.siblingAfterDestroyPixels).toBe(result.siblingBeforePixels);
    expect(result.remoteBeforePixels).toBeGreaterThan(500);
    expect(result.remoteAfterApplicationDestroyPixels).toBe(result.remoteBeforePixels);
  }
  await testInfo.attach("lifecycle-state", {
    body: JSON.stringify({ states, webgpuAvailable }, undefined, 2),
    contentType: "application/json",
  });
});

type LifecycleState = typeof window.__glyphflowLifecycle;

async function loadFixture(page: Page, renderer: "webgl" | "webgpu"): Promise<LifecycleState> {
  await page.goto(`/tests/browser/lifecycle.html?renderer=${renderer}`);
  await page.waitForFunction(() => window.__glyphflowLifecycle?.done === true);
  return page.evaluate(() => window.__glyphflowLifecycle);
}
