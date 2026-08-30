import { describe, expect, test } from "bun:test";

import { FontRegistry } from "../src/FontRegistry";
import {
  HarfBuzzShaper,
  type HarfBuzzRuntimeLoader,
  type HarfBuzzShaperOptions,
} from "../src/shaping";

describe("HarfBuzzShaper", () => {
  test("lazily shapes complex-script glyphs into compact positioned runs", async () => {
    const { registry, runtime, shaper } = await createShaperFixture({
      source: new Uint8Array([1, 2, 3]),
    });

    const run = await shaper.shape({
      family: "Fixture",
      text: "سلام",
      fontSize: 32,
      direction: "rtl",
      language: "ar",
      script: "Arab",
      features: ["liga=1"],
    });

    expect(run).toMatchObject({
      source: "harfbuzz",
      text: "سلام",
      fontFamily: "Fixture",
      glyphCount: 3,
      direction: "rtl",
    });
    expect([...run.glyphIds]).toEqual([30, 20, 10]);
    expect([...run.clusters]).toEqual([3, 1, 0]);
    expect([...run.clusterEnds!]).toEqual([4, 3, 1]);
    expect(
      [...run.clusters].map((start, index) => run.text.slice(start, run.clusterEnds?.[index])),
    ).toEqual(["م", "لا", "س"]);
    expect(run.variationKey).toBe("");
    expect([...run.x]).toEqual([1, 11, 23]);
    expect([...run.xAdvance]).toEqual([10, 12, 8]);
    expect(runtime.loads()).toBe(1);
    expect(runtime.shapes()).toBe(1);
    expect(shaper.stats).toMatchObject({ cacheEntries: 1, hits: 0, misses: 1, shapes: 1 });

    expect(
      await shaper.shape({
        family: "Fixture",
        text: "سلام",
        fontSize: 32,
        direction: "rtl",
        language: "ar",
        script: "Arab",
        features: ["liga=1"],
      }),
    ).toBe(run);
    expect(shaper.stats.hits).toBe(1);
    expect(runtime.shapes()).toBe(1);

    destroyShaperFixture(shaper, registry);
  });

  test("invalidates cached resources when the font revision changes", async () => {
    const { registry, shaper } = await createShaperFixture();

    const first = await shaper.shape({ family: "Fixture", text: "abc", fontSize: 16 });
    registry.unregister("Fixture");
    await registry.register({ family: "Fixture", source: new Uint8Array([2]) });
    const second = await shaper.shape({ family: "Fixture", text: "abc", fontSize: 16 });

    expect(second).not.toBe(first);
    expect(second.fontRevision).toBeGreaterThan(first.fontRevision);
    expect(shaper.getGlyphPath("Fixture", 30, 16)).resolves.toBe("M0,0L1,1Z");

    destroyShaperFixture(shaper, registry);
  });

  test("rejects a font revision that changes while the runtime loads", async () => {
    let releaseRuntime!: () => void;
    const runtimeBarrier = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const { registry, shaper } = await createShaperFixture({
      runtime: { loadBarrier: runtimeBarrier },
    });

    const pending = shaper.shape({ family: "Fixture", text: "abc", fontSize: 16 });
    await Promise.resolve();
    registry.unregister("Fixture");
    const replacement = await registry.register({
      family: "Fixture",
      source: new Uint8Array([2]),
    });
    releaseRuntime();

    await expect(pending).rejects.toThrow(
      `Font revision 1 is stale; current revision is ${String(replacement.revision)}`,
    );
    expect(shaper.stats.fontResourceEntries).toBe(0);

    destroyShaperFixture(shaper, registry);
  });

  test("retains shared combining-mark clusters and canonical variation axes", async () => {
    const { registry, runtime, shaper } = await createShaperFixture({
      runtime: {
        infos: [
          { codepoint: 91, cluster: 0, flags: 0 },
          { codepoint: 92, cluster: 0, flags: 0 },
        ],
        positions: [
          { xAdvance: 640, yAdvance: 0, xOffset: 0, yOffset: 0 },
          { xAdvance: 0, yAdvance: 0, xOffset: -64, yOffset: 64 },
        ],
      },
    });

    const run = await shaper.shape({
      family: "Fixture",
      text: "a\u0301",
      fontSize: 24,
      variations: { wght: 700, wdth: 90 },
    });

    expect([...run.clusters]).toEqual([0, 0]);
    expect([...run.clusterEnds!]).toEqual([2, 2]);
    expect(
      [...run.clusters].map((start, index) => run.text.slice(start, run.clusterEnds?.[index])),
    ).toEqual(["a\u0301", "a\u0301"]);
    expect(run.variationKey).toBe("wdth=90,wght=700");
    expect(
      await shaper.shape({
        family: "Fixture",
        text: "a\u0301",
        fontSize: 24,
        variations: { wdth: 90, wght: 700 },
      }),
    ).toBe(run);
    expect(runtime.shapes()).toBe(1);

    destroyShaperFixture(shaper, registry);
  });

  test("rejects malformed variation tags before a shaped-run cache lookup", async () => {
    const { registry, runtime, shaper } = await createShaperFixture();
    const base = { family: "Fixture", text: "axes", fontSize: 16 } as const;

    const valid = await shaper.shape({ ...base, variations: { abcd: 1, efgh: 2 } });
    expect(valid.variationKey).toBe("abcd=1,efgh=2");
    await expect(shaper.shape({ ...base, variations: { "abcd=1,efgh": 2 } })).rejects.toThrow(
      "Invalid font variation: abcd=1,efgh=2",
    );
    expect(runtime.shapes()).toBe(1);

    destroyShaperFixture(shaper, registry);
  });

  test("validates variation records and finite values before loading the runtime", async () => {
    const { registry, runtime, shaper } = await createShaperFixture();
    const base = { family: "Fixture", text: "axes", fontSize: 16 } as const;

    await expect(
      shaper.shape({
        ...base,
        variations: null as unknown as Readonly<Record<string, number>>,
      }),
    ).rejects.toThrow("variations must be an axis record");
    await expect(
      shaper.shape({ ...base, variations: { wght: Number.POSITIVE_INFINITY } }),
    ).rejects.toThrow("Invalid font variation: wght=Infinity");
    expect(runtime.loads()).toBe(0);
    expect(shaper.stats).toMatchObject({ hits: 0, misses: 0 });

    destroyShaperFixture(shaper, registry);
  });

  test("rejects malformed variation tags before a glyph-path font cache lookup", async () => {
    const { registry, shaper } = await createShaperFixture();

    await expect(shaper.getGlyphPath("Fixture", 30, 16, { abcd: 1, efgh: 2 })).resolves.toBe(
      "M0,0L1,1Z",
    );
    await expect(shaper.getGlyphPath("Fixture", 30, 16, { "abcd=1,efgh": 2 })).rejects.toThrow(
      "Invalid font variation: abcd=1,efgh=2",
    );
    expect(shaper.stats.fontResourceEntries).toBe(1);

    destroyShaperFixture(shaper, registry);
  });

  test("resolves shared RTL clusters against logical UTF-16 boundaries", async () => {
    const { registry, shaper } = await createShaperFixture({
      runtime: {
        infos: [
          { codepoint: 90, cluster: 3, flags: 0 },
          { codepoint: 80, cluster: 1, flags: 0 },
          { codepoint: 81, cluster: 1, flags: 0 },
          { codepoint: 70, cluster: 0, flags: 0 },
        ],
        positions: [
          { xAdvance: 640, yAdvance: 0, xOffset: 0, yOffset: 0 },
          { xAdvance: 512, yAdvance: 0, xOffset: 0, yOffset: 0 },
          { xAdvance: 0, yAdvance: 0, xOffset: -64, yOffset: 64 },
          { xAdvance: 640, yAdvance: 0, xOffset: 0, yOffset: 0 },
        ],
      },
    });

    const run = await shaper.shape({
      family: "Fixture",
      text: "سلام",
      fontSize: 24,
      direction: "rtl",
    });

    expect([...run.clusters]).toEqual([3, 1, 1, 0]);
    expect([...run.clusterEnds!]).toEqual([4, 3, 3, 1]);
    expect(
      [...run.clusters].map((start, index) => run.text.slice(start, run.clusterEnds?.[index])),
    ).toEqual(["م", "لا", "لا", "س"]);

    destroyShaperFixture(shaper, registry);
  });

  test("separates language and script fields containing tuple delimiters", async () => {
    const { registry, runtime, shaper } = await createShaperFixture();
    const base = { family: "Fixture", text: "shape", fontSize: 16 } as const;

    const first = await shaper.shape({ ...base, language: "x\0y", script: "z" });
    const second = await shaper.shape({ ...base, language: "x", script: "y\0z" });

    expect(second).not.toBe(first);
    expect(runtime.shapes()).toBe(2);
    expect(shaper.stats.cacheEntries).toBe(2);

    destroyShaperFixture(shaper, registry);
  });

  test("bounds shaped-run caching with LRU recency and eviction telemetry", async () => {
    const { registry, runtime, shaper } = await createShaperFixture({
      shaper: { cacheSize: 2 },
    });
    const shape = (text: string) => shaper.shape({ family: "Fixture", text, fontSize: 16 });

    await shape("aaaa");
    await shape("bbbb");
    await shape("aaaa");
    await shape("cccc");
    await shape("bbbb");

    expect(runtime.shapes()).toBe(4);
    expect(shaper.stats).toMatchObject({ cacheEntries: 2, cacheEvictions: 2, hits: 1, misses: 4 });

    destroyShaperFixture(shaper, registry);
  });

  test("bounds font resources by entries and bytes with eviction telemetry", async () => {
    const { registry, shaper } = await createShaperFixture({
      source: new Uint8Array([1, 2, 3]),
      shaper: { fontResourceCacheEntries: 10, fontResourceCacheBytes: 5 },
    });

    await shaper.shape({ family: "Fixture", text: "aaaa", fontSize: 16 });
    await shaper.shape({ family: "Fixture", text: "bbbb", fontSize: 17 });

    expect(shaper.stats).toMatchObject({
      fontObjects: 1,
      fontResourceEntries: 1,
      fontResourceBytes: 3,
      fontResourceEvictions: 1,
    });

    destroyShaperFixture(shaper, registry);
  });

  test("shares a family revision source and releases it with the final font", async () => {
    const { registry, runtime, shaper } = await createShaperFixture({
      shaper: { fontResourceCacheEntries: 1 },
    });

    await shaper.shape({ family: "Fixture", text: "aaaa", fontSize: 16 });
    await shaper.shape({ family: "Fixture", text: "bbbb", fontSize: 17 });

    expect(runtime.destroyedResources()).toEqual({ blobs: 0, faces: 0, fonts: 1 });
    shaper.clear();
    expect(runtime.destroyedResources()).toEqual({ blobs: 1, faces: 1, fonts: 2 });
    await shaper.shape({ family: "Fixture", text: "cccc", fontSize: 18 });
    shaper.destroy();
    expect(runtime.destroyedResources()).toEqual({ blobs: 2, faces: 2, fonts: 3 });

    registry.destroy();
  });

  test("releases the final family source in dependency order on eviction", async () => {
    const { registry, runtime, shaper } = await createShaperFixture({
      shaper: { fontResourceCacheEntries: 1 },
    });
    await registry.register({ family: "Other", source: new Uint8Array([2]) });

    await shaper.shape({ family: "Fixture", text: "aaaa", fontSize: 16 });
    await shaper.shape({ family: "Other", text: "bbbb", fontSize: 16 });

    expect(runtime.destroyedResources()).toEqual({ blobs: 1, faces: 1, fonts: 1 });
    expect(runtime.releaseOrder()).toEqual(["font", "face", "blob"]);

    destroyShaperFixture(shaper, registry);
  });

  test("completes all live release work once and preserves the first destroy failure", async () => {
    const fontDestroyError = new Error("injected font destroy failure");
    const faceDestroyError = new Error("injected face destroy failure");
    const { registry, runtime, shaper } = await createShaperFixture({
      runtime: { fontDestroyError, faceDestroyError },
    });

    await shaper.shape({ family: "Fixture", text: "aaaa", fontSize: 16 });
    await shaper.shape({ family: "Fixture", text: "bbbb", fontSize: 17 });

    let releaseError: unknown;
    try {
      shaper.clear();
    } catch (error) {
      releaseError = error;
    }

    expect(releaseError).toBe(fontDestroyError);
    expect(runtime.releaseOrder()).toEqual(["font", "font", "face", "blob"]);
    expect(runtime.destroyedResources()).toEqual({ blobs: 1, faces: 1, fonts: 2 });
    expect(shaper.clear()).toBe(0);
    expect(runtime.destroyedResources()).toEqual({ blobs: 1, faces: 1, fonts: 2 });

    await shaper.shape({ family: "Fixture", text: "cccc", fontSize: 18 });
    expect(runtime.createdResources()).toEqual({ blobs: 2, faces: 2, fonts: 3 });
    shaper.destroy();
    expect(runtime.destroyedResources()).toEqual({ blobs: 2, faces: 2, fonts: 3 });
    registry.destroy();
  });

  test("completes source release once when face destruction fails", async () => {
    const faceDestroyError = new Error("injected face destroy failure");
    const { registry, runtime, shaper } = await createShaperFixture({
      runtime: { faceDestroyError },
    });

    await shaper.shape({ family: "Fixture", text: "aaaa", fontSize: 16 });

    let releaseError: unknown;
    try {
      shaper.destroy();
    } catch (error) {
      releaseError = error;
    }

    expect(releaseError).toBe(faceDestroyError);
    expect(runtime.releaseOrder()).toEqual(["font", "face", "blob"]);
    expect(runtime.destroyedResources()).toEqual({ blobs: 1, faces: 1, fonts: 1 });
    shaper.destroy();
    expect(runtime.destroyedResources()).toEqual({ blobs: 1, faces: 1, fonts: 1 });
    registry.destroy();
  });

  test("completes invalid-face rollback when face destruction fails", async () => {
    const faceDestroyError = new Error("injected face destroy failure");
    const { registry, runtime, shaper } = await createShaperFixture({
      runtime: { faceUpem: 0, faceDestroyError },
    });

    let shapeError: unknown;
    try {
      await shaper.shape({ family: "Fixture", text: "aaaa", fontSize: 16 });
    } catch (error) {
      shapeError = error;
    }

    expect(shapeError).toEqual(
      new TypeError("Binary font has an invalid units-per-em value: Fixture"),
    );
    expect(runtime.releaseOrder()).toEqual(["face", "blob"]);
    expect(runtime.destroyedResources()).toEqual({ blobs: 1, faces: 1, fonts: 0 });
    shaper.destroy();
    expect(runtime.destroyedResources()).toEqual({ blobs: 1, faces: 1, fonts: 0 });
    registry.destroy();
  });

  test("completes font-setup rollback and preserves its first failure", async () => {
    const fontSetupError = new Error("injected font setup failure");
    const fontDestroyError = new Error("injected font destroy failure");
    const faceDestroyError = new Error("injected face destroy failure");
    const { registry, runtime, shaper } = await createShaperFixture({
      runtime: { fontSetupError, fontDestroyError, faceDestroyError },
    });

    let shapeError: unknown;
    try {
      await shaper.shape({ family: "Fixture", text: "aaaa", fontSize: 16 });
    } catch (error) {
      shapeError = error;
    }

    expect(shapeError).toBe(fontSetupError);
    expect(runtime.releaseOrder()).toEqual(["font", "face", "blob"]);
    expect(runtime.destroyedResources()).toEqual({ blobs: 1, faces: 1, fonts: 1 });

    await expect(
      shaper.shape({ family: "Fixture", text: "bbbb", fontSize: 17 }),
    ).resolves.toMatchObject({ glyphCount: 3 });
    expect(runtime.createdResources()).toEqual({ blobs: 2, faces: 2, fonts: 2 });
    shaper.destroy();
    expect(runtime.destroyedResources()).toEqual({ blobs: 2, faces: 2, fonts: 2 });
    registry.destroy();
  });

  test("rolls back a new font insertion after eviction cleanup fails", async () => {
    const fontDestroyError = new Error("injected old font destroy failure");
    const { registry, runtime, shaper } = await createShaperFixture({
      runtime: { fontDestroyError },
      shaper: { fontResourceCacheEntries: 1 },
    });

    await shaper.shape({ family: "Fixture", text: "aaaa", fontSize: 16 });
    let insertionError: unknown;
    try {
      await shaper.shape({ family: "Fixture", text: "bbbb", fontSize: 17 });
    } catch (error) {
      insertionError = error;
    }

    expect(insertionError).toBe(fontDestroyError);
    expect(runtime.releaseOrder()).toEqual(["font", "font", "face", "blob"]);
    expect(runtime.destroyedResources()).toEqual({ blobs: 1, faces: 1, fonts: 2 });

    await expect(
      shaper.shape({ family: "Fixture", text: "bbbb", fontSize: 17 }),
    ).resolves.toMatchObject({ glyphCount: 3 });
    expect(runtime.createdResources()).toEqual({ blobs: 2, faces: 2, fonts: 3 });

    shaper.destroy();
    expect(runtime.releaseOrder()).toEqual([
      "font",
      "font",
      "face",
      "blob",
      "font",
      "face",
      "blob",
    ]);
    expect(runtime.destroyedResources()).toEqual({ blobs: 2, faces: 2, fonts: 3 });
    registry.destroy();
  });

  test("returns the font borrow when buffer cleanup fails", async () => {
    const bufferClearError = new Error("injected buffer clear failure");
    const { registry, runtime, shaper } = await createShaperFixture({
      runtime: { bufferClearError },
    });

    let shapeError: unknown;
    try {
      await shaper.shape({ family: "Fixture", text: "aaaa", fontSize: 16 });
    } catch (error) {
      shapeError = error;
    }

    expect(shapeError).toBe(bufferClearError);
    expect(shaper.stats.pooledBuffers).toBe(0);
    expect(shaper.clear()).toBe(2);
    expect(runtime.releaseOrder()).toEqual(["font", "face", "blob"]);
    expect(runtime.destroyedResources()).toEqual({ blobs: 1, faces: 1, fonts: 1 });
    expect(shaper.clear()).toBe(0);
    expect(runtime.destroyedResources()).toEqual({ blobs: 1, faces: 1, fonts: 1 });

    await shaper.shape({ family: "Fixture", text: "bbbb", fontSize: 17 });
    shaper.destroy();
    expect(runtime.destroyedResources()).toEqual({ blobs: 2, faces: 2, fonts: 2 });
    registry.destroy();
  });

  test("preserves a shaping failure through simultaneous buffer cleanup failure", async () => {
    const shapeError = new Error("injected shaping failure");
    const bufferClearError = new Error("injected buffer clear failure");
    const { registry, runtime, shaper } = await createShaperFixture({
      runtime: { shapeError, bufferClearError },
    });

    let receivedError: unknown;
    try {
      await shaper.shape({ family: "Fixture", text: "aaaa", fontSize: 16 });
    } catch (error) {
      receivedError = error;
    }

    expect(receivedError).toBe(shapeError);
    expect(shaper.stats.pooledBuffers).toBe(0);
    expect(shaper.clear()).toBe(1);
    expect(runtime.releaseOrder()).toEqual(["font", "face", "blob"]);
    expect(runtime.destroyedResources()).toEqual({ blobs: 1, faces: 1, fonts: 1 });

    await expect(
      shaper.shape({ family: "Fixture", text: "bbbb", fontSize: 17 }),
    ).resolves.toMatchObject({ glyphCount: 3 });
    shaper.destroy();
    expect(runtime.destroyedResources()).toEqual({ blobs: 2, faces: 2, fonts: 2 });
    registry.destroy();
  });

  test("preserves a glyph-path failure through simultaneous resource release failure", async () => {
    const glyphPathError = new Error("injected glyph path failure");
    const fontDestroyError = new Error("injected font destroy failure");
    const { registry, runtime, shaper } = await createShaperFixture({
      source: new Uint8Array([1, 2]),
      runtime: { glyphPathError, fontDestroyError },
      shaper: { fontResourceCacheBytes: 1 },
    });

    let receivedError: unknown;
    try {
      await shaper.getGlyphPath("Fixture", 30, 16);
    } catch (error) {
      receivedError = error;
    }

    expect(receivedError).toBe(glyphPathError);
    expect(runtime.releaseOrder()).toEqual(["font", "face", "blob"]);
    expect(runtime.destroyedResources()).toEqual({ blobs: 1, faces: 1, fonts: 1 });
    await expect(shaper.getGlyphPath("Fixture", 30, 16)).resolves.toBe("M0,0L1,1Z");
    expect(runtime.createdResources()).toEqual({ blobs: 2, faces: 2, fonts: 2 });
    expect(runtime.destroyedResources()).toEqual({ blobs: 2, faces: 2, fonts: 2 });

    shaper.destroy();
    expect(runtime.destroyedResources()).toEqual({ blobs: 2, faces: 2, fonts: 2 });
    registry.destroy();
  });

  test("keeps an evicted font alive through concurrent shaping", async () => {
    const { registry, runtime, shaper } = await createShaperFixture({
      shaper: { fontResourceCacheEntries: 1 },
    });

    const [first, second] = await Promise.all([
      shaper.shape({ family: "Fixture", text: "aaaa", fontSize: 16 }),
      shaper.shape({ family: "Fixture", text: "bbbb", fontSize: 17 }),
    ]);

    expect(first.glyphCount).toBe(3);
    expect(second.glyphCount).toBe(3);
    expect(runtime.destroyedResources()).toEqual({ blobs: 0, faces: 0, fonts: 1 });

    destroyShaperFixture(shaper, registry);
  });

  test("rejects invalid variations before constructing HarfBuzz resources", async () => {
    const { registry, runtime, shaper } = await createShaperFixture();

    await expect(
      shaper.shape({
        family: "Fixture",
        text: "aaaa",
        fontSize: 16,
        variations: { invalid: 42 },
      }),
    ).rejects.toThrow("Invalid font variation: invalid=42");

    expect(runtime.loads()).toBe(0);
    expect(runtime.destroyedResources()).toEqual({ blobs: 0, faces: 0, fonts: 0 });
    expect(shaper.stats).toMatchObject({ fontResourceEntries: 0, fontResourceBytes: 0 });

    destroyShaperFixture(shaper, registry);
  });

  test("keys font resources by family, revision, size, and canonical variations", async () => {
    const { registry, shaper } = await createShaperFixture();
    await registry.register({ family: "Other", source: new Uint8Array([2]) });

    await shaper.shape({
      family: "Fixture",
      text: "aaaa",
      fontSize: 16,
      variations: { wght: 700, wdth: 90 },
    });
    await shaper.shape({
      family: "Fixture",
      text: "bbbb",
      fontSize: 16,
      variations: { wdth: 90, wght: 700 },
    });
    expect(shaper.stats.fontResourceEntries).toBe(1);

    await shaper.shape({
      family: "Fixture",
      text: "cccc",
      fontSize: 17,
      variations: { wght: 700, wdth: 90 },
    });
    await shaper.shape({
      family: "Fixture",
      text: "dddd",
      fontSize: 17,
      variations: { wght: 600, wdth: 90 },
    });
    registry.unregister("Fixture");
    await registry.register({ family: "Fixture", source: new Uint8Array([3]) });
    await shaper.shape({ family: "Fixture", text: "eeee", fontSize: 17 });
    await shaper.shape({ family: "Other", text: "ffff", fontSize: 17 });

    expect(shaper.stats).toMatchObject({
      fontObjects: 5,
      fontResourceEntries: 5,
      fontResourceBytes: 5,
    });

    destroyShaperFixture(shaper, registry);
  });

  test("applies bounded font resource defaults with the existing shaped-run default", async () => {
    const { registry, shaper } = await createShaperFixture();

    for (let identity = 0; identity < 65; identity += 1) {
      await shaper.shape({
        family: "Fixture",
        text: `identity-${String(identity)}`,
        fontSize: identity + 1,
      });
    }

    expect(shaper.stats).toMatchObject({
      fontResourceEntries: 64,
      fontResourceBytes: 64,
      fontResourceEvictions: 1,
      cacheEntries: 65,
      cacheEvictions: 0,
    });

    destroyShaperFixture(shaper, registry);
  });

  test("bounds retained font metadata after one million resource identities", async () => {
    const { registry, runtime, shaper } = await createShaperFixture({
      shaper: { fontResourceCacheEntries: 32, fontResourceCacheBytes: 32 },
    });

    for (let identity = 0; identity < 1_000_000; identity += 1) {
      await shaper.getGlyphPath("Fixture", 30, identity + 1);
    }

    expect(shaper.stats).toMatchObject({
      fontObjects: 32,
      fontResourceEntries: 32,
      fontResourceBytes: 32,
      fontResourceEvictions: 1_000_000 - 32,
    });
    expect(runtime.destroyedResources()).toEqual({
      blobs: 0,
      faces: 0,
      fonts: 1_000_000 - 32,
    });

    shaper.destroy();
    expect(runtime.destroyedResources()).toEqual({
      blobs: 1,
      faces: 1,
      fonts: 1_000_000,
    });
    registry.destroy();
  }, 30_000);
});

interface FakeRuntimeFixture {
  readonly infos?: Array<{ codepoint: number; cluster: number; flags: number }>;
  readonly positions?: Array<{
    xAdvance: number;
    yAdvance: number;
    xOffset: number;
    yOffset: number;
  }>;
  readonly loadBarrier?: Promise<void>;
  readonly fontDestroyError?: Error;
  readonly faceDestroyError?: Error;
  readonly bufferClearError?: Error;
  readonly faceUpem?: number;
  readonly fontSetupError?: Error;
  readonly shapeError?: Error;
  readonly glyphPathError?: Error;
}

interface ShaperFixtureOptions {
  readonly source?: Uint8Array;
  readonly runtime?: FakeRuntimeFixture;
  readonly shaper?: Omit<HarfBuzzShaperOptions, "loadRuntime">;
}

async function createShaperFixture(options: ShaperFixtureOptions = {}) {
  const registry = new FontRegistry();
  await registry.register({ family: "Fixture", source: options.source ?? new Uint8Array([1]) });
  const runtime = fakeRuntime(options.runtime);
  const shaper = new HarfBuzzShaper(registry, { ...options.shaper, loadRuntime: runtime.load });
  return { registry, runtime, shaper };
}

function destroyShaperFixture(shaper: HarfBuzzShaper, registry: FontRegistry): void {
  shaper.destroy();
  registry.destroy();
}

function fakeRuntime(fixture?: FakeRuntimeFixture): {
  readonly load: HarfBuzzRuntimeLoader;
  readonly loads: () => number;
  readonly shapes: () => number;
  readonly destroyedResources: () => {
    readonly blobs: number;
    readonly faces: number;
    readonly fonts: number;
  };
  readonly createdResources: () => {
    readonly blobs: number;
    readonly faces: number;
    readonly fonts: number;
  };
  readonly releaseOrder: () => readonly string[];
} {
  let loadCount = 0;
  let shapeCount = 0;
  let createdBlobs = 0;
  let createdFaces = 0;
  let createdFonts = 0;
  let destroyedBlobs = 0;
  let destroyedFaces = 0;
  let destroyedFonts = 0;
  let fontDestroyError = fixture?.fontDestroyError;
  let faceDestroyError = fixture?.faceDestroyError;
  let bufferClearError = fixture?.bufferClearError;
  let fontSetupError = fixture?.fontSetupError;
  let shapeError = fixture?.shapeError;
  let glyphPathError = fixture?.glyphPathError;
  const releaseOrder: string[] = [];

  class FakeBlob {
    constructor(readonly data: Uint8Array | ArrayBuffer) {
      createdBlobs += 1;
    }
    destroy(): void {
      destroyedBlobs += 1;
      releaseOrder.push("blob");
    }
  }

  class FakeFace {
    readonly upem = fixture?.faceUpem ?? 1_000;
    constructor(readonly blob: FakeBlob) {
      createdFaces += 1;
    }
    destroy(): void {
      destroyedFaces += 1;
      releaseOrder.push("face");
      const error = faceDestroyError;
      faceDestroyError = undefined;
      if (error !== undefined) throw error;
    }
  }

  class FakeVariation {
    constructor(
      readonly tag: string,
      readonly value: number,
    ) {}
  }

  class FakeFont {
    scale = 64;
    destroyed = false;
    constructor(readonly face: FakeFace) {
      createdFonts += 1;
    }
    setScale(x: number): void {
      this.ensureAlive();
      const error = fontSetupError;
      fontSetupError = undefined;
      if (error !== undefined) throw error;
      this.scale = x;
    }
    setVariations(): void {
      this.ensureAlive();
    }
    glyphExtents(): { xBearing: number; yBearing: number; width: number; height: number } {
      this.ensureAlive();
      return { xBearing: 0, yBearing: 64, width: 64, height: -64 };
    }
    hExtents(): { ascender: number; descender: number; lineGap: number } {
      this.ensureAlive();
      return { ascender: 64, descender: -16, lineGap: 0 };
    }
    glyphToPath(): string {
      this.ensureAlive();
      const error = glyphPathError;
      glyphPathError = undefined;
      if (error !== undefined) throw error;
      return "M0,0L1,1Z";
    }
    destroy(): void {
      this.ensureAlive();
      this.destroyed = true;
      destroyedFonts += 1;
      releaseOrder.push("font");
      const error = fontDestroyError;
      fontDestroyError = undefined;
      if (error !== undefined) throw error;
    }
    ensureAlive(): void {
      if (this.destroyed) throw new Error("Fake HarfBuzz font was released while active");
    }
  }

  class FakeBuffer {
    text = "";
    infos: Array<{ codepoint: number; cluster: number; flags: number }> = [];
    positions: Array<{
      xAdvance: number;
      yAdvance: number;
      xOffset: number;
      yOffset: number;
    }> = [];
    addText(text: string): void {
      this.text = text;
    }
    guessSegmentProperties(): void {}
    setDirection(): void {}
    setLanguage(): void {}
    setScript(): void {}
    clearContents(): void {
      const error = bufferClearError;
      bufferClearError = undefined;
      if (error !== undefined) throw error;
      this.text = "";
      this.infos = [];
      this.positions = [];
    }
    getGlyphInfos(): typeof this.infos {
      return this.infos;
    }
    getGlyphPositions(): typeof this.positions {
      return this.positions;
    }
  }

  const load = (async () => {
    loadCount += 1;
    await fixture?.loadBarrier;
    return {
      Blob: FakeBlob,
      Face: FakeFace,
      Font: FakeFont,
      Variation: FakeVariation,
      Buffer: FakeBuffer,
      Direction: { LTR: 4, RTL: 5 },
      Feature: {
        fromString(value: string) {
          return value.length > 0 ? { value } : undefined;
        },
      },
      shape(font: FakeFont, buffer: FakeBuffer) {
        font.ensureAlive();
        shapeCount += 1;
        const error = shapeError;
        shapeError = undefined;
        if (error !== undefined) throw error;
        buffer.infos = fixture?.infos ?? [
          { codepoint: 30, cluster: 3, flags: 0 },
          { codepoint: 20, cluster: 1, flags: 0 },
          { codepoint: 10, cluster: 0, flags: 0 },
        ];
        buffer.positions = fixture?.positions ?? [
          { xAdvance: 640, yAdvance: 0, xOffset: 64, yOffset: 0 },
          { xAdvance: 768, yAdvance: 0, xOffset: 64, yOffset: 0 },
          { xAdvance: 512, yAdvance: 0, xOffset: 64, yOffset: 0 },
        ];
      },
    } as unknown as Awaited<ReturnType<HarfBuzzRuntimeLoader>>;
  }) satisfies HarfBuzzRuntimeLoader;

  return {
    load,
    loads: () => loadCount,
    shapes: () => shapeCount,
    destroyedResources: () => ({
      blobs: destroyedBlobs,
      faces: destroyedFaces,
      fonts: destroyedFonts,
    }),
    createdResources: () => ({ blobs: createdBlobs, faces: createdFaces, fonts: createdFonts }),
    releaseOrder: () => releaseOrder,
  };
}
