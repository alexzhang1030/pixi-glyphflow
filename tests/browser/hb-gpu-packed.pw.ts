import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

test("renders HarfBuzz GPU Draw blobs through packed WebGPU storage", async ({
  page,
}, testInfo) => {
  const messages: string[] = [];
  page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", (error) => messages.push(`pageerror: ${error.message}`));

  await page.goto("/benchmarks/hb-gpu/browser.html");
  await page.waitForFunction(() => window.__hbGpuPackedBrowser?.done === true, undefined, {
    timeout: 5_000,
  });
  const state = await page.evaluate(() => window.__hbGpuPackedBrowser);
  await testInfo.attach("browser-console", {
    body: messages.join("\n"),
    contentType: "text/plain",
  });
  await testInfo.attach("hb-gpu-packed-browser-state", {
    body: JSON.stringify(state, undefined, 2),
    contentType: "application/json",
  });
  if (state === undefined) throw new Error("Hb GPU packed browser state is unavailable");

  expect(state.error, state.error).toBeUndefined();
  expect(state.result?.artifact).toMatchObject({
    harfbuzzVersion: "14.4.0",
    corpusCount: 5,
    packedBlobBytes: expect.any(Number),
  });
  expect(state.result?.artifact.packedBlobBytes).toBeGreaterThan(300_000);
  expect(state.result?.scene).toEqual([
    { corpusId: "cjkv", glyphId: 130, blobBytes: 12_720 },
    { corpusId: "arabic", glyphId: 22, blobBytes: 3_976 },
    { corpusId: "devanagari", glyphId: 12, blobBytes: 3_856 },
    { corpusId: "hebrew", glyphId: 10, blobBytes: 3_336 },
    { corpusId: "thai", glyphId: 10, blobBytes: 3_792 },
  ]);
  expect(state.result?.capability).toBeDefined();

  if (state.result?.capability?.status === "skipped") {
    expect(state.result.capability.reason).toMatch(/WebGPU|adapter/i);
    expect(state.result.decision).toEqual({
      status: "pause",
      reasons: ["webgpu-unavailable"],
      next: "retain-shipping-renderer",
    });
    return;
  }

  expect(state.result?.capability).toMatchObject({
    status: "available",
    maxStorageBufferBindingSize: expect.any(Number),
    maxTextureDimension2D: expect.any(Number),
    timestampQuery: expect.any(Boolean),
  });
  const packed = state.result?.packed;
  expect(packed, JSON.stringify(state, undefined, 2)).toMatchObject({
    status: "go",
    validationErrors: 0,
    uploadedBytes: state.result?.artifact.packedBlobBytes,
    projectedBytes: 57_409_123,
    pixelHash: expect.any(String),
    repeatedPixelHash: expect.any(String),
    maskHash: expect.any(String),
    repeatedMaskHash: expect.any(String),
    visiblePixels: expect.any(Number),
    corpusVisiblePixels: expect.any(Array),
    cpuTimingMs: expect.any(Object),
  });
  expect(packed?.pixelHash).toBe(packed?.repeatedPixelHash);
  expect(packed?.maskHash).toBe(packed?.repeatedMaskHash);
  expect(packed?.maskHash).toBe("52540be95eb2d342679c331b72688aa6baa534fc99dec462884457897cc6a683");
  expect(packed?.visiblePixels).toBeGreaterThan(500);
  expect(packed?.corpusVisiblePixels).toHaveLength(5);
  expect(packed?.corpusVisiblePixels.every((pixels) => pixels > 10)).toBe(true);
  expect(Object.values(packed?.cpuTimingMs ?? {}).every(Number.isFinite)).toBe(true);
  expect(state.result?.capability?.maxStorageBufferBindingSize).toBeGreaterThanOrEqual(
    packed?.projectedBytes ?? Number.POSITIVE_INFINITY,
  );
  if (state.result?.capability?.timestampQuery === true) {
    expect(packed?.gpuTimingNs).toBeGreaterThan(0);
    expect(packed?.gpuTimingDraws).toBe(64);
    expect(packed?.gpuTimingNsSamples).toHaveLength(20);
    expect(packed?.gpuTimingPerDrawP95Ns).toBeGreaterThan(0);
    expect(packed?.gpuTimingPerDrawP95Ns).toBeLessThanOrEqual(50_000);
  }

  const rgba16sint = state.result?.rgba16sint;
  expect(rgba16sint?.status === "go" || rgba16sint?.status === "skipped").toBe(true);
  if (rgba16sint?.status === "go") {
    expect(rgba16sint.validationErrors).toBe(0);
    expect(rgba16sint.pixelHash).toBe(packed?.pixelHash);
    expect(rgba16sint.repeatedPixelHash).toBe(packed?.pixelHash);
    expect(rgba16sint.maskHash).toBe(packed?.maskHash);
    expect(rgba16sint).toMatchObject({
      textureWidth: 1024,
      actualTextureHeight: 40,
      projectedTextureHeight: 7008,
    });
    expect(rgba16sint.projectedTextureHeight).toBeLessThanOrEqual(
      state.result?.capability?.maxTextureDimension2D ?? 0,
    );
  } else {
    expect(rgba16sint?.reason).toMatch(/rgba16sint|texture/i);
  }
  expect(state.result?.decision?.status).toBe("go");

  const nativeArtifactBytes = await readFile(
    "benchmarks/hb-gpu/results/hb-gpu-draw-native-14.4.0.json",
  );
  const capturedArtifact = JSON.parse(
    await readFile("benchmarks/hb-gpu/results/hb-gpu-draw-browser-14.4.0.json", "utf8"),
  ) as {
    schemaVersion: number;
    sourceArtifactSha256: string;
    benchmarkSourcesSha256: {
      browser: string;
      packedRuntime: string;
    };
    result: {
      packed?: { maskHash: string };
      rgba16sint?: { maskHash: string };
      decision: { status: string };
    };
  };
  expect(capturedArtifact).toMatchObject({
    schemaVersion: 1,
    result: {
      packed: { maskHash: packed?.maskHash },
      rgba16sint: { maskHash: packed?.maskHash },
      decision: { status: "go" },
    },
  });
  expect(capturedArtifact.sourceArtifactSha256).toBe(
    createHash("sha256").update(nativeArtifactBytes).digest("hex"),
  );
  expect(capturedArtifact.benchmarkSourcesSha256).toEqual({
    browser: createHash("sha256")
      .update(await readFile("benchmarks/hb-gpu/browser.ts"))
      .digest("hex"),
    packedRuntime: createHash("sha256")
      .update(await readFile("benchmarks/hb-gpu/packed-runtime.ts"))
      .digest("hex"),
  });
});

test("records explicit evidence when WebGPU capability is unavailable", async ({ page }) => {
  await page.goto("/benchmarks/hb-gpu/browser.html?forceWebGpuSkip=1");
  await page.waitForFunction(() => window.__hbGpuPackedBrowser?.done === true);
  const state = await page.evaluate(() => window.__hbGpuPackedBrowser);

  expect(state?.error, state?.error).toBeUndefined();
  expect(state?.result?.capability).toEqual({
    status: "skipped",
    reason: "WebGPU capability skip forced by benchmark query",
  });
  expect(state?.result?.decision).toEqual({
    status: "pause",
    reasons: ["webgpu-unavailable"],
    next: "retain-shipping-renderer",
  });
});
