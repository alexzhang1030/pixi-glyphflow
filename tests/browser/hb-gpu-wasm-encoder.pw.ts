import { expect, test } from "@playwright/test";

test("encodes five scripts in a browser Worker with native blob parity", async ({
  page,
}, testInfo) => {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));

  await page.goto("/benchmarks/hb-gpu/wasm-browser.html");
  await page.waitForFunction(() => window.__hbGpuWasmBrowser?.done === true, undefined, {
    timeout: 30_000,
  });
  const state = await page.evaluate(() => window.__hbGpuWasmBrowser);
  await testInfo.attach("hb-gpu-wasm-browser-state", {
    body: JSON.stringify(state, undefined, 2),
    contentType: "application/json",
  });
  await testInfo.attach("browser-console", {
    body: messages.join("\n"),
    contentType: "text/plain",
  });

  expect(state.error, state.error).toBeUndefined();
  expect(state.result).toMatchObject({
    harfbuzzVersion: "14.4.0",
    abiVersion: 1,
    toolchain: {
      emscriptenVersion: "4.0.16",
      imageDigest: "sha256:69820cfa8dd489d1ddd13bb394b9b9a80b491fb6a3b44715622b5cba0e5f49fb",
    },
    wasm: {
      sha256: "81aa7c58ce797ed760d4a40722c53aa261fde343e26cb9508482d5cd9abf493d",
      fetchedSha256: "81aa7c58ce797ed760d4a40722c53aa261fde343e26cb9508482d5cd9abf493d",
      rawBytes: 221_915,
      gzipBytes: 82_626,
    },
    corpusCount: 5,
    parity: {
      mismatchCount: 0,
      actualHash: expect.any(String),
      expectedHash: expect.any(String),
    },
    resources: {
      syncedFontsBeforeRelease: 5,
      syncedFontsAfterRelease: 0,
      releasedFonts: 5,
    },
    worker: { starts: 1, encodedGlyphs: 221 },
    iterations: { warmup: 16, measured: 200 },
    acceptance: {
      minimumWarmGlyphsPerSecond: 10_000,
      maximumColdStartMs: 100,
    },
  });
  expect(state.result?.parity.actualHash).toBe(state.result?.parity.expectedHash);
  expect(state.result?.glyphs.map((glyph) => glyph.corpusId)).toEqual([
    "cjkv",
    "arabic",
    "devanagari",
    "hebrew",
    "thai",
  ]);
  expect(state.result?.coldEncodeMs).toHaveLength(5);
  expect(state.result?.coldEncodeMs.every(Number.isFinite)).toBe(true);
  expect(state.result?.warmEncodeMs).toMatchObject({
    count: 200,
    mean: expect.any(Number),
    p50: expect.any(Number),
    p95: expect.any(Number),
  });
  expect(state.result?.warmGlyphsPerSecond).toBeGreaterThan(0);
  const result = state.result;
  if (result === undefined) {
    throw new Error("Hb GPU Wasm browser result is unavailable");
  }
  const expectedReasons: Array<"warm-throughput" | "cold-start"> = [];
  if (result.warmGlyphsPerSecond < result.acceptance.minimumWarmGlyphsPerSecond) {
    expectedReasons.push("warm-throughput");
  }
  if ((result.coldEncodeMs[0] ?? Number.POSITIVE_INFINITY) > result.acceptance.maximumColdStartMs) {
    expectedReasons.push("cold-start");
  }
  expect(
    result.decision,
    JSON.stringify({
      coldStartMs: result.coldEncodeMs[0],
      warmGlyphsPerSecond: result.warmGlyphsPerSecond,
      acceptance: result.acceptance,
      decision: result.decision,
    }),
  ).toEqual({
    status: expectedReasons.length === 0 ? "go" : "pause",
    reasons: expectedReasons,
  });
});
