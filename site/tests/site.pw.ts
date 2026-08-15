import { expect, test } from "@playwright/test";

test("serves the docs, runs the viewport, and fits every target width", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { level: 1, name: /Render text at scene scale/ }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();

  const demo = page.getByTestId("glyphflow-demo");
  await expect(demo).toHaveAttribute("data-demo-state", "ready");
  await expect(page.getByTestId("resident-count")).toHaveText("20,000");
  await expect(demo.locator("canvas")).toBeVisible();

  const movementButton = page.getByRole("button", { name: "Pause movement" });
  await movementButton.click();
  await expect(page.getByRole("button", { name: "Start movement" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  const canvas = demo.locator(".demo-canvas");
  const bounds = await canvas.boundingBox();
  expect(bounds).toBeTruthy();
  if (bounds !== null) {
    await page.mouse.move(bounds.x + bounds.width * 0.65, bounds.y + bounds.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.35, bounds.y + bounds.height * 0.35, {
      steps: 6,
    });
    await page.mouse.up();
  }

  const rotation = page.getByRole("slider", { name: "Rotation" });
  await rotation.fill("18");
  await expect(demo.locator("output")).toHaveText("18°");
  await page.getByRole("button", { name: "Reset camera" }).click();
  await expect(demo.locator("output")).toHaveText("0°");

  const themeToggle = page.getByTestId("theme-toggle");
  const initialTheme = await themeToggle.getAttribute("aria-pressed");
  await themeToggle.click();
  await expect(themeToggle).not.toHaveAttribute("aria-pressed", initialTheme ?? "false");

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1024, height: 900 },
    { width: 768, height: 900 },
    { width: 320, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.locator("body")).toBeVisible();
    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasHorizontalOverflow, `horizontal overflow at ${viewport.width}px`).toBe(false);
  }

  expect(consoleErrors).toEqual([]);
});

test("honors reduced motion and exposes keyboard controls", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const demo = page.getByTestId("glyphflow-demo");
  await expect(demo).toHaveAttribute("data-demo-state", "ready");
  await expect(page.getByRole("button", { name: "Start movement" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  const canvas = demo.locator(".demo-canvas");
  await canvas.focus();
  await expect(canvas).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("+");
  await page.keyboard.press("0");
  await expect(page.getByRole("button", { name: "Reset camera" })).toBeEnabled();
});
