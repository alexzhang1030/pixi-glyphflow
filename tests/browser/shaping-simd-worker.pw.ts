import { expect, test } from "@playwright/test";

test("measures packaged scalar and SIMD HarfBuzz through real module workers", async ({ page }) => {
  test.setTimeout(120_000);
  const messages: string[] = [];
  page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));

  await page.goto("/benchmarks/shaping-simd/worker-browser.html");
  await page.waitForFunction(() => window.__shapingSimdWorker?.done === true, undefined, {
    timeout: 110_000,
  });
  const state = await page.evaluate(() => window.__shapingSimdWorker);

  expect(state?.error).toBeUndefined();
  expect(state?.result?.capability.supported).toBe(true);
  expect(state?.result?.corpora).toEqual(["cjkv", "arabic", "devanagari", "hebrew", "thai"]);
  expect(state?.result?.parity).toMatchObject({
    exact: true,
    scalarHash: state?.result?.parity.simdHash,
  });
  expect(state?.result?.baseline.samplesMs).toHaveLength(5);
  expect(state?.result?.variant.samplesMs).toHaveLength(5);
  expect(state?.result?.workers).toEqual({ scalar: 5, simd: 5 });
  expect(state?.result?.report.baselineHash).toBe(state?.result?.report.variantHash);
  expect(state?.result?.report.improvementMs).toBe(
    (state?.result?.baseline.meanMs ?? 0) - (state?.result?.variant.meanMs ?? 0),
  );
  expect(messages.filter((message) => !message.startsWith("debug: [vite]"))).toEqual([]);
});
