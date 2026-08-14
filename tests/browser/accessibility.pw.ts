import { expect, test } from "@playwright/test";

test("mirrors selected labels incrementally with bounds, visibility, and focus order", async ({
  page,
}) => {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));
  await page.goto("/tests/browser/accessibility.html");
  await page.waitForFunction(() => window.__glyphflowAccessibility?.done === true);
  const state = await page.evaluate(() => window.__glyphflowAccessibility);

  expect(state.error, messages.join("\n")).toBeUndefined();
  expect(state.result).toBeDefined();
  const result = state.result!;
  expect(result.initialFirst).toMatchObject({
    text: "Primary action",
    role: "button",
    label: "Open primary action",
    tabIndex: 2,
    lang: "en",
    hidden: false,
    ariaHidden: "false",
  });
  expect(result.initialSecond).toMatchObject({
    text: "Documentation",
    role: "link",
    description: "Opens the project documentation",
    tabIndex: 1,
    hidden: false,
  });
  expect(result.boundsMatch).toBe(true);
  expect(result.updatedFirst.text).toBe("Primary action updated");
  expect(result.updatedFirst.left).toBeGreaterThan(result.initialFirst.left);
  expect(result.firstElementStable).toBe(true);
  expect(result.hiddenSecond.hidden).toBe(true);
  expect(result.hiddenSecond.ariaHidden).toBe("true");
  expect(result.restoredSecond.hidden).toBe(false);
  expect(result.restoredSecond.ariaHidden).toBe("false");
  expect(result.noOpUpdates).toBe(0);
  expect(result.removedMirrorCount).toBe(1);
  expect(result.stats).toMatchObject({
    selectedLabels: 2,
    mirroredLabels: 2,
    createdElements: 3,
    removedElements: 1,
    destroyed: false,
  });

  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Tab");
  expect(await focusedTextId(page)).toBe(result.secondId);
  await page.keyboard.press("Tab");
  expect(await focusedTextId(page)).toBe(result.firstId);

  const destroyed = await page.evaluate(() => window.__glyphflowAccessibility.destroy?.());
  expect(destroyed).toEqual({ overlays: 0, mirrors: 0 });
});

async function focusedTextId(page: import("@playwright/test").Page): Promise<string | undefined> {
  return page.evaluate(
    () => (document.activeElement as HTMLElement | null)?.dataset.pixiGlyphflowTextId,
  );
}
