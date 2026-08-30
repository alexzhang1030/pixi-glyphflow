import { describe, expect, test } from "bun:test";

import { createShapingWasmFixture } from "../benchmarks/shaping-simd/wasm-fixture";

describe("reproducible shaping SIMD fixture", () => {
  test("scalar and SIMD modules produce identical glyph-id output", async () => {
    const corpus = Uint32Array.from([1, 2, 0x627, 0x915, 42, 77, 101, 999]);
    const baseline = createShapingWasmFixture({ corpus, simd: false });
    const variant = createShapingWasmFixture({ corpus, simd: true });

    await baseline.run();
    await variant.run();

    expect(Array.from(baseline.output())).toEqual(Array.from(corpus, (value) => value + 31));
    expect([...variant.output()]).toEqual([...baseline.output()]);
    expect(await variant.hash()).toBe(await baseline.hash());
  });
});
