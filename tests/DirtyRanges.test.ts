import { describe, expect, test } from "bun:test";

import { DirtyRanges } from "../src/render/DirtyRanges";

describe("DirtyRanges", () => {
  test("sorts and coalesces overlapping or adjacent byte ranges", () => {
    const ranges = new DirtyRanges();
    ranges.record(64, 32);
    ranges.record(0, 16);
    ranges.record(16, 16);
    ranges.record(80, 32);

    expect(ranges.publish()).toEqual([
      { offset: 0, length: 32 },
      { offset: 64, length: 48 },
    ]);
    expect(ranges.publish()).toEqual([]);
  });

  test("validates byte coordinates", () => {
    const ranges = new DirtyRanges();
    expect(() => ranges.record(-1, 1)).toThrow(TypeError);
    expect(() => ranges.record(0, 0)).toThrow(TypeError);
  });
});
