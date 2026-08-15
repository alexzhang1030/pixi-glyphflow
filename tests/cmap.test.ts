import { describe, expect, test } from "bun:test";

import { prepareGlyphFont } from "../src/fonts/cmap";

describe("OpenType glyph remapping", () => {
  test("keeps direct format 12 mappings and remaps shaped alternates", () => {
    const font = format12Font(65, 10);

    const direct = prepareGlyphFont(font, 10, "A");
    expect(direct.bytes).toBe(font);
    expect(direct.glyphText).toBe("A");

    const alternate = prepareGlyphFont(font, 42, "A");
    expect(alternate.bytes).not.toBe(font);
    expect(alternate.glyphText).toBe("A");
    const view = new DataView(
      alternate.bytes.buffer,
      alternate.bytes.byteOffset,
      alternate.bytes.byteLength,
    );
    expect(view.getUint32(56)).toBe(65);
    expect(view.getUint32(60)).toBe(65);
    expect(view.getUint32(64)).toBe(42);
  });

  test("reuses a mapped scalar for BMP-only fonts", () => {
    const font = format4Font(65, 10);
    const alternate = prepareGlyphFont(font, 77, "A");

    expect(alternate.glyphText).toBe("A");
    const view = new DataView(
      alternate.bytes.buffer,
      alternate.bytes.byteOffset,
      alternate.bytes.byteLength,
    );
    expect((65 + view.getInt16(64)) & 0xffff).toBe(77);
    expect(view.getUint16(68)).toBe(0);
  });

  test("preserves opaque fixture bytes for injected rasterizers", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const prepared = prepareGlyphFont(bytes, 99, "字");

    expect(prepared).toEqual({ bytes, glyphText: "字" });
  });
});

function format12Font(codePoint: number, glyphId: number): Uint8Array {
  const bytes = new Uint8Array(72);
  const view = new DataView(bytes.buffer);
  writeTag(view, 0, "\u0000\u0001\u0000\u0000");
  view.setUint16(4, 1);
  writeTag(view, 12, "cmap");
  view.setUint32(20, 28);
  view.setUint32(24, 44);
  view.setUint16(30, 1);
  view.setUint16(32, 3);
  view.setUint16(34, 10);
  view.setUint32(36, 12);
  view.setUint16(40, 12);
  view.setUint32(44, 32);
  view.setUint32(52, 1);
  view.setUint32(56, codePoint);
  view.setUint32(60, codePoint);
  view.setUint32(64, glyphId);
  return bytes;
}

function format4Font(codePoint: number, glyphId: number): Uint8Array {
  const bytes = new Uint8Array(88);
  const view = new DataView(bytes.buffer);
  writeTag(view, 0, "\u0000\u0001\u0000\u0000");
  view.setUint16(4, 1);
  writeTag(view, 12, "cmap");
  view.setUint32(20, 28);
  view.setUint32(24, 60);
  view.setUint16(30, 1);
  view.setUint16(32, 3);
  view.setUint16(34, 1);
  view.setUint32(36, 12);
  view.setUint16(40, 4);
  view.setUint16(42, 32);
  view.setUint16(46, 4);
  view.setUint16(48, 4);
  view.setUint16(50, 1);
  view.setUint16(52, 0);
  view.setUint16(54, codePoint);
  view.setUint16(56, 0xffff);
  view.setUint16(60, codePoint);
  view.setUint16(62, 0xffff);
  view.setInt16(64, normalizeInt16(glyphId - codePoint));
  view.setInt16(66, 1);
  view.setUint16(68, 0);
  view.setUint16(70, 0);
  return bytes;
}

function writeTag(view: DataView, offset: number, tag: string): void {
  for (let index = 0; index < 4; index += 1) {
    view.setUint8(offset + index, tag.charCodeAt(index));
  }
}

function normalizeInt16(value: number): number {
  const unsigned = value & 0xffff;
  return unsigned > 0x7fff ? unsigned - 0x1_0000 : unsigned;
}
