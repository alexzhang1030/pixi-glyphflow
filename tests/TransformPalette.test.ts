import { describe, expect, test } from "bun:test";

import { TRANSFORM_PALETTE_STRIDE, TransformPalette } from "../src/advanced";

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
    const values = palette.data.subarray(16, 32);
    expect(Array.from(values.slice(0, 4))).toEqual([10, 20, 2, 3]);
    expect(values[4]).toBeCloseTo(1);
    expect(values[5]).toBeCloseTo(0);
    expect(Array.from(values.slice(6, 8))).toEqual([20, 10]);
    expect(values[8]).toBeCloseTo(0.2);
    expect(values[9]).toBeCloseTo(0.4);
    expect(values[10]).toBeCloseTo(0.6);
    expect(values[11]).toBe(255 + 128 * 256);
    expect(Array.from(values.slice(12, 16))).toEqual([0, 0, 0, 32_896]);
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

  test("packs fill alpha, stroke, and drop shadow into one effect texel", () => {
    const palette = new TransformPalette({ initialCapacity: 1, textureWidth: 4 });
    palette.set(
      0,
      {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        alpha: 0.5,
        visible: true,
        anchorX: 0,
        anchorY: 0,
        fill: { color: 0x336699, alpha: 0.5 },
        stroke: { color: 0xff0000, width: 2.5, alpha: 0.75 },
        dropShadow: { color: 0x0000ff, alpha: 0.5, angle: 0, distance: 4, blur: 3 },
      },
      { width: 10, height: 10 },
    );

    const values = palette.data.subarray(0, 16);
    expect(values[8]).toBeCloseTo(0.2);
    expect(values[9]).toBeCloseTo(0.4);
    expect(values[10]).toBeCloseTo(0.6);
    expect(values[11]).toBe(128 + 128 * 256);
    expect(values[12]).toBe(0xff0000);
    expect(values[13]).toBe(40 + 191 * 4096);
    expect(values[14]).toBe(0x0000ff);
    expect(values[15]).toBe(144 + 128 * 256 + 3 * 65_536 + 8 * 1_048_576);

    palette.destroy();
  });

  test("patches occupied x/y texels without rewriting the effect payload", () => {
    const palette = new TransformPalette({ initialCapacity: 1, textureWidth: 4 });
    palette.set(
      0,
      {
        x: 10,
        y: 20,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        alpha: 1,
        visible: true,
        anchorX: 0,
        anchorY: 0,
        fill: 0x336699,
      },
      { width: 1, height: 1 },
    );
    palette.consumeDirty();

    expect(palette.setPosition(0, 11, 22)).toBe(true);
    expect(Array.from(palette.data.subarray(0, 2))).toEqual([11, 22]);
    expect(palette.data[8]).toBeCloseTo(0.2);
    expect(palette.consumeDirty()).toEqual([{ offset: 0, length: 16 }]);
    expect(palette.setPosition(0, 11, 22)).toBe(false);
    expect(palette.setPosition(4, 0, 0)).toBe(false);

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
    expect(palette.data[4 * 16 + 11]).toBe(0);
    expect(palette.consumeDirty()).toEqual([
      { offset: 4 * TRANSFORM_PALETTE_STRIDE, length: TRANSFORM_PALETTE_STRIDE },
    ]);

    palette.destroy();
  });
});
