import { expect, test } from "@playwright/test";

test("runs the interactive pixi-viewport position-storm playground", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto("/playground/?labels=1000000&moving=100000");
  await expect(page.locator("#state")).toHaveText("Live", { timeout: 20_000 });
  await expect(page.locator("#resident")).toHaveText("1,000,000");
  await expect(page.locator("#moving")).toHaveText("100,000");
  await expect(page.locator("#visible")).toHaveText(/^[1-9][0-9,]*$/u);

  await page.locator("#rotation").fill("25");
  await page.locator("#toggle-storm").click();
  await expect(page.locator("#toggle-storm")).toHaveText("Start position storm");
  await page.locator("#reset-camera").click();
  await expect(page.locator("#rotation")).toHaveValue("0");
  expect(errors).toEqual([]);
});
