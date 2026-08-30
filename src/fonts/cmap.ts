const SFNT_DIRECTORY_SIZE = 12;
const SFNT_TABLE_RECORD_SIZE = 16;
const CMAP_ENCODING_RECORD_SIZE = 8;
const FORMAT_12_HEADER_SIZE = 16;
const FORMAT_12_GROUP_SIZE = 12;
const FORMAT_4_LIMIT = 0xffff;

export interface PreparedGlyphFont {
  readonly bytes: Uint8Array;
  readonly glyphText: string;
}

/** Map one temporary Unicode scalar to a shaped glyph ID for character-only atlas generators. */
export function prepareGlyphFont(
  bytes: Uint8Array,
  glyphId: number,
  glyphText: string,
): Readonly<PreparedGlyphFont> {
  const codePoint = glyphText.codePointAt(0);
  if (codePoint === undefined || !Number.isSafeInteger(glyphId) || glyphId < 0) {
    return Object.freeze({ bytes, glyphText });
  }

  try {
    const view = dataView(bytes);
    const subtables = cmapSubtables(view);
    if (subtables.some((offset) => lookupGlyph(view, offset, codePoint) === glyphId)) {
      return Object.freeze({ bytes, glyphText: String.fromCodePoint(codePoint) });
    }

    const format12 = subtables.filter((offset) => view.getUint16(offset) === 12);
    const format4 = subtables.filter((offset) => view.getUint16(offset) === 4);
    const remapCodePoint =
      format12
        .map((offset) => selectFormat12Target(view, offset, codePoint))
        .find((candidate) => candidate !== undefined) ??
      format4
        .map((offset) => selectFormat4Target(view, offset, codePoint))
        .find((candidate) => candidate !== undefined);
    if (remapCodePoint !== undefined) {
      const patched = bytes.slice();
      const patchedView = dataView(patched);
      let mappings = 0;
      for (const offset of format12) {
        mappings += Number(patchFormat12(patchedView, offset, remapCodePoint, glyphId));
      }
      if (remapCodePoint <= FORMAT_4_LIMIT) {
        for (const offset of format4) {
          mappings += Number(patchFormat4(patchedView, offset, remapCodePoint, glyphId));
        }
      }
      if (mappings > 0) {
        return Object.freeze({
          bytes: patched,
          glyphText: String.fromCodePoint(remapCodePoint),
        });
      }
    }
  } catch {
    return Object.freeze({ bytes, glyphText });
  }

  return Object.freeze({ bytes, glyphText });
}

function cmapSubtables(view: DataView): readonly number[] {
  const faceOffset = resolveFaceOffset(view);
  assertRange(view, faceOffset, SFNT_DIRECTORY_SIZE);
  const tableCount = view.getUint16(faceOffset + 4);
  const recordsOffset = faceOffset + SFNT_DIRECTORY_SIZE;
  assertRange(view, recordsOffset, tableCount * SFNT_TABLE_RECORD_SIZE);
  let cmapOffset: number | undefined;
  let cmapLength = 0;
  for (let index = 0; index < tableCount; index += 1) {
    const recordOffset = recordsOffset + index * SFNT_TABLE_RECORD_SIZE;
    if (readTag(view, recordOffset) === "cmap") {
      cmapOffset = view.getUint32(recordOffset + 8);
      cmapLength = view.getUint32(recordOffset + 12);
      break;
    }
  }
  if (cmapOffset === undefined) return [];
  assertRange(view, cmapOffset, cmapLength);
  assertRange(view, cmapOffset, 4);
  const encodingCount = view.getUint16(cmapOffset + 2);
  const encodingsOffset = cmapOffset + 4;
  assertRange(view, encodingsOffset, encodingCount * CMAP_ENCODING_RECORD_SIZE);
  const offsets = new Set<number>();
  for (let index = 0; index < encodingCount; index += 1) {
    const recordOffset = encodingsOffset + index * CMAP_ENCODING_RECORD_SIZE;
    const subtableOffset = cmapOffset + view.getUint32(recordOffset + 4);
    assertRange(view, subtableOffset, 2);
    const format = view.getUint16(subtableOffset);
    if (format === 4 || format === 12) offsets.add(subtableOffset);
  }

  return Object.freeze([...offsets]);
}

function lookupGlyph(view: DataView, offset: number, codePoint: number): number | undefined {
  const format = view.getUint16(offset);
  if (format === 12) return lookupFormat12(view, offset, codePoint);
  if (format === 4 && codePoint <= FORMAT_4_LIMIT) {
    return lookupFormat4(view, offset, codePoint);
  }
  return undefined;
}

function lookupFormat12(view: DataView, offset: number, codePoint: number): number | undefined {
  assertRange(view, offset, FORMAT_12_HEADER_SIZE);
  const length = view.getUint32(offset + 4);
  const groupCount = view.getUint32(offset + 12);
  assertRange(view, offset, length);
  assertRange(view, offset + FORMAT_12_HEADER_SIZE, groupCount * FORMAT_12_GROUP_SIZE);
  let low = 0;
  let high = groupCount - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const groupOffset = offset + FORMAT_12_HEADER_SIZE + middle * FORMAT_12_GROUP_SIZE;
    const start = view.getUint32(groupOffset);
    const end = view.getUint32(groupOffset + 4);
    if (codePoint < start) high = middle - 1;
    else if (codePoint > end) low = middle + 1;
    else return view.getUint32(groupOffset + 8) + codePoint - start;
  }
  return undefined;
}

function lookupFormat4(view: DataView, offset: number, codePoint: number): number | undefined {
  assertRange(view, offset, 14);
  const length = view.getUint16(offset + 2);
  const segmentCount = view.getUint16(offset + 6) / 2;
  assertRange(view, offset, length);
  if (!Number.isSafeInteger(segmentCount) || segmentCount <= 0) return undefined;
  const endCodes = offset + 14;
  const startCodes = endCodes + segmentCount * 2 + 2;
  const deltas = startCodes + segmentCount * 2;
  const rangeOffsets = deltas + segmentCount * 2;
  assertRange(view, rangeOffsets, segmentCount * 2);
  for (let index = 0; index < segmentCount; index += 1) {
    const end = view.getUint16(endCodes + index * 2);
    if (codePoint > end) continue;
    const start = view.getUint16(startCodes + index * 2);
    if (codePoint < start) return undefined;
    const delta = view.getInt16(deltas + index * 2);
    const rangeOffsetAddress = rangeOffsets + index * 2;
    const rangeOffset = view.getUint16(rangeOffsetAddress);
    if (rangeOffset === 0) return (codePoint + delta) & FORMAT_4_LIMIT;
    const glyphAddress = rangeOffsetAddress + rangeOffset + (codePoint - start) * 2;
    assertRange(view, glyphAddress, 2);
    const glyph = view.getUint16(glyphAddress);
    return glyph === 0 ? 0 : (glyph + delta) & FORMAT_4_LIMIT;
  }
  return undefined;
}

function selectFormat12Target(
  view: DataView,
  offset: number,
  preferred: number,
): number | undefined {
  assertRange(view, offset, FORMAT_12_HEADER_SIZE);
  const length = view.getUint32(offset + 4);
  const groupCount = view.getUint32(offset + 12);
  assertRange(view, offset, length);
  for (let index = 0; index < groupCount; index += 1) {
    const groupOffset = offset + FORMAT_12_HEADER_SIZE + index * FORMAT_12_GROUP_SIZE;
    assertRange(view, groupOffset, FORMAT_12_GROUP_SIZE);
    const start = view.getUint32(groupOffset);
    const end = view.getUint32(groupOffset + 4);
    if (preferred >= start && preferred <= end) return preferred;
  }
  for (let index = groupCount - 1; index >= 0; index -= 1) {
    const groupOffset = offset + FORMAT_12_HEADER_SIZE + index * FORMAT_12_GROUP_SIZE;
    const start = view.getUint32(groupOffset);
    const end = view.getUint32(groupOffset + 4);
    if (isUsableScalar(end)) return end;
    if (isUsableScalar(start)) return start;
  }
  return undefined;
}

function patchFormat12(
  view: DataView,
  offset: number,
  codePoint: number,
  glyphId: number,
): boolean {
  assertRange(view, offset, FORMAT_12_HEADER_SIZE);
  const length = view.getUint32(offset + 4);
  const groupCount = view.getUint32(offset + 12);
  assertRange(view, offset, length);
  for (let index = 0; index < groupCount; index += 1) {
    const groupOffset = offset + FORMAT_12_HEADER_SIZE + index * FORMAT_12_GROUP_SIZE;
    assertRange(view, groupOffset, FORMAT_12_GROUP_SIZE);
    const start = view.getUint32(groupOffset);
    const end = view.getUint32(groupOffset + 4);
    if (codePoint < start || codePoint > end) continue;
    view.setUint32(groupOffset, codePoint);
    view.setUint32(groupOffset + 4, codePoint);
    view.setUint32(groupOffset + 8, glyphId);
    return true;
  }
  return false;
}

function selectFormat4Target(
  view: DataView,
  offset: number,
  preferred: number,
): number | undefined {
  assertRange(view, offset, 14);
  const length = view.getUint16(offset + 2);
  const segmentCount = view.getUint16(offset + 6) / 2;
  assertRange(view, offset, length);
  if (!Number.isSafeInteger(segmentCount) || segmentCount <= 0) return undefined;
  const endCodes = offset + 14;
  const startCodes = endCodes + segmentCount * 2 + 2;
  assertRange(view, startCodes, segmentCount * 2);
  if (preferred <= FORMAT_4_LIMIT) {
    for (let index = 0; index < segmentCount; index += 1) {
      const start = view.getUint16(startCodes + index * 2);
      const end = view.getUint16(endCodes + index * 2);
      if (preferred >= start && preferred <= end && isUsableScalar(preferred)) return preferred;
    }
  }
  for (let index = segmentCount - 1; index >= 0; index -= 1) {
    const start = view.getUint16(startCodes + index * 2);
    const end = view.getUint16(endCodes + index * 2);
    if (isUsableScalar(end)) return end;
    if (isUsableScalar(start)) return start;
  }
  return undefined;
}

function patchFormat4(view: DataView, offset: number, codePoint: number, glyphId: number): boolean {
  assertRange(view, offset, 14);
  const length = view.getUint16(offset + 2);
  const segmentCount = view.getUint16(offset + 6) / 2;
  assertRange(view, offset, length);
  if (!Number.isSafeInteger(segmentCount) || segmentCount <= 0) return false;
  const endCodes = offset + 14;
  const startCodes = endCodes + segmentCount * 2 + 2;
  const deltas = startCodes + segmentCount * 2;
  const rangeOffsets = deltas + segmentCount * 2;
  assertRange(view, rangeOffsets, segmentCount * 2);
  for (let index = 0; index < segmentCount; index += 1) {
    const segmentOffset = index * 2;
    const start = view.getUint16(startCodes + segmentOffset);
    const end = view.getUint16(endCodes + segmentOffset);
    if (codePoint < start || codePoint > end) continue;
    view.setUint16(endCodes + segmentOffset, codePoint);
    view.setUint16(startCodes + segmentOffset, codePoint);
    view.setInt16(deltas + segmentOffset, normalizeInt16(glyphId - codePoint));
    view.setUint16(rangeOffsets + segmentOffset, 0);
    return true;
  }
  return false;
}

function isUsableScalar(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 0x10_ffff &&
    (value < 0xd800 || value > 0xdfff) &&
    (value & 0xffff) < 0xfffe
  );
}

function resolveFaceOffset(view: DataView): number {
  assertRange(view, 0, SFNT_DIRECTORY_SIZE);
  if (readTag(view, 0) !== "ttcf") return 0;
  assertRange(view, 0, 16);
  const faceCount = view.getUint32(8);
  if (faceCount === 0) throw new RangeError("OpenType collection contains zero faces");
  const offset = view.getUint32(12);
  assertRange(view, offset, SFNT_DIRECTORY_SIZE);
  return offset;
}

function dataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function assertRange(view: DataView, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > view.byteLength
  ) {
    throw new RangeError("OpenType table range is invalid");
  }
}

function readTag(view: DataView, offset: number): string {
  assertRange(view, offset, 4);
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function normalizeInt16(value: number): number {
  const unsigned = value & FORMAT_4_LIMIT;
  return unsigned > 0x7fff ? unsigned - 0x1_0000 : unsigned;
}
