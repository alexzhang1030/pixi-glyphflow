import { describe, expect, test } from "bun:test";

import {
  packGlyphIdentity,
  resolveGlyphIdentity,
  unpackGlyphIdentity,
} from "../src/atlas/glyphIdentity";

const latin = {
  fontFamily: "Inter",
  fontRevision: 1,
  glyphId: 65,
  glyphText: "A",
  fontSize: 16,
  fontWeight: "normal" as const,
  mode: "msdf" as const,
};

describe("glyphIdentity", () => {
  test("packs the live-path atlas key without building a string", () => {
    const first = resolveGlyphIdentity(latin);
    const second = resolveGlyphIdentity({ ...latin, glyphText: "different" });

    expect(typeof first.key).toBe("number");
    expect(first.key).toBe(second.key);
    expect(first.fontSize).toBe(16);
    expect(first.fontWeight).toBe("normal");
    expect(unpackGlyphIdentity(first.key as number)).toMatchObject({
      glyphId: 65,
      fontSize: 16,
      fontWeight: 400,
      mode: "msdf",
      fontRevision: 1,
    });
  });

  test("buckets nearby font sizes so raster and cache stay aligned", () => {
    const low = resolveGlyphIdentity({ ...latin, fontSize: 16.2 });
    const mid = resolveGlyphIdentity({ ...latin, fontSize: 16.4 });
    const high = resolveGlyphIdentity({ ...latin, fontSize: 16.6 });

    expect(low.key).toBe(mid.key);
    expect(low.fontSize).toBe(16);
    expect(mid.fontSize).toBe(16);
    expect(high.fontSize).toBe(17);
    expect(high.key).not.toBe(low.key);
  });

  test("falls back to a diagnostic string when the identity cannot pack", () => {
    const emoji = resolveGlyphIdentity({
      ...latin,
      glyphId: 0,
      glyphText: "🙂",
      mode: "color",
    });
    const ligature = resolveGlyphIdentity({
      ...latin,
      glyphId: 0,
      glyphText: "fi",
    });
    const heavy = resolveGlyphIdentity({
      ...latin,
      fontWeight: "bolder",
    });

    expect(typeof emoji.key).toBe("string");
    expect(typeof ligature.key).toBe("string");
    expect(typeof heavy.key).toBe("string");
    expect(packGlyphIdentity({ ...latin, fontRevision: 256 })).toBeUndefined();
  });

  test("keeps distinct families, modes, and revisions on different keys", () => {
    const otherFamily = resolveGlyphIdentity({ ...latin, fontFamily: "Noto Sans" });
    const otherMode = resolveGlyphIdentity({ ...latin, mode: "alpha" });
    const otherRevision = resolveGlyphIdentity({ ...latin, fontRevision: 2 });

    expect(otherFamily.key).not.toBe(resolveGlyphIdentity(latin).key);
    expect(otherMode.key).not.toBe(resolveGlyphIdentity(latin).key);
    expect(otherRevision.key).not.toBe(resolveGlyphIdentity(latin).key);
    expect(resolveGlyphIdentity({ ...latin, fontWeight: "bold" }).key).toBe(
      resolveGlyphIdentity({ ...latin, fontWeight: "700" }).key,
    );
  });

  test("keeps the same font-local glyph distinct across variable-font axes", () => {
    const regular = resolveGlyphIdentity({ ...latin, variationKey: "wdth=100,wght=400" });
    const condensed = resolveGlyphIdentity({ ...latin, variationKey: "wdth=75,wght=400" });

    expect(typeof regular.key).toBe("string");
    expect(regular.key).not.toBe(condensed.key);
    expect(regular.key).toBe(
      resolveGlyphIdentity({ ...latin, variationKey: "wdth=100,wght=400" }).key,
    );
  });

  test("keeps embedded separators inside glyph text and variation identity unambiguous", () => {
    const first = resolveGlyphIdentity({
      ...latin,
      glyphText: "x\u0000y",
      variationKey: "z",
    });
    const second = resolveGlyphIdentity({
      ...latin,
      glyphText: "x",
      variationKey: "y\u0000z",
    });

    expect(typeof first.key).toBe("string");
    expect(typeof second.key).toBe("string");
    expect(first.key).not.toBe(second.key);
  });
});
