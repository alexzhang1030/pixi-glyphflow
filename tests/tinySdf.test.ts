import { describe, expect, test } from "bun:test";

import { encodeTinySdf, TINY_SDF_RADIUS } from "../src/atlas/tinySdf";

describe("encodeTinySdf", () => {
  test("keeps a solid mask above the 0.5 contour and empty space below it", () => {
    const filled = encodeTinySdf(new Uint8Array(16).fill(255), 4, 4, 2);
    const empty = encodeTinySdf(new Uint8Array(16).fill(0), 4, 4, 2);
    expect([...filled].every((value) => value >= 128)).toBe(true);
    expect([...empty].every((value) => value <= 128)).toBe(true);
  });

  test("puts the contour on a vertical edge", () => {
    const alpha = new Uint8Array(16 * 8);
    for (let y = 0; y < 8; y += 1) {
      alpha.fill(255, y * 16, y * 16 + 8);
    }
    const field = encodeTinySdf(alpha, 16, 8, 4);
    expect(field[3]).toBeGreaterThan(128);
    expect(field[12]).toBeLessThan(128);
    expect(field[7]).toBeGreaterThan(128);
    expect(field[8]).toBeLessThan(128);
    expect((field[7] ?? 0) - (field[8] ?? 0)).toBeGreaterThan(20);
  });

  test("rejects inconsistent masks", () => {
    expect(() => encodeTinySdf(new Uint8Array(3), 2, 2)).toThrow(TypeError);
    expect(() => encodeTinySdf(new Uint8Array(4), 2, 2, 0)).toThrow(TypeError);
  });

  test("uses the default radius", () => {
    expect(TINY_SDF_RADIUS).toBe(8);
    expect(encodeTinySdf(new Uint8Array([255]), 1, 1)).toHaveLength(1);
  });
});
