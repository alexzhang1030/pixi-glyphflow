import { describe, expect, test } from "bun:test";

import { FontRegistry } from "../src";
import { HarfBuzzShaper, type HarfBuzzRuntimeLoader } from "../src/shaping";

describe("HarfBuzzShaper", () => {
  test("lazily shapes complex-script glyphs into compact positioned runs", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture", source: new Uint8Array([1, 2, 3]) });
    const runtime = fakeRuntime();
    const shaper = new HarfBuzzShaper(registry, { loadRuntime: runtime.load });

    const run = await shaper.shape({
      family: "Fixture",
      text: "سلام",
      fontSize: 32,
      direction: "rtl",
      language: "ar",
      script: "Arab",
      features: ["liga=1"],
    });

    expect(run).toMatchObject({
      source: "harfbuzz",
      text: "سلام",
      fontFamily: "Fixture",
      glyphCount: 3,
      direction: "rtl",
    });
    expect([...run.glyphIds]).toEqual([30, 20, 10]);
    expect([...run.clusters]).toEqual([3, 1, 0]);
    expect([...run.x]).toEqual([1, 11, 23]);
    expect([...run.xAdvance]).toEqual([10, 12, 8]);
    expect(runtime.loads()).toBe(1);
    expect(runtime.shapes()).toBe(1);
    expect(shaper.stats).toMatchObject({ cacheEntries: 1, hits: 0, misses: 1, shapes: 1 });

    expect(
      await shaper.shape({
        family: "Fixture",
        text: "سلام",
        fontSize: 32,
        direction: "rtl",
        language: "ar",
        script: "Arab",
        features: ["liga=1"],
      }),
    ).toBe(run);
    expect(shaper.stats.hits).toBe(1);
    expect(runtime.shapes()).toBe(1);

    shaper.destroy();
    registry.destroy();
  });

  test("invalidates cached resources when the font revision changes", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture", source: new Uint8Array([1]) });
    const runtime = fakeRuntime();
    const shaper = new HarfBuzzShaper(registry, { loadRuntime: runtime.load });

    const first = await shaper.shape({ family: "Fixture", text: "abc", fontSize: 16 });
    registry.unregister("Fixture");
    await registry.register({ family: "Fixture", source: new Uint8Array([2]) });
    const second = await shaper.shape({ family: "Fixture", text: "abc", fontSize: 16 });

    expect(second).not.toBe(first);
    expect(second.fontRevision).toBeGreaterThan(first.fontRevision);
    expect(shaper.getGlyphPath("Fixture", 30, 16)).resolves.toBe("M0,0L1,1Z");

    shaper.destroy();
    registry.destroy();
  });
});

function fakeRuntime(): {
  readonly load: HarfBuzzRuntimeLoader;
  readonly loads: () => number;
  readonly shapes: () => number;
} {
  let loadCount = 0;
  let shapeCount = 0;

  class FakeBlob {
    constructor(readonly data: Uint8Array | ArrayBuffer) {}
  }

  class FakeFace {
    readonly upem = 1_000;
    constructor(readonly blob: FakeBlob) {}
  }

  class FakeFont {
    scale = 64;
    constructor(readonly face: FakeFace) {}
    setScale(x: number): void {
      this.scale = x;
    }
    setVariations(): void {}
    glyphExtents(): { xBearing: number; yBearing: number; width: number; height: number } {
      return { xBearing: 0, yBearing: 64, width: 64, height: -64 };
    }
    hExtents(): { ascender: number; descender: number; lineGap: number } {
      return { ascender: 64, descender: -16, lineGap: 0 };
    }
    glyphToPath(): string {
      return "M0,0L1,1Z";
    }
  }

  class FakeBuffer {
    text = "";
    infos: Array<{ codepoint: number; cluster: number; flags: number }> = [];
    positions: Array<{
      xAdvance: number;
      yAdvance: number;
      xOffset: number;
      yOffset: number;
    }> = [];
    addText(text: string): void {
      this.text = text;
    }
    guessSegmentProperties(): void {}
    setDirection(): void {}
    setLanguage(): void {}
    setScript(): void {}
    getGlyphInfos(): typeof this.infos {
      return this.infos;
    }
    getGlyphPositions(): typeof this.positions {
      return this.positions;
    }
  }

  const load = (async () => {
    loadCount += 1;
    return {
      Blob: FakeBlob,
      Face: FakeFace,
      Font: FakeFont,
      Buffer: FakeBuffer,
      Direction: { LTR: 4, RTL: 5 },
      Feature: {
        fromString(value: string) {
          return value.length > 0 ? { value } : undefined;
        },
      },
      shape(_font: FakeFont, buffer: FakeBuffer) {
        shapeCount += 1;
        buffer.infos = [
          { codepoint: 30, cluster: 3, flags: 0 },
          { codepoint: 20, cluster: 1, flags: 0 },
          { codepoint: 10, cluster: 0, flags: 0 },
        ];
        buffer.positions = [
          { xAdvance: 640, yAdvance: 0, xOffset: 64, yOffset: 0 },
          { xAdvance: 768, yAdvance: 0, xOffset: 64, yOffset: 0 },
          { xAdvance: 512, yAdvance: 0, xOffset: 64, yOffset: 0 },
        ];
      },
    } as unknown as Awaited<ReturnType<HarfBuzzRuntimeLoader>>;
  }) satisfies HarfBuzzRuntimeLoader;

  return {
    load,
    loads: () => loadCount,
    shapes: () => shapeCount,
  };
}
