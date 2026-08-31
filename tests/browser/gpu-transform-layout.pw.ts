import { expect, test } from "@playwright/test";

import { hasWebGpuAdapter } from "./webgpu-support";

for (const variant of ["single", "run", "heterogeneous"]) {
  test(`matches general rendering for ${variant} rotation, movement, and layout deltas`, async ({
    page,
  }) => {
    await page.goto("/tests/browser/gpu-transform-layout.html?probe=1");
    test.skip(!(await hasWebGpuAdapter(page)), "WebGPU adapter unavailable");
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`/tests/browser/gpu-transform-layout.html?variant=${variant}`);
    await page.waitForFunction(() => window.__gpuTransformLayout.done);
    const state = await page.evaluate(() => window.__gpuTransformLayout);
    expect(state.error).toBeUndefined();
    expect(errors).toEqual([]);
    expect(state.comparisons).toHaveLength(10);
    for (const frame of state.comparisons!) {
      expect(frame.residency, frame.phase).toBe("gpu-scene");
      expect(frame.differentBytes, frame.phase).toBe(0);
      if (frame.phase === "offscreen") expect(frame.nonTransparentPixels).toBe(0);
      else expect(frame.nonTransparentPixels, frame.phase).toBeGreaterThan(0);
      if (
        ["packed-transform", "sparse-position", "mixed-position-rotation"].includes(frame.phase)
      ) {
        expect(frame.recordBytes, frame.phase).toBe(0);
        expect(frame.instanceBytes, frame.phase).toBe(0);
      }
      if (frame.phase === "packed-transform") expect(frame.transformBytes).toBe(3 * 12 + 16);
      if (frame.phase === "sparse-position") expect(frame.transformBytes).toBe(2 * 12 + 16);
      if (frame.phase === "cached-wrap-return") expect(frame.instanceBytes).toBe(0);
    }
  });
}

test("sustains compact transforms and bounded wrap deltas with all labels submitted", async ({
  page,
}) => {
  await page.goto("/tests/browser/gpu-transform-layout.html?probe=1");
  test.skip(!(await hasWebGpuAdapter(page)), "WebGPU adapter unavailable");
  await page.goto(
    "/tests/browser/gpu-transform-layout.html?stress=1&labels=10000&movers=1000&frames=120",
  );
  await page.waitForFunction(() => window.__gpuTransformLayout.done);
  const state = await page.evaluate(() => window.__gpuTransformLayout);
  expect(state.error).toBeUndefined();
  expect(state.stress?.phases).toHaveLength(3);
  for (const phase of state.stress!.phases) {
    expect(phase.residency).toBe("gpu-scene");
    expect(phase.frameMs.samples).toHaveLength(120);
    expect(phase.submittedGlyphs).toBe(phase.phase === "wrap" ? 11000 : 10000);
    if (phase.phase === "wrap") continue;
    expect(phase.recordBytes.every((bytes) => bytes === 0)).toBe(true);
    const stride = phase.phase === "position" ? 8 : 12;
    expect(phase.transformBytes.every((bytes) => bytes === 1000 * stride + 16)).toBe(true);
  }
});
