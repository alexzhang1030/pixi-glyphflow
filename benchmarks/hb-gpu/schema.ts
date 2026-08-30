export const HB_GPU_DRAW_SCHEMA_VERSION = 2;
export const HB_GPU_DRAW_PINNED_VERSION = "14.4.0";
export const HB_GPU_DRAW_CORPUS_COUNT = 5;
export const HB_GPU_DRAW_MIN_ENCODE_GLYPHS_PER_SECOND = 10_000;
export const HB_GPU_DRAW_MAX_STORAGE_BYTES_PER_GLYPH_P95 = 16_384 as const;
export const HB_GPU_DRAW_ATLAS_PRESSURE_UNIQUE_GLYPHS = 20_000;
export const HB_GPU_DRAW_MAX_PROJECTED_STORAGE_BYTES = 67_108_864 as const;

export interface HbGpuGlyphExtents {
  readonly xBearing: number;
  readonly yBearing: number;
  readonly width: number;
  readonly height: number;
}

export interface HbGpuNativeShaderSourceBytes {
  readonly sharedVertex: number;
  readonly sharedFragment: number;
  readonly drawVertex: number;
  readonly drawFragment: number;
}

export interface HbGpuNativeGlyphSample {
  readonly glyphId: number;
  readonly blobBytes: number;
  readonly encodeNs: number;
  readonly blobHex: string;
  readonly extents: Readonly<HbGpuGlyphExtents>;
}

export interface HbGpuNativeSample {
  readonly harfbuzzVersion: string;
  readonly shapeNs: number;
  readonly shapedGlyphIds: readonly number[];
  readonly encodeIterations: number;
  readonly drawFailureCount: number;
  readonly drawFailureGlyphIds: readonly number[];
  readonly encodeFailureCount: number;
  readonly encodeFailureGlyphIds: readonly number[];
  readonly blobMismatchCount: number;
  readonly shaderSourceBytes: Readonly<HbGpuNativeShaderSourceBytes>;
  readonly glyphs: readonly Readonly<HbGpuNativeGlyphSample>[];
}

export type HbGpuDrawDecisionReason =
  | "corpus-coverage"
  | "determinism"
  | "draw-failures"
  | "encode-failures"
  | "encode-throughput"
  | "harfbuzz-version"
  | "sign-extended-atlas-pressure-storage"
  | "storage-pathology"
  | "wgsl-shader-source";

export interface HbGpuDrawDecision {
  readonly status: "go" | "pause";
  readonly next:
    | "browser-gpu-draw-spike"
    | "hold-production-path"
    | "packed-browser-gpu-draw-spike";
  readonly reasons: readonly HbGpuDrawDecisionReason[];
}

export interface HbGpuDrawDecisionInput {
  readonly harfbuzzVersion: string;
  readonly corpusCount: number;
  readonly drawFailureCount: number;
  readonly encodeFailureCount: number;
  readonly deterministic: boolean;
  readonly wgslShaderSourceBytes: number;
  readonly encodeGlyphsPerSecond: number;
  readonly atlasPressureProjectedPackedBytes: number;
  readonly atlasPressureProjectedStorageBytes: number;
  readonly signExtendedBytesPerGlyphP95: number;
}

export function parseHbGpuNativeSample(value: unknown): Readonly<HbGpuNativeSample> {
  const sample = record(value, "sample");
  const shader = record(sample.shaderSourceBytes, "shaderSourceBytes");
  const glyphValues = array(sample.glyphs, "glyphs");
  const glyphs = glyphValues.map((value, index) => {
    const glyph = record(value, `glyphs[${String(index)}]`);
    const extents = record(glyph.extents, `glyphs[${String(index)}].extents`);
    const blobBytes = safeInteger(glyph.blobBytes, `glyphs[${String(index)}].blobBytes`, 0);
    if (blobBytes % 8 !== 0) {
      throw new TypeError(`glyphs[${String(index)}].blobBytes must contain whole RGBA16I texels`);
    }
    const blobHex = string(glyph.blobHex, `glyphs[${String(index)}].blobHex`);
    if (!/^(?:[0-9a-f]{2})*$/u.test(blobHex) || blobHex.length !== blobBytes * 2) {
      throw new TypeError(`glyphs[${String(index)}].blobHex must encode blobBytes bytes`);
    }

    return Object.freeze({
      glyphId: safeInteger(glyph.glyphId, `glyphs[${String(index)}].glyphId`, 0, 0xffff_ffff),
      blobBytes,
      encodeNs: safeInteger(glyph.encodeNs, `glyphs[${String(index)}].encodeNs`, 0),
      blobHex,
      extents: Object.freeze({
        xBearing: safeInteger(
          extents.xBearing,
          `glyphs[${String(index)}].extents.xBearing`,
          -0x8000_0000,
          0x7fff_ffff,
        ),
        yBearing: safeInteger(
          extents.yBearing,
          `glyphs[${String(index)}].extents.yBearing`,
          -0x8000_0000,
          0x7fff_ffff,
        ),
        width: safeInteger(
          extents.width,
          `glyphs[${String(index)}].extents.width`,
          -0x8000_0000,
          0x7fff_ffff,
        ),
        height: safeInteger(
          extents.height,
          `glyphs[${String(index)}].extents.height`,
          -0x8000_0000,
          0x7fff_ffff,
        ),
      }),
    });
  });

  return Object.freeze({
    harfbuzzVersion: string(sample.harfbuzzVersion, "harfbuzzVersion"),
    shapeNs: safeInteger(sample.shapeNs, "shapeNs", 0),
    shapedGlyphIds: integerArray(sample.shapedGlyphIds, "shapedGlyphIds", 0, 0xffff_ffff),
    encodeIterations: safeInteger(sample.encodeIterations, "encodeIterations", 1),
    drawFailureCount: safeInteger(sample.drawFailureCount, "drawFailureCount", 0),
    drawFailureGlyphIds: integerArray(
      sample.drawFailureGlyphIds,
      "drawFailureGlyphIds",
      0,
      0xffff_ffff,
    ),
    encodeFailureCount: safeInteger(sample.encodeFailureCount, "encodeFailureCount", 0),
    encodeFailureGlyphIds: integerArray(
      sample.encodeFailureGlyphIds,
      "encodeFailureGlyphIds",
      0,
      0xffff_ffff,
    ),
    blobMismatchCount: safeInteger(sample.blobMismatchCount, "blobMismatchCount", 0),
    shaderSourceBytes: Object.freeze({
      sharedVertex: safeInteger(shader.sharedVertex, "shaderSourceBytes.sharedVertex", 0),
      sharedFragment: safeInteger(shader.sharedFragment, "shaderSourceBytes.sharedFragment", 0),
      drawVertex: safeInteger(shader.drawVertex, "shaderSourceBytes.drawVertex", 0),
      drawFragment: safeInteger(shader.drawFragment, "shaderSourceBytes.drawFragment", 0),
    }),
    glyphs: Object.freeze(glyphs),
  });
}

export function signExtendedWebGpuStorageBytes(blobBytes: number): number {
  if (!Number.isSafeInteger(blobBytes) || blobBytes < 0 || blobBytes % 8 !== 0) {
    throw new RangeError("blobBytes must contain whole 8-byte RGBA16I texels");
  }

  return blobBytes * 2;
}

export function evaluateHbGpuDrawArtifact(
  input: Readonly<HbGpuDrawDecisionInput>,
): Readonly<HbGpuDrawDecision> {
  const reasons: HbGpuDrawDecisionReason[] = [];
  if (input.harfbuzzVersion !== HB_GPU_DRAW_PINNED_VERSION) reasons.push("harfbuzz-version");
  if (input.corpusCount !== HB_GPU_DRAW_CORPUS_COUNT) reasons.push("corpus-coverage");
  if (input.drawFailureCount !== 0) reasons.push("draw-failures");
  if (input.encodeFailureCount !== 0) reasons.push("encode-failures");
  if (!input.deterministic) reasons.push("determinism");
  if (input.wgslShaderSourceBytes <= 0) reasons.push("wgsl-shader-source");
  if (input.encodeGlyphsPerSecond < HB_GPU_DRAW_MIN_ENCODE_GLYPHS_PER_SECOND) {
    reasons.push("encode-throughput");
  }
  if (input.atlasPressureProjectedStorageBytes > HB_GPU_DRAW_MAX_PROJECTED_STORAGE_BYTES) {
    reasons.push("sign-extended-atlas-pressure-storage");
  }
  if (input.signExtendedBytesPerGlyphP95 > HB_GPU_DRAW_MAX_STORAGE_BYTES_PER_GLYPH_P95) {
    reasons.push("storage-pathology");
  }

  const packedCandidate =
    reasons.length === 1 &&
    reasons[0] === "sign-extended-atlas-pressure-storage" &&
    input.atlasPressureProjectedPackedBytes <= HB_GPU_DRAW_MAX_PROJECTED_STORAGE_BYTES;

  return Object.freeze({
    status: reasons.length === 0 ? "go" : "pause",
    next:
      reasons.length === 0
        ? "browser-gpu-draw-spike"
        : packedCandidate
          ? "packed-browser-gpu-draw-spike"
          : "hold-production-path",
    reasons: Object.freeze(reasons),
  });
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }

  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);

  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);

  return value;
}

function safeInteger(value: unknown, path: string, minimum: number, maximum = Infinity): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new TypeError(
      `${path} must be a safe integer from ${String(minimum)} to ${String(maximum)}`,
    );
  }

  return value;
}

function integerArray(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): readonly number[] {
  return Object.freeze(
    array(value, path).map((entry, index) =>
      safeInteger(entry, `${path}[${String(index)}]`, minimum, maximum),
    ),
  );
}
