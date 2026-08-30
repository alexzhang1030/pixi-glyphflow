import { expect, test } from "@playwright/test";

test("moves a shaped run from a module worker through an isolated SAB ring", async ({ page }) => {
  await page.route("**/*", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  });
  await page.goto("/tests/browser/sab-shape-transport.html");
  await page.waitForFunction(
    () =>
      (window as unknown as { readonly __sabShape?: SabShapeBrowserState }).__sabShape?.done ===
      true,
  );
  const state = await page.evaluate(
    () => (window as unknown as { readonly __sabShape: SabShapeBrowserState }).__sabShape,
  );

  expect(state.error).toBeUndefined();
  expect(state.result).toMatchObject({
    capabilitySupported: true,
    crossOriginIsolated: true,
    requestId: 91,
    zeroCopyView: true,
    clusterEndsZeroCopyView: true,
    variationKey: "wdth=92,wght=625",
    workerShaperZeroCopyView: true,
    workerShaperOwnedCopy: true,
    workerShaperBatchTexts: ["سلام glyph", "second glyph"],
  });
  expect(state.result?.sabHash).toBe(state.result?.structuredCloneHash);
});

interface SabShapeBrowserState {
  readonly done: boolean;
  readonly error?: string;
  readonly result?: {
    readonly capabilitySupported: boolean;
    readonly crossOriginIsolated: boolean;
    readonly requestId: number;
    readonly structuredCloneHash: string;
    readonly sabHash: string;
    readonly zeroCopyView: boolean;
    readonly clusterEndsZeroCopyView: boolean;
    readonly variationKey: string | undefined;
    readonly workerShaperZeroCopyView: boolean;
    readonly workerShaperOwnedCopy: boolean;
    readonly workerShaperBatchTexts: readonly string[];
  };
}
