import { describe, expect, test } from "bun:test";

import {
  TRANSFORM_EFFECT_STRIDE,
  TRANSFORM_PALETTE_STRIDE,
  TransformPalette,
} from "../src/advanced";
import { bitsFromFloat, unpackHalf2x16 } from "../src/render/pack";

describe("TransformPalette", () => {
  test("stores a 32-byte fill-only record with packed rotation and color", () => {
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
    expect(palette.stats).toMatchObject({
      coreStride: TRANSFORM_PALETTE_STRIDE,
      effectBase: 0,
    });
    const values = palette.data.subarray(8, 16);
    expect(Array.from(values.slice(0, 4))).toEqual([10, 20, 2, 3]);
    expect(halves(values[4] ?? 0)[0]).toBeCloseTo(1);
    expect(halves(values[4] ?? 0)[1]).toBeCloseTo(0);
    expect(halves(values[5] ?? 0)).toEqual([20, 10]);
    expect(values[6]).toBe(0x336699);
    expect(values[7]).toBe(255 + 128 * 256);
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

  test("allocates a sparse effect texel after the core region on first stroke", () => {
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

    expect(palette.stats).toMatchObject({
      coreStride: TRANSFORM_PALETTE_STRIDE,
      effectBase: 2,
    });
    const core = palette.data.subarray(0, 8);
    expect(core[6]).toBe(0x336699);
    expect(core[7]).toBe(128 + 128 * 256 + 65_536);
    const effects = palette.data.subarray(8, 12);
    expect(effects[0]).toBe(0xff0000);
    expect(effects[1]).toBe(40 + 191 * 4096);
    expect(effects[2]).toBe(0x0000ff);
    expect(effects[3]).toBe(144 + 128 * 256 + 3 * 65_536 + 8 * 1_048_576);
    expect(palette.consumeDirty()).toEqual([{ offset: 0, length: palette.data.byteLength }]);

    palette.destroy();
  });

  test("patches occupied x/y texels without rewriting the packed fill payload", () => {
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
    expect(palette.data[6]).toBe(0x336699);
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
    expect(palette.stats).toMatchObject({
      capacity: 8,
      activeLabels: 1,
      textureWidth: 4,
      coreStride: TRANSFORM_PALETTE_STRIDE,
      effectBase: 0,
    });
    palette.consumeDirty();
    expect(palette.remove(4)).toBe(true);
    expect(palette.data[4 * 8 + 7]).toBe(0);
    expect(palette.consumeDirty()).toEqual([
      { offset: 4 * TRANSFORM_PALETTE_STRIDE, length: TRANSFORM_PALETTE_STRIDE },
    ]);

    palette.destroy();
  });

  test("relocates effect texels when the core region grows", () => {
    const palette = new TransformPalette({ initialCapacity: 1, textureWidth: 4 });
    palette.set(
      0,
      {
        x: 1,
        y: 2,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        alpha: 1,
        visible: true,
        anchorX: 0,
        anchorY: 0,
        fill: 0xffffff,
        stroke: { color: 0xff0000, width: 1, alpha: 1 },
      },
      { width: 1, height: 1 },
    );
    palette.consumeDirty();
    palette.set(
      2,
      {
        x: 3,
        y: 4,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        alpha: 1,
        visible: true,
        anchorX: 0,
        anchorY: 0,
        fill: 0x00ff00,
        stroke: { color: 0x0000ff, width: 2, alpha: 1 },
      },
      { width: 1, height: 1 },
    );

    expect(palette.stats).toMatchObject({ capacity: 4, effectBase: 8 });
    expect(palette.data[6]).toBe(0xffffff);
    expect(palette.data[4 * 8]).toBe(0xff0000);
    expect(palette.data[2 * 8 + 6]).toBe(0x00ff00);
    expect(palette.data[4 * 8 + 2 * 4]).toBe(0x0000ff);
    expect(palette.consumeDirty()[0]).toEqual({
      offset: 0,
      length: palette.data.byteLength,
    });
    expect(TRANSFORM_EFFECT_STRIDE).toBe(16);

    palette.destroy();
  });
});

function halves(value: number): readonly [number, number] {
  return unpackHalf2x16(bitsFromFloat(value));
}
