import { describe, expect, test } from "bun:test";

import { packHalf2x16, unpackHalf2x16 } from "../src/render/pack";

describe("packHalf2x16", () => {
  test("round-trips unit rotation and integer anchors", () => {
    expect(unpackHalf2x16(packHalf2x16(0, 1))).toEqual([0, 1]);
    expect(unpackHalf2x16(packHalf2x16(1, 0))).toEqual([1, 0]);
    expect(unpackHalf2x16(packHalf2x16(-1, 20))).toEqual([-1, 20]);
    expect(unpackHalf2x16(packHalf2x16(20, 10))).toEqual([20, 10]);
  });
});
