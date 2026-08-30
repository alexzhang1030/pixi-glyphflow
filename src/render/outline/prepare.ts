import type {
  OutlinePreparationResult,
  OutlinePrepareOptions,
  OutlineQuadMetadata,
  PackedOutlineGlyphInput,
  PreparedOutlineGlyph,
} from "./types";

const PACKED_TEXEL_BYTES = 8;
const PACKED_COORDINATE_SCALE = 4;
const PACKED_OFFSET_BIAS = 32_768;

export const DEFAULT_OUTLINE_PREPARE_LIMITS: Required<OutlinePrepareOptions> = Object.freeze({
  maxBlobBytes: 524_288,
  maxBands: 4_096,
  maxCurves: 65_536,
  maxCurveReferences: 1_048_576,
});

interface DecodedBand {
  readonly count: number;
  readonly rightCurveOffsets: readonly number[];
  readonly leftCurveOffsets: readonly number[];
  readonly split: number;
}

export function prepareOutlineGlyph(
  input: Readonly<PackedOutlineGlyphInput>,
  options: Readonly<OutlinePrepareOptions> = DEFAULT_OUTLINE_PREPARE_LIMITS,
): Readonly<OutlinePreparationResult> {
  const limits = resolveLimits(options);
  const quad = quadFromExtents(input.extents);
  const blob = input.packedCurveBlob;
  if (blob.byteLength === 0) {
    if (quad.width !== 0 || quad.height !== 0) {
      throw new TypeError("an empty packed outline requires zero-area glyph extents");
    }
    return Object.freeze({ status: "empty", quad });
  }
  if (blob.byteLength > limits.maxBlobBytes) return unsupported("blob-bytes");
  if (blob.byteLength % PACKED_TEXEL_BYTES !== 0 || blob.byteLength < 16) {
    throw new TypeError("packedCurveBlob must contain at least two whole RGBA16I texels");
  }

  const words = decodeWords(blob);
  const texelCount = words.length / 4;
  const packedQuad = Object.freeze({
    minX: readWord(words, 0) / PACKED_COORDINATE_SCALE,
    minY: readWord(words, 1) / PACKED_COORDINATE_SCALE,
    maxX: readWord(words, 2) / PACKED_COORDINATE_SCALE,
    maxY: readWord(words, 3) / PACKED_COORDINATE_SCALE,
  });
  assertMatchingQuad(quad, packedQuad);

  const horizontalBandCount = readPositiveWord(words, 4, "horizontal band count");
  const verticalBandCount = readPositiveWord(words, 5, "vertical band count");
  const unitsPerEmX = readPositiveWord(words, 6, "horizontal units per em");
  const unitsPerEmY = readPositiveWord(words, 7, "vertical units per em");
  const bandCount = horizontalBandCount + verticalBandCount;
  if (bandCount > limits.maxBands) return unsupported("bands");
  const bandBase = 2;
  if (bandBase + bandCount > texelCount) {
    throw new TypeError("packedCurveBlob ends inside its spatial band table");
  }

  const bands: DecodedBand[] = [];
  const curveOffsets = new Set<number>();
  let curveReferenceCount = 0;
  for (let bandIndex = 0; bandIndex < bandCount; bandIndex += 1) {
    const texelIndex = bandBase + bandIndex;
    const wordIndex = texelIndex * 4;
    const count = readNonNegativeWord(words, wordIndex, `band ${String(bandIndex)} curve count`);
    curveReferenceCount += count * 2;
    if (curveReferenceCount > limits.maxCurveReferences) {
      return unsupported("curve-references");
    }
    const rightListOffset = readWord(words, wordIndex + 1) + PACKED_OFFSET_BIAS;
    const leftListOffset = readWord(words, wordIndex + 2) + PACKED_OFFSET_BIAS;
    const rightCurveOffsets = decodeCurveList(
      words,
      texelCount,
      rightListOffset,
      count,
      bandIndex,
      "right",
      curveOffsets,
      bandBase + bandCount,
    );
    const leftCurveOffsets = decodeCurveList(
      words,
      texelCount,
      leftListOffset,
      count,
      bandIndex,
      "left",
      curveOffsets,
      bandBase + bandCount,
    );
    if (curveOffsets.size > limits.maxCurves) return unsupported("curves");
    bands.push(
      Object.freeze({
        count,
        rightCurveOffsets,
        leftCurveOffsets,
        split: readWord(words, wordIndex + 3),
      }),
    );
  }

  const sortedCurveOffsets = [...curveOffsets].sort((first, second) => first - second);
  if (sortedCurveOffsets.length === 0) {
    throw new TypeError("a non-empty packed outline must reference at least one curve");
  }
  const curveIndexByOffset = new Map<number, number>();
  sortedCurveOffsets.forEach((offset, index) => curveIndexByOffset.set(offset, index));
  const curveStorage = new Float32Array(sortedCurveOffsets.length * 8);
  sortedCurveOffsets.forEach((offset, curveIndex) => {
    const source = offset * 4;
    const destination = curveIndex * 8;
    curveStorage[destination] = readWord(words, source) / PACKED_COORDINATE_SCALE;
    curveStorage[destination + 1] = readWord(words, source + 1) / PACKED_COORDINATE_SCALE;
    curveStorage[destination + 2] = readWord(words, source + 2) / PACKED_COORDINATE_SCALE;
    curveStorage[destination + 3] = readWord(words, source + 3) / PACKED_COORDINATE_SCALE;
    curveStorage[destination + 4] = readWord(words, source + 4) / PACKED_COORDINATE_SCALE;
    curveStorage[destination + 5] = readWord(words, source + 5) / PACKED_COORDINATE_SCALE;
  });

  const recordBase = 4;
  const referenceBase = recordBase + bandCount * 4;
  const referenceCount = bands.reduce((total, band) => total + band.count * 2, 0);
  const spatialLookup = new Int32Array(referenceBase + referenceCount);
  spatialLookup[0] = horizontalBandCount;
  spatialLookup[1] = verticalBandCount;
  spatialLookup[2] = recordBase;
  spatialLookup[3] = referenceBase;
  let referenceCursor = referenceBase;
  bands.forEach((band, bandIndex) => {
    const recordOffset = recordBase + bandIndex * 4;
    spatialLookup[recordOffset] = band.count;
    spatialLookup[recordOffset + 1] = referenceCursor;
    referenceCursor = writeCurveIndices(
      spatialLookup,
      referenceCursor,
      band.rightCurveOffsets,
      curveIndexByOffset,
    );
    spatialLookup[recordOffset + 2] = referenceCursor;
    referenceCursor = writeCurveIndices(
      spatialLookup,
      referenceCursor,
      band.leftCurveOffsets,
      curveIndexByOffset,
    );
    spatialLookup[recordOffset + 3] = band.split;
  });

  const glyph: PreparedOutlineGlyph = Object.freeze({
    quad,
    unitsPerEmX,
    unitsPerEmY,
    horizontalBandCount,
    verticalBandCount,
    curveCount: sortedCurveOffsets.length,
    curveStorage,
    spatialLookup,
  });
  return Object.freeze({ status: "ready", glyph });
}

function quadFromExtents(
  extents: Readonly<PackedOutlineGlyphInput["extents"]>,
): Readonly<OutlineQuadMetadata> {
  const values = [extents.xBearing, extents.yBearing, extents.width, extents.height];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError("glyph extents must contain finite values");
  }
  const oppositeX = extents.xBearing + extents.width;
  const oppositeY = extents.yBearing + extents.height;
  const minX = Math.min(extents.xBearing, oppositeX);
  const minY = Math.min(extents.yBearing, oppositeY);
  const maxX = Math.max(extents.xBearing, oppositeX);
  const maxY = Math.max(extents.yBearing, oppositeY);
  return Object.freeze({ minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY });
}

function decodeWords(blob: Uint8Array): Int16Array {
  const words = new Int16Array(blob.byteLength / 2);
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  for (let index = 0; index < words.length; index += 1) {
    words[index] = view.getInt16(index * 2, true);
  }
  return words;
}

function decodeCurveList(
  words: Int16Array,
  texelCount: number,
  listOffset: number,
  count: number,
  bandIndex: number,
  direction: "left" | "right",
  curveOffsets: Set<number>,
  minimumListOffset: number,
): readonly number[] {
  if (
    !Number.isSafeInteger(listOffset) ||
    (count > 0 && listOffset < minimumListOffset) ||
    listOffset + count > texelCount
  ) {
    throw new TypeError(`band ${String(bandIndex)} ${direction} curve list is outside the blob`);
  }
  const result: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const curveOffset = readWord(words, (listOffset + index) * 4) + PACKED_OFFSET_BIAS;
    if (curveOffset < minimumListOffset || curveOffset + 1 >= texelCount) {
      throw new TypeError(`band ${String(bandIndex)} ${direction} curve points outside the blob`);
    }
    result.push(curveOffset);
    curveOffsets.add(curveOffset);
  }
  return Object.freeze(result);
}

function resolveLimits(options: Readonly<OutlinePrepareOptions>): Required<OutlinePrepareOptions> {
  const limits = {
    maxBlobBytes: options.maxBlobBytes ?? DEFAULT_OUTLINE_PREPARE_LIMITS.maxBlobBytes,
    maxBands: options.maxBands ?? DEFAULT_OUTLINE_PREPARE_LIMITS.maxBands,
    maxCurves: options.maxCurves ?? DEFAULT_OUTLINE_PREPARE_LIMITS.maxCurves,
    maxCurveReferences:
      options.maxCurveReferences ?? DEFAULT_OUTLINE_PREPARE_LIMITS.maxCurveReferences,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${name} must be a non-negative safe integer`);
    }
  }
  return Object.freeze(limits);
}

function unsupported(
  limit: "blob-bytes" | "bands" | "curves" | "curve-references",
): Readonly<OutlinePreparationResult> {
  return Object.freeze({ status: "unsupported", reason: "resource-limits", limit });
}

function writeCurveIndices(
  target: Int32Array,
  offset: number,
  curveOffsets: readonly number[],
  curveIndexByOffset: ReadonlyMap<number, number>,
): number {
  let cursor = offset;
  for (const curveOffset of curveOffsets) {
    const curveIndex = curveIndexByOffset.get(curveOffset);
    if (curveIndex === undefined) throw new TypeError("packed curve reference was not indexed");
    target[cursor] = curveIndex;
    cursor += 1;
  }
  return cursor;
}

function assertMatchingQuad(
  expected: Readonly<OutlineQuadMetadata>,
  packed: Readonly<{ minX: number; minY: number; maxX: number; maxY: number }>,
): void {
  const epsilon = 1 / PACKED_COORDINATE_SCALE;
  if (
    Math.abs(expected.minX - packed.minX) > epsilon ||
    Math.abs(expected.minY - packed.minY) > epsilon ||
    Math.abs(expected.maxX - packed.maxX) > epsilon ||
    Math.abs(expected.maxY - packed.maxY) > epsilon
  ) {
    throw new TypeError("glyph extents differ from packed outline bounds");
  }
}

function readWord(words: Int16Array, index: number): number {
  const value = words[index];
  if (value === undefined) throw new TypeError("packedCurveBlob ended unexpectedly");
  return value;
}

function readPositiveWord(words: Int16Array, index: number, name: string): number {
  const value = readWord(words, index);
  if (value <= 0) throw new TypeError(`${name} must be positive`);
  return value;
}

function readNonNegativeWord(words: Int16Array, index: number, name: string): number {
  const value = readWord(words, index);
  if (value < 0) throw new TypeError(`${name} must be non-negative`);
  return value;
}
