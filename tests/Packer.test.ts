import { describe, expect, test } from "bun:test";

import { Packer } from "../src/atlas/Packer";

describe("Packer", () => {
  test("fills, releases, merges, and reuses atlas rectangles", () => {
    const packer = new Packer(8, 8);
    const rectangles = [
      packer.allocate(4, 4),
      packer.allocate(4, 4),
      packer.allocate(4, 4),
      packer.allocate(4, 4),
    ];

    expect(rectangles.every((rectangle) => rectangle !== undefined)).toBe(true);
    expect(packer.allocate(1, 1)).toBeUndefined();
    for (const rectangle of rectangles) {
      packer.release(rectangle!);
    }
    expect(packer.allocate(8, 8)).toEqual({ x: 0, y: 0, width: 8, height: 8 });
  });

  test("validates dimensions and rejects foreign or duplicate releases", () => {
    const packer = new Packer(8, 8);
    const rectangle = packer.allocate(4, 4)!;

    expect(() => packer.allocate(0, 1)).toThrow(TypeError);
    expect(() => packer.release({ x: 0, y: 0, width: 1, height: 1 })).toThrow(RangeError);
    packer.release(rectangle);
    expect(() => packer.release(rectangle)).toThrow(RangeError);
  });
});
