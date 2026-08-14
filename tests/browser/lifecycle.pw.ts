import { expect, test, type Page } from "@playwright/test";

test("isolates sibling layers, applications, detach, reattach, and destruction", async ({
  page,
}) => {
  for (const renderer of ["webgl", "webgpu"] as const) {
    const state = await loadFixture(page, renderer);
    expect(state.error).toBeUndefined();
    expect(state.result).toBeDefined();
    const result = state.result!;
    expect(result).toMatchObject({
      rendererAdapter: renderer,
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
});

type LifecycleState = typeof window.__glyphflowLifecycle;

async function loadFixture(page: Page, renderer: "webgl" | "webgpu"): Promise<LifecycleState> {
  await page.goto(`/tests/browser/lifecycle.html?renderer=${renderer}`);
  await page.waitForFunction(() => window.__glyphflowLifecycle?.done === true);
  return page.evaluate(() => window.__glyphflowLifecycle);
}
