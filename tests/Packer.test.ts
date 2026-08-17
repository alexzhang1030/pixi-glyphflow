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

  test("packs a full page of equal tiles through the skyline then reuses holes", () => {
    const packer = new Packer(64, 64);
    const tiles: NonNullable<ReturnType<Packer["allocate"]>>[] = [];
    for (let index = 0; index < 64; index += 1) {
      const tile = packer.allocate(8, 8);
      expect(tile).toBeDefined();
      tiles.push(tile!);
    }
    expect(packer.allocate(8, 8)).toBeUndefined();
    packer.release(tiles[0]!);
    expect(packer.allocate(8, 8)).toEqual(tiles[0]);
  });

  test("packs equal-height cells along the current shelf then opens the next row", () => {
    const packer = new Packer(64, 64);
    const first = packer.allocate(16, 16);
    const second = packer.allocate(16, 16);
    const third = packer.allocate(16, 16);
    const fourth = packer.allocate(16, 16);
    const nextRow = packer.allocate(16, 16);

    expect(first).toEqual({ x: 0, y: 0, width: 16, height: 16 });
    expect(second).toEqual({ x: 16, y: 0, width: 16, height: 16 });
    expect(third).toEqual({ x: 32, y: 0, width: 16, height: 16 });
    expect(fourth).toEqual({ x: 48, y: 0, width: 16, height: 16 });
    expect(nextRow).toEqual({ x: 0, y: 16, width: 16, height: 16 });
  });

  test("keeps mixed heights inside the page without overlapping the current shelf", () => {
    const packer = new Packer(64, 64);
    const tall = packer.allocate(16, 16);
    const short = packer.allocate(8, 8);
    const again = packer.allocate(16, 16);
    const placed = [tall, short, again];

    expect(placed.every((rectangle) => rectangle !== undefined)).toBe(true);
    expect(overlaps(placed as PackedRect[])).toBe(false);
    expect(placed.every((rectangle) => inside(rectangle!, 64, 64))).toBe(true);
  });

  test("fills a 1024 page with 16×16 cells", () => {
    const packer = new Packer(1_024, 1_024);
    const started = performance.now();
    for (let index = 0; index < 4_096; index += 1) {
      expect(packer.allocate(16, 16)).toBeDefined();
    }
    expect(packer.allocate(16, 16)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(50);
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

type PackedRect = NonNullable<ReturnType<Packer["allocate"]>>;

function overlaps(rectangles: readonly PackedRect[]): boolean {
  for (let left = 0; left < rectangles.length; left += 1) {
    const a = rectangles[left]!;
    for (let right = left + 1; right < rectangles.length; right += 1) {
      const b = rectangles[right]!;
      if (
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y
      ) {
        return true;
      }
    }
  }
  return false;
}

function inside(rectangle: PackedRect, width: number, height: number): boolean {
  return (
    rectangle.x >= 0 &&
    rectangle.y >= 0 &&
    rectangle.x + rectangle.width <= width &&
    rectangle.y + rectangle.height <= height
  );
}
