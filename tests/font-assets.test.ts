import { describe, expect, test } from "bun:test";

describe("documentation font assets", () => {
  test("uses a static Medium CJK outline for deterministic MSDF rasterization", async () => {
    const bytes = new Uint8Array(
      await Bun.file(
        new URL("../site/public/fonts/noto-sans-cjkv-demo.ttf", import.meta.url),
      ).arrayBuffer(),
    );
    const tables = readTableDirectory(bytes);
    const os2 = tables.get("OS/2");

    expect(tables.has("fvar")).toBe(false);
    expect(os2).toBeDefined();
    if (os2 === undefined) return;
    expect(new DataView(bytes.buffer, bytes.byteOffset + os2, 6).getUint16(4)).toBe(500);
  });
});

function readTableDirectory(bytes: Uint8Array): ReadonlyMap<string, number> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4);
  const tables = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(
      bytes[record] ?? 0,
      bytes[record + 1] ?? 0,
      bytes[record + 2] ?? 0,
      bytes[record + 3] ?? 0,
    );
    tables.set(tag, view.getUint32(record + 8));
  }
  return tables;
}
