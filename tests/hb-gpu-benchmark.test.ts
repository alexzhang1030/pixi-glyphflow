import { describe, expect, test } from "bun:test";

import {
  evaluateHbGpuDrawArtifact,
  parseHbGpuNativeSample,
  signExtendedWebGpuStorageBytes,
  type HbGpuDrawDecisionInput,
} from "../benchmarks/hb-gpu/schema";

const validNativeSample = {
  harfbuzzVersion: "14.4.0",
  shapeNs: 12_000,
  shapedGlyphIds: [4, 7, 4],
  encodeIterations: 10,
  drawFailureCount: 0,
  drawFailureGlyphIds: [],
  encodeFailureCount: 0,
  encodeFailureGlyphIds: [],
  blobMismatchCount: 0,
  shaderSourceBytes: {
    sharedVertex: 10,
    sharedFragment: 20,
    drawVertex: 0,
    drawFragment: 30,
  },
  glyphs: [
    {
      glyphId: 4,
      blobBytes: 16,
      encodeNs: 1_000,
      blobHex: "00".repeat(16),
      extents: { xBearing: 1, yBearing: 9, width: 8, height: -10 },
    },
    {
      glyphId: 7,
      blobBytes: 24,
      encodeNs: 2_000,
      blobHex: "04".repeat(24),
      extents: { xBearing: 2, yBearing: 8, width: 7, height: -9 },
    },
  ],
};

const validHbGpuDrawArtifact = Object.freeze({
  harfbuzzVersion: "14.4.0",
  corpusCount: 5,
  drawFailureCount: 0,
  encodeFailureCount: 0,
  deterministic: true,
  wgslShaderSourceBytes: 60,
  encodeGlyphsPerSecond: 20_000,
  atlasPressureProjectedPackedBytes: 30 * 1024 * 1024,
  atlasPressureProjectedStorageBytes: 60 * 1024 * 1024,
  signExtendedBytesPerGlyphP95: 8_192,
}) satisfies Readonly<HbGpuDrawDecisionInput>;

describe("HbGpuDrawSpike schema", () => {
  test("parses the native helper boundary and freezes the result", () => {
    const sample = parseHbGpuNativeSample(validNativeSample);

    expect(sample.harfbuzzVersion).toBe("14.4.0");
    expect(sample.shapedGlyphIds).toEqual([4, 7, 4]);
    expect(sample.glyphs).toHaveLength(2);
    expect(Object.isFrozen(sample)).toBe(true);
    expect(Object.isFrozen(sample.glyphs)).toBe(true);
  });

  test("rejects malformed helper output at the process boundary", () => {
    expect(() =>
      parseHbGpuNativeSample({
        ...validNativeSample,
        glyphs: [
          {
            glyphId: 4,
            blobBytes: -1,
            encodeNs: 1_000,
            blobHex: "00",
            extents: { xBearing: 0, yBearing: 0, width: 0, height: 0 },
          },
        ],
      }),
    ).toThrow("glyphs[0].blobBytes");
    expect(() =>
      parseHbGpuNativeSample({ ...validNativeSample, shapedGlyphIds: [4, 1.5] }),
    ).toThrow("shapedGlyphIds[1]");
  });

  test("accounts for RGBA16I texels expanded into vec4<i32> WebGPU storage", () => {
    expect(signExtendedWebGpuStorageBytes(0)).toBe(0);
    expect(signExtendedWebGpuStorageBytes(8)).toBe(16);
    expect(signExtendedWebGpuStorageBytes(24)).toBe(48);
    expect(() => signExtendedWebGpuStorageBytes(10)).toThrow("RGBA16I texels");
  });

  test("advances only a pinned, deterministic, zero-failure five-corpus run", () => {
    const passing = evaluateHbGpuDrawArtifact(validHbGpuDrawArtifact);
    const failing = evaluateHbGpuDrawArtifact({
      ...validHbGpuDrawArtifact,
      harfbuzzVersion: "14.5.0",
      drawFailureCount: 1,
      encodeFailureCount: 1,
      deterministic: false,
      wgslShaderSourceBytes: 0,
      encodeGlyphsPerSecond: 5_000,
      atlasPressureProjectedPackedBytes: 40 * 1024 * 1024,
      atlasPressureProjectedStorageBytes: 80 * 1024 * 1024,
      signExtendedBytesPerGlyphP95: 32_768,
    });

    expect(passing).toEqual({
      status: "go",
      next: "browser-gpu-draw-spike",
      reasons: [],
    });
    expect(failing.status).toBe("pause");
    expect(failing.next).toBe("hold-production-path");
    expect(failing.reasons).toEqual([
      "harfbuzz-version",
      "draw-failures",
      "encode-failures",
      "determinism",
      "wgsl-shader-source",
      "encode-throughput",
      "sign-extended-atlas-pressure-storage",
      "storage-pathology",
    ]);
  });

  test("routes a sign-extension-only pause into the packed browser spike", () => {
    expect(
      evaluateHbGpuDrawArtifact({
        ...validHbGpuDrawArtifact,
        atlasPressureProjectedPackedBytes: 60 * 1024 * 1024,
        atlasPressureProjectedStorageBytes: 120 * 1024 * 1024,
      }),
    ).toEqual({
      status: "pause",
      next: "packed-browser-gpu-draw-spike",
      reasons: ["sign-extended-atlas-pressure-storage"],
    });
  });
});
