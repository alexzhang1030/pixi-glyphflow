import { describe, expect, test } from "bun:test";

import { OUTLINE_COMPUTE_WGSL, OUTLINE_FRAGMENT_WGSL } from "../src/render/outline";

describe("outline compute shader", () => {
  test("exposes a derivative-free analytic coverage compute entry", () => {
    expect(OUTLINE_COMPUTE_WGSL).toContain("@compute @workgroup_size(8, 8, 1)");
    expect(OUTLINE_COMPUTE_WGSL).toContain("fn outline_coverage");
    expect(OUTLINE_COMPUTE_WGSL).toContain("textureStore(color_atlas");
    expect(OUTLINE_COMPUTE_WGSL).toContain("var<storage, read> curves: array<f32>");
    expect(OUTLINE_COMPUTE_WGSL).toContain("var<storage, read> spatial: array<i32>");
    expect(OUTLINE_COMPUTE_WGSL).not.toContain("fwidth");
  });

  test("exposes an analytic fragment entry for projected outline quads", () => {
    expect(OUTLINE_FRAGMENT_WGSL).toContain("@fragment");
    expect(OUTLINE_FRAGMENT_WGSL).toContain("fn outline_fragment");
    expect(OUTLINE_FRAGMENT_WGSL).toContain("fwidth(input.render_coord)");
    expect(OUTLINE_FRAGMENT_WGSL).toContain("fn outline_coverage");
  });
});
