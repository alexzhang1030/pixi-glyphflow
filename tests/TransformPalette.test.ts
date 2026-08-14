import { describe, expect, test } from "bun:test";

import { TRANSFORM_PALETTE_STRIDE, TransformPalette } from "../src";

describe("TransformPalette", () => {
  test("stores one affine, anchor, visibility, and premultiplied color record per label", () => {
    const palette = new TransformPalette({ initialCapacity: 2, textureWidth: 4 });
    const changed = palette.set(
      1,
      {
        x: 10,
        y: 20,
        scaleX: 2,
        scaleY: 3,
        rotation: Math.PI / 2,
        alpha: 0.5,
        visible: true,
        anchorX: 0.5,
        anchorY: 1,
        fill: 0x336699,
      },
      { width: 40, height: 10 },
    );

    expect(changed).toBe(true);
    const values = palette.data.subarray(12, 24);
    expect(Array.from(values.slice(0, 4))).toEqual([10, 20, 2, 3]);
    expect(values[4]).toBeCloseTo(1);
    expect(values[5]).toBeCloseTo(0);
    expect(Array.from(values.slice(6, 8))).toEqual([20, 10]);
    expect(values[8]).toBeCloseTo(0.1);
    expect(values[9]).toBeCloseTo(0.2);
    expect(values[10]).toBeCloseTo(0.3);
    expect(values[11]).toBeCloseTo(0.5);
    expect(palette.consumeDirty()).toEqual([
      { offset: TRANSFORM_PALETTE_STRIDE, length: TRANSFORM_PALETTE_STRIDE },
    ]);
    expect(
      palette.set(
        1,
        {
          x: 10,
          y: 20,
          scaleX: 2,
          scaleY: 3,
          rotation: Math.PI / 2,
          alpha: 0.5,
          visible: true,
          anchorX: 0.5,
          anchorY: 1,
          fill: 0x336699,
        },
        { width: 40, height: 10 },
      ),
    ).toBe(false);
    expect(palette.consumeDirty()).toEqual([]);

    palette.destroy();
  });

  test("grows geometrically and hides removed labels through palette alpha", () => {
    const palette = new TransformPalette({ initialCapacity: 1, textureWidth: 4 });
    const before = palette.data.buffer;
    palette.set(
      4,
      {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        alpha: 1,
        visible: true,
        anchorX: 0,
        anchorY: 0,
        fill: 0xffffff,
      },
      { width: 1, height: 1 },
    );

    expect(palette.data.buffer).not.toBe(before);
    expect(palette.stats).toMatchObject({ capacity: 8, activeLabels: 1, textureWidth: 4 });
    palette.consumeDirty();
    expect(palette.remove(4)).toBe(true);
    expect(palette.data[4 * 12 + 11]).toBe(0);
    expect(palette.consumeDirty()).toEqual([
      { offset: 4 * TRANSFORM_PALETTE_STRIDE, length: TRANSFORM_PALETTE_STRIDE },
    ]);

    palette.destroy();
  });
});
