import { expect, test } from "@playwright/test";

test("timestamps stable 1M-record GPU-resident compute culling", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.goto("/tests/browser/gpu-resident-compute.html");
  await page.waitForFunction(() => window.__gpuResidentComputeFixture?.done === true, undefined, {
    timeout: 120_000,
  });
  const state = await page.evaluate(() => window.__gpuResidentComputeFixture);
  await testInfo.attach("gpu-resident-compute-spike", {
    body: JSON.stringify(state, undefined, 2),
    contentType: "application/json",
  });
  expect(state.error).toBeUndefined();
  expect(state.result).toBeDefined();
  if (state.result === undefined) throw new Error("GPU-resident compute spike returned no result");
  test.skip(!state.result.supported, state.result.supported ? undefined : state.result.reason);
  if (!state.result.supported) return;
  console.log(`GPU_RESIDENT_COMPUTE_SPIKE ${JSON.stringify(state.result)}`);
  expect(state.result).toMatchObject({
    labels: 1_000_000,
    prototypeCount: 1,
    expectedSubmitted: 50_000,
    submitted: 50_000,
    indirect: [6, 50_000, 0, 0, 0],
    stableOrder: true,
    timestampValid: true,
    steadyStateCullUploadBytes: 0,
    fusedMove: {
      recordAabbs: [98, 197, 106, 206, -20, 60, -16, 65],
      transformOrigins: [100, 200, -30, 40],
      instanceCounts: [1, 0],
      bitExactMaxX: 16_777_216,
      bitExactMaxXBits: 0x4b800000,
      bitExactInstanceCount: 0,
      cullRecordUploadBytes: 0,
    },
  });
  expect(state.result.outputHash).toBe(state.result.expectedHash);
  expect(state.result.timestampSamples).toHaveLength(40);
  expect(state.result.gpuMsP50).toBeGreaterThan(0);
  expect(state.result.gpuMsP95).toBeGreaterThanOrEqual(state.result.gpuMsP50);
  expect(state.result.buffers.records).toBe(32_000_000);
  expect(state.result.buffers.transforms).toBe(0);
});
