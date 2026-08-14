import { describe, expect, test } from "bun:test";

import { BitmapLayoutAdapter } from "../src";

describe("BitmapLayoutAdapter", () => {
  test("maps PixiJS bitmap layout data into a compact positioned run", () => {
    const adapter = new BitmapLayoutAdapter(fakeManager());
    const run = adapter.layout({
      text: "AB\n中",
      style: { fontFamily: "Fixture", fontSize: 20, lineHeight: 24 },
      fontRevision: 7,
    });

    expect(run).toMatchObject({
      source: "bitmap",
      text: "AB\n中",
      fontFamily: "Fixture",
      fontRevision: 7,
      glyphCount: 3,
      direction: "ltr",
      bounds: { x: 0, y: 0, width: 20, height: 48 },
    });
    expect([...run.glyphIds]).toEqual([101, 102, 20013]);
    expect([...run.clusters]).toEqual([0, 1, 3]);
    expect([...run.x]).toEqual([0, 10, 0]);
    expect([...run.y]).toEqual([2, 2, 26]);
    expect([...run.xAdvance]).toEqual([10, 10, 20]);
    expect([...run.lineIndices]).toEqual([0, 0, 1]);
    expect(run.glyphKeys).toEqual(["A", "B", "中"]);
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.bounds)).toBe(true);
    expect(Object.isFrozen(run.glyphKeys)).toBe(true);
  });

  test("keys cached runs by font revision and style", () => {
    const adapter = new BitmapLayoutAdapter(fakeManager());
    const input = {
      text: "AB",
      style: { fontFamily: "Fixture", fontSize: 20 },
      fontRevision: 1,
    } as const;

    const first = adapter.layout(input);
    const second = adapter.layout(input);
    const revised = adapter.layout({ ...input, fontRevision: 2 });

    expect(second).toBe(first);
    expect(revised).not.toBe(first);
    expect(adapter.stats).toEqual({ entries: 2, hits: 1, misses: 2 });
    expect(adapter.clear()).toBe(2);
  });

  test("limits wrapped lines and appends an ellipsis within the wrap width", () => {
    const adapter = new BitmapLayoutAdapter(fakeManager());
    const run = adapter.layout({
      text: "AB\n中",
      style: {
        fontFamily: "Fixture",
        fontSize: 20,
        lineHeight: 24,
        wordWrap: true,
        wordWrapWidth: 20,
      },
      maxLines: 1,
      ellipsis: "…",
    });

    expect(run.glyphKeys).toEqual(["A", "…"]);
    expect([...run.glyphIds]).toEqual([101, 8_230]);
    expect([...run.x]).toEqual([0, 10]);
    expect(run.bounds).toEqual({ x: 0, y: 0, width: 20, height: 24 });
  });

  test("preserves emoji grapheme keys and Pixi-managed spacing positions", () => {
    const adapter = new BitmapLayoutAdapter(fakeManager());
    const run = adapter.layout({
      text: "A🙂",
      style: {
        fontFamily: "Fixture",
        fontSize: 20,
        align: "center",
        letterSpacing: 2,
      },
    });

    expect(run.glyphKeys).toEqual(["A", "🙂"]);
    expect([...run.glyphIds]).toEqual([101, 128_578]);
    expect([...run.clusters]).toEqual([0, 1]);
    expect([...run.x]).toEqual([5, 17]);
    expect([...run.xAdvance]).toEqual([12, 17]);
  });
});

function fakeManager(): ConstructorParameters<typeof BitmapLayoutAdapter>[0] {
  return {
    getFont() {
      return {
        chars: {
          A: { id: 101 },
          B: { id: 102 },
          中: { id: 20_013 },
          "…": { id: 8_230 },
          "🙂": { id: 128_578 },
        },
        lineHeight: 24,
      };
    },
    getLayout(text) {
      if (text === "…") {
        return {
          width: 10,
          height: 24,
          scale: 1,
          offsetY: 2,
          lines: [{ width: 10, charPositions: [0], chars: ["…"] }],
        };
      }
      if (text === "AB") {
        return {
          width: 20,
          height: 24,
          scale: 1,
          offsetY: 2,
          lines: [{ width: 20, charPositions: [0, 10], chars: ["A", "B"] }],
        };
      }
      if (text === "A🙂") {
        return {
          width: 34,
          height: 24,
          scale: 1,
          offsetY: 2,
          lines: [{ width: 34, charPositions: [5, 17], chars: ["A", "🙂"] }],
        };
      }
      return {
        width: 20,
        height: 48,
        scale: 1,
        offsetY: 2,
        lines: [
          { width: 20, charPositions: [0, 10], chars: ["A", "B"] },
          { width: 20, charPositions: [0], chars: ["中"] },
        ],
      };
    },
  };
}
