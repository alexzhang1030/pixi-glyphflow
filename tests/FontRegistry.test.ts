import { describe, expect, test } from "bun:test";

import { FontRegistry } from "../src";

describe("FontRegistry", () => {
  test("registers system and immutable binary sources with monotonic revisions", async () => {
    const registry = new FontRegistry();
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const system = await registry.register({ family: "Inter", source: { type: "system" } });
    const binary = await registry.register({ family: "Noto Sans", source: bytes });
    bytes[0] = 99;

    expect(system).toMatchObject({ family: "Inter", kind: "system", revision: 1, bytes: 0 });
    expect(binary).toMatchObject({ family: "Noto Sans", kind: "binary", revision: 2, bytes: 4 });
    expect(registry.get("Noto Sans")).toEqual(binary);
    expect(registry.stats).toMatchObject({
      revision: 2,
      registeredFonts: 2,
      systemFonts: 1,
      binaryFonts: 1,
      binaryBytes: 4,
    });
    expect(Object.isFrozen(registry.get("Noto Sans"))).toBe(true);
    expect(() => registry.register({ family: "Inter" })).toThrow(RangeError);

    registry.destroy();
  });

  test("loads URL sources through the injected fetch boundary", async () => {
    const requested: string[] = [];
    const registry = new FontRegistry({
      fetch: (async (input: string | URL | Request) => {
        requested.push(String(input));
        return new Response(new Uint8Array([10, 20, 30]));
      }) as typeof fetch,
    });

    await registry.register({
      family: "Remote",
      source: new URL("https://example.com/font.woff2"),
    });

    expect(requested).toEqual(["https://example.com/font.woff2"]);
    expect(registry.get("Remote")).toMatchObject({ kind: "binary", bytes: 3 });

    registry.destroy();
  });

  test("maintains fallback chains and deterministic lifetime", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Primary" });
    await registry.register({ family: "Fallback" });

    expect(registry.registerFallback("ui", ["Primary", "Fallback", "sans-serif"])).toBe(3);
    expect(registry.getFallback("ui")).toEqual(["Primary", "Fallback", "sans-serif"]);
    expect(Object.isFrozen(registry.getFallback("ui"))).toBe(true);
    expect(registry.unregister("Primary")).toBe(true);
    expect(registry.unregister("Primary")).toBe(false);
    expect(registry.stats).toMatchObject({ registeredFonts: 1, fallbackChains: 1, revision: 4 });

    expect(registry.clear()).toBe(2);
    expect(registry.stats).toMatchObject({ registeredFonts: 0, fallbackChains: 0, revision: 5 });
    registry.destroy();
    registry.destroy();
  });
});
