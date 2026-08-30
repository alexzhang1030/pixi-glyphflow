import { describe, expect, test } from "bun:test";

import { BoundedCache } from "../src/cache";

describe("BoundedCache", () => {
  test("requires a size function for byte-bounded caches", () => {
    expect(() => new BoundedCache<string, string>({ maxBytes: 5 })).toThrow(
      "sizeOf is required when maxBytes is configured",
    );
  });

  test("evicts the least-recently-used entry and reports capacity telemetry", () => {
    const evicted: string[] = [];
    const cache = new BoundedCache<string, number>({
      maxEntries: 2,
      policy: "lru",
      onEviction: ({ key }) => evicted.push(key),
    });

    cache.set("A", 1);
    cache.set("B", 2);
    expect(cache.get("A")).toBe(1);
    expect(cache.get("missing")).toBeUndefined();
    cache.set("C", 3);

    expect(cache.peek("A")).toBe(1);
    expect(cache.peek("B")).toBeUndefined();
    expect(cache.peek("C")).toBe(3);
    expect(evicted).toEqual(["B"]);
    expect(cache.stats).toMatchObject({
      policy: "lru",
      entries: 2,
      hits: 1,
      misses: 1,
      sets: 3,
      evictions: 1,
    });
  });

  test("keeps insertion order under FIFO reads", () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 2, policy: "fifo" });

    cache.set("A", 1);
    cache.set("B", 2);
    expect(cache.get("A")).toBe(1);
    cache.set("C", 3);

    expect(cache.peek("A")).toBeUndefined();
    expect(cache.peek("B")).toBe(2);
    expect(cache.peek("C")).toBe(3);
  });

  test("updates FIFO byte accounting while preserving the original insertion order", () => {
    const cache = new BoundedCache<string, Uint8Array>({
      maxEntries: 2,
      maxBytes: 10,
      policy: "fifo",
      sizeOf: (value) => value.byteLength,
    });

    cache.set("A", new Uint8Array(1));
    cache.set("B", new Uint8Array(1));
    cache.set("A", new Uint8Array(3));

    expect(cache.stats.bytes).toBe(4);
    cache.set("C", new Uint8Array(1));
    expect(cache.peek("A")).toBeUndefined();
    expect(cache.peek("B")).toHaveLength(1);
  });

  test("enforces a byte ceiling independently from entry count", () => {
    const cache = new BoundedCache<string, Uint8Array>({
      maxEntries: 10,
      maxBytes: 5,
      sizeOf: (value) => value.byteLength,
    });

    cache.set("A", new Uint8Array(3));
    cache.set("B", new Uint8Array(3));

    expect(cache.peek("A")).toBeUndefined();
    expect(cache.peek("B")).toHaveLength(3);
    expect(cache.stats).toMatchObject({ entries: 1, bytes: 3, evictions: 1, evictedBytes: 3 });
  });
});
