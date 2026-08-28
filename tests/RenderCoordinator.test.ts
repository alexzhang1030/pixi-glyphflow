import { describe, expect, test } from "bun:test";

import { FontRegistry, type PositionedRun } from "../src";
import {
  RenderCoordinator,
  type GlyphRaster,
  type RasterGlyphRequest,
  type RenderChange,
  type TextLayoutInput,
} from "../src/advanced";
import { unpackF16 } from "../src/render/pack";

const CONTENT = 1;
const TRANSFORM = 2;
const STYLE = 4;

describe("RenderCoordinator", () => {
  test("atomically shapes, stages atlas glyphs, writes instances, and isolates transform updates", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    let layoutCalls = 0;
    let rasterCalls = 0;
    let rasterFamilies: readonly string[] | undefined;
    let layoutInput: TextLayoutInput | undefined;
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        async layout(_slot, _revision, input) {
          layoutCalls += 1;
          layoutInput = input;
          return run(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(_request: RasterGlyphRequest): Promise<GlyphRaster> {
          rasterCalls += 1;
          rasterFamilies = _request.fontFamilies;
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 256 },
      instanceOptions: { initialCapacity: 4 },
      transformOptions: { initialCapacity: 4, textureWidth: 4 },
    });
    const first = {
      ...label(1, 10, 20),
      shaping: {
        direction: "rtl" as const,
        language: "ar",
        script: "Arab",
        features: Object.freeze(["kern"]),
        variations: Object.freeze({ wght: 520 }),
      },
    };

    const initial = await coordinator.commit(1, [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: first },
    ]);
    expect(initial).toMatchObject({ stale: false, appliedLabels: 1, glyphs: 2, atlasUploads: 2 });
    expect(coordinator.instances.getRange(0)).toEqual({ offset: 0, count: 2, capacity: 2 });
    expect(coordinator.transforms.stats.activeLabels).toBe(1);
    expect({ layoutCalls, rasterCalls }).toEqual({ layoutCalls: 1, rasterCalls: 2 });
    expect(rasterFamilies).toEqual(["Fixture", "sans-serif"]);
    expect(layoutInput).toMatchObject({
      direction: "rtl",
      language: "ar",
      script: "Arab",
      features: ["kern"],
      variations: { wght: 520 },
    });
    coordinator.instances.consumeDirty();
    coordinator.transforms.consumeDirty();
    const instanceBytes = new Uint8Array(coordinator.instances.buffer).slice();

    const moved = await coordinator.commit(2, [
      { slot: 0, mask: TRANSFORM, snapshot: label(1, 100, 200) },
    ]);
    expect(moved).toMatchObject({ stale: false, appliedLabels: 1, glyphs: 2, atlasUploads: 0 });
    expect({ layoutCalls, rasterCalls }).toEqual({ layoutCalls: 1, rasterCalls: 2 });
    expect(coordinator.instances.consumeDirty()).toEqual([]);
    expect(new Uint8Array(coordinator.instances.buffer)).toEqual(instanceBytes);
    expect(coordinator.transforms.consumeDirty()).toEqual([{ offset: 0, length: 32 }]);

    const shifted = await coordinator.commit(3, [
      { slot: 0, mask: TRANSFORM, snapshot: label(1, 104, 208), positionOnly: true },
    ]);
    expect(shifted).toMatchObject({ stale: false, appliedLabels: 1, glyphs: 2, atlasUploads: 0 });
    expect(coordinator.transforms.consumeDirty()).toEqual([{ offset: 0, length: 16 }]);
    expect(Array.from(coordinator.transforms.data.subarray(0, 2))).toEqual([104, 208]);

    await coordinator.commit(4, [{ slot: 0, mask: CONTENT, snapshot: undefined }]);
    expect(coordinator.instances.getRange(0)).toBeUndefined();
    expect(coordinator.transforms.stats.activeLabels).toBe(0);

    coordinator.destroy();
    registry.destroy();
  });

  test("retains runs and instances when a compute-cull working-set exit asks to keep resources", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    let layoutCalls = 0;
    let rasterCalls = 0;
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        async layout(_slot, _revision, input) {
          layoutCalls += 1;
          return run(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          rasterCalls += 1;
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 256 },
      instanceOptions: { initialCapacity: 4 },
      transformOptions: { initialCapacity: 4, textureWidth: 4 },
    });

    await coordinator.commit(1, [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 10, 20) },
    ]);
    expect({ layoutCalls, rasterCalls }).toEqual({ layoutCalls: 1, rasterCalls: 2 });
    expect(coordinator.getRun(0)?.text).toBe("AB");
    expect(coordinator.instances.getRange(0)).toEqual({ offset: 0, count: 2, capacity: 2 });

    await coordinator.commit(2, [
      { slot: 0, mask: CONTENT, snapshot: undefined, retainResources: true },
    ]);
    expect(coordinator.getRun(0)?.text).toBe("AB");
    expect(coordinator.instances.getRange(0)).toEqual({ offset: 0, count: 2, capacity: 2 });
    expect(coordinator.transforms.stats.activeLabels).toBe(1);
    expect(coordinator.getDrawStates()).toEqual([]);

    const restored = await coordinator.commit(3, [
      { slot: 0, mask: TRANSFORM, snapshot: label(1, 10, 20) },
    ]);
    expect(restored).toMatchObject({ stale: false, appliedLabels: 1, glyphs: 2, atlasUploads: 0 });
    expect({ layoutCalls, rasterCalls }).toEqual({ layoutCalls: 1, rasterCalls: 2 });
    expect(coordinator.getDrawStates()).toEqual([
      { slot: 0, zIndex: 0, order: 1, blendMode: "normal" },
    ]);

    coordinator.destroy();
    registry.destroy();
  });

  test("renders oversampled atlas glyphs at logical layout dimensions", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          return Promise.resolve(run(input.text));
        },
        destroy() {},
      },
      glyphProvider: {
        rasterize(request: RasterGlyphRequest): Promise<GlyphRaster> {
          return Promise.resolve({
            mode: request.mode,
            width: 24,
            height: 48,
            pixels: new Uint8Array(24 * 48).fill(255),
            metrics: { bearingX: 1, bearingY: 14, advance: 10, rasterScale: 3 },
          });
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 64, pageHeight: 64, maxBytes: 8_192 },
    });

    await coordinator.commit(1, [{ slot: 0, mask: CONTENT | STYLE, snapshot: label(1, 0, 0) }]);

    const view = new DataView(coordinator.instances.buffer);
    expect([
      unpackF16(view.getUint16(0, true)),
      unpackF16(view.getUint16(2, true)),
      unpackF16(view.getUint16(4, true)),
      unpackF16(view.getUint16(6, true)),
    ]).toEqual([1, -9, 8, 16]);
    expect(((view.getUint32(20, true) >>> 18) & 0x1fff) / 64).toBe(3);

    coordinator.destroy();
    registry.destroy();
  });

  test("keeps the newer label generation when asynchronous layouts resolve out of order", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const gates = new Map<string, () => void>();
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          return new Promise<Readonly<PositionedRun>>((resolve) => {
            gates.set(input.text, () => resolve(run(input.text)));
          });
        },
        destroy() {},
      },
      glyphProvider: {
        rasterize(request: RasterGlyphRequest): Promise<GlyphRaster> {
          return Promise.resolve({
            mode: request.mode,
            width: 2,
            height: 2,
            pixels: new Uint8Array(request.mode === "color" ? 16 : 4).fill(255),
          });
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
    });

    const older = coordinator.commit(1, [
      { slot: 0, mask: CONTENT | STYLE, snapshot: label(1, 0, 0, "old") },
    ]);
    await waitForGate(gates, "old");
    const newer = coordinator.commit(2, [
      { slot: 0, mask: CONTENT | STYLE, snapshot: label(2, 0, 0, "new") },
    ]);
    await waitForGate(gates, "new");
    gates.get("new")?.();
    expect(await newer).toMatchObject({ stale: false });
    gates.get("old")?.();
    expect(await older).toMatchObject({ stale: true, appliedLabels: 0 });
    expect(coordinator.getRun(0)?.text).toBe("new");

    coordinator.destroy();
    registry.destroy();
  });

  test("prepares every first-seen label in one commit", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    let layoutCalls = 0;
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        async layout(_slot, _revision, input) {
          layoutCalls += 1;
          return run(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 64, pageHeight: 64, maxBytes: 4_096 },
      instanceOptions: { initialCapacity: 32 },
      transformOptions: { initialCapacity: 16, textureWidth: 16 },
    });
    const firstSeen = Array.from({ length: 10 }, (_, slot) => ({
      slot,
      mask: CONTENT | TRANSFORM | STYLE,
      snapshot: label(1, slot * 10, 0, `L${String(slot)}`),
    }));

    const first = await coordinator.commit(1, firstSeen);
    expect(first).toMatchObject({ stale: false, appliedLabels: 10 });
    expect(layoutCalls).toBe(10);
    expect(coordinator.getRun(0)).toBeDefined();
    expect(coordinator.getRun(9)).toBeDefined();

    coordinator.destroy();
    registry.destroy();
  });

  test("shares instance ranges for duplicate strings after the first raster", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    let layoutCalls = 0;
    let rasterCalls = 0;
    const shared = run("AB");
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          layoutCalls += 1;
          return input.text === "AB" ? shared : run(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          rasterCalls += 1;
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 64, pageHeight: 64, maxBytes: 4_096 },
      instanceOptions: { initialCapacity: 32 },
      transformOptions: { initialCapacity: 16, textureWidth: 16 },
    });
    const duplicates = Array.from({ length: 8 }, (_, slot) => ({
      slot,
      mask: CONTENT | TRANSFORM | STYLE,
      snapshot: label(1, slot * 10, 0, "AB"),
    }));

    const first = await coordinator.commit(1, duplicates);
    expect(first).toMatchObject({ stale: false, appliedLabels: 8, glyphs: 16, atlasUploads: 2 });
    expect(layoutCalls).toBe(1);
    expect(rasterCalls).toBe(2);
    expect(coordinator.instances.getRange(0)).toEqual({ offset: 0, count: 2, capacity: 2 });
    expect(coordinator.instances.getRange(7)).toEqual({ offset: 0, count: 2, capacity: 2 });
    expect(coordinator.instances.stats.highWater).toBe(2);
    expect(coordinator.instances.stats.activeInstances).toBe(16);

    coordinator.destroy();
    registry.destroy();
  });

  test("patches palette x/y for content plus position when anchors stay zero", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    let layoutCalls = 0;
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          layoutCalls += 1;
          return run(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 64, pageHeight: 64, maxBytes: 4_096 },
      instanceOptions: { initialCapacity: 8 },
      transformOptions: { initialCapacity: 4, textureWidth: 4 },
    });

    await coordinator.commit(1, [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0, "AB") },
    ]);
    coordinator.transforms.consumeDirty();
    const dest = coordinator.instances.getRange(0);

    const next = await coordinator.commit(2, [
      {
        slot: 0,
        mask: CONTENT | TRANSFORM,
        snapshot: label(2, 12, 24, "CD"),
        positionOnly: true,
      },
    ]);
    expect(next).toMatchObject({ stale: false, appliedLabels: 1, glyphs: 2 });
    expect(layoutCalls).toBe(2);
    expect(coordinator.instances.getRange(0)).toEqual(dest);
    expect(coordinator.transforms.consumeDirty()).toEqual([{ offset: 0, length: 16 }]);
    expect(Array.from(coordinator.transforms.data.subarray(0, 2))).toEqual([12, 24]);

    coordinator.destroy();
    registry.destroy();
  });

  test("applies a broadcast content lane with one layout and a shared prototype", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    let layoutCalls = 0;
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          layoutCalls += 1;
          return run(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 64, pageHeight: 64, maxBytes: 4_096 },
      instanceOptions: { initialCapacity: 32 },
      transformOptions: { initialCapacity: 16, textureWidth: 16 },
    });
    const firstSeen = Array.from({ length: 8 }, (_, slot) => ({
      slot,
      mask: CONTENT | TRANSFORM | STYLE,
      snapshot: label(1, slot * 10, 0, "AB"),
    }));
    await coordinator.commit(1, firstSeen);
    coordinator.transforms.consumeDirty();
    const slots = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const xy = new Float32Array(16);
    for (let index = 0; index < 8; index += 1) {
      xy[index * 2] = index;
      xy[index * 2 + 1] = 1;
    }

    const next = await coordinator.applyContentLane({
      slots,
      count: 8,
      xy,
      text: "CD",
      style: { fontFamily: "Fixture", fontSize: 16, fill: 0xffffff },
    });
    expect(next).toMatchObject({ stale: false, appliedLabels: 8, glyphs: 16 });
    expect(layoutCalls).toBe(2);
    expect(coordinator.instances.getRange(3)).toEqual(coordinator.instances.getRange(0));
    expect(coordinator.instances.stats.activeInstances).toBe(16);
    expect(coordinator.instances.stats.highWater).toBeGreaterThanOrEqual(2);
    expect(coordinator.transforms.consumeDirty()).toEqual([{ offset: 0, length: 240 }]);
    expect(Array.from(coordinator.transforms.data.subarray(0, 2))).toEqual([0, 1]);

    coordinator.destroy();
    registry.destroy();
  });

  test("skips the CPU position scatter when the storage palette will patch", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          return run(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 64, pageHeight: 64, maxBytes: 4_096 },
      instanceOptions: { initialCapacity: 32 },
      transformOptions: { initialCapacity: 16, textureWidth: 16 },
    });
    const firstSeen = Array.from({ length: 4 }, (_, slot) => ({
      slot,
      mask: CONTENT | TRANSFORM | STYLE,
      snapshot: label(1, slot * 10, 0, "AB"),
    }));
    await coordinator.commit(1, firstSeen);
    coordinator.transforms.consumeDirty();
    const slots = new Uint32Array([0, 1, 2, 3]);
    const xy = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);

    const content = await coordinator.applyContentLane({
      slots,
      count: 4,
      xy,
      text: "CD",
      style: { fontFamily: "Fixture", fontSize: 16, fill: 0xffffff },
      writePalettePositions: false,
    });
    expect(content.appliedLabels).toBe(4);
    expect(coordinator.transforms.consumeDirty()).toEqual([]);
    expect(Array.from(coordinator.transforms.data.subarray(0, 2))).toEqual([0, 0]);

    const noted = coordinator.notePositionLane(4);
    expect(noted.appliedLabels).toBe(4);
    expect(coordinator.stats.transformOnlyLabels).toBe(4);
    expect(coordinator.transforms.consumeDirty()).toEqual([]);
    expect(Array.from(coordinator.transforms.data.subarray(0, 2))).toEqual([0, 0]);

    coordinator.destroy();
    registry.destroy();
  });

  test("admits first-seen duplicates with one layout and shared prototype bytes", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    let layoutCalls = 0;
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          layoutCalls += 1;
          return run(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 64, pageHeight: 64, maxBytes: 4_096 },
      instanceOptions: { initialCapacity: 32 },
      transformOptions: { initialCapacity: 16, textureWidth: 16 },
    });
    const slots = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const xy = new Float32Array(16);
    const orders = new Uint32Array(8);
    for (let index = 0; index < 8; index += 1) {
      xy[index * 2] = index * 10;
      xy[index * 2 + 1] = 0;
      orders[index] = index;
    }

    const first = await coordinator.applyAdmitLane([
      {
        slots,
        count: 8,
        xy,
        orders,
        text: "AB",
        style: { fontFamily: "Fixture", fontSize: 16, fill: 0x336699 },
      },
    ]);
    expect(first).toMatchObject({
      stale: false,
      appliedLabels: 8,
      glyphs: 16,
      drawOrderChanged: true,
    });
    expect(layoutCalls).toBe(1);
    expect(coordinator.instances.getRange(7)).toEqual({ offset: 0, count: 2, capacity: 2 });
    expect(coordinator.instances.stats.highWater).toBe(2);
    expect(coordinator.transforms.stats.activeLabels).toBe(8);
    expect(Array.from(coordinator.transforms.data.subarray(24, 26))).toEqual([30, 0]);
    expect(coordinator.transforms.data[30]).toBe(0x336699);
    expect(coordinator.getDrawStates()).toHaveLength(8);
    expect(coordinator.getDrawStates()[3]).toMatchObject({ slot: 3, zIndex: 0, order: 3 });
    expect(
      coordinator.hasInternedLayout({
        text: "AB",
        style: { fontFamily: "Fixture", fontSize: 16, fill: 0x336699 },
      }),
    ).toBe(true);
    expect(
      coordinator.hasInternedLayout({
        text: "ZZ",
        style: { fontFamily: "Fixture", fontSize: 16, fill: 0x336699 },
      }),
    ).toBe(false);

    coordinator.destroy();
    registry.destroy();
  });

  test("prepares unique admit groups in parallel", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const gates = new Map<string, () => void>();
    let layoutCalls = 0;
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          layoutCalls += 1;
          return new Promise<Readonly<PositionedRun>>((resolve) => {
            gates.set(input.text, () => resolve(run(input.text)));
          });
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 64, pageHeight: 64, maxBytes: 4_096 },
      instanceOptions: { initialCapacity: 16 },
      transformOptions: { initialCapacity: 8, textureWidth: 8 },
    });
    const style = { fontFamily: "Fixture", fontSize: 16, fill: 0xffffff };
    const first = coordinator.applyAdmitLane([
      {
        slots: new Uint32Array([0]),
        count: 1,
        xy: new Float32Array([0, 0]),
        orders: new Uint32Array([0]),
        text: "AB",
        style,
      },
      {
        slots: new Uint32Array([1]),
        count: 1,
        xy: new Float32Array([12, 0]),
        orders: new Uint32Array([1]),
        text: "CD",
        style,
      },
    ]);
    await waitForGate(gates, "AB");
    await waitForGate(gates, "CD");
    expect(layoutCalls).toBe(2);
    gates.get("AB")?.();
    gates.get("CD")?.();
    expect(await first).toMatchObject({ stale: false, appliedLabels: 2, glyphs: 4 });
    expect(coordinator.getRun(0)?.text).toBe("AB");
    expect(coordinator.getRun(1)?.text).toBe("CD");

    coordinator.destroy();
    registry.destroy();
  });

  test("writes one fill column for unique admit groups that share a fill", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          return run(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 64, pageHeight: 64, maxBytes: 4_096 },
      instanceOptions: { initialCapacity: 16 },
      transformOptions: { initialCapacity: 8, textureWidth: 8 },
    });
    let fillWrites = 0;
    const writeFills = coordinator.transforms.writeFills.bind(coordinator.transforms);
    coordinator.transforms.writeFills = (slots, count, xy, fill) => {
      fillWrites += 1;
      return writeFills(slots, count, xy, fill);
    };

    expect(
      await coordinator.applyAdmitLane([
        {
          slots: new Uint32Array([0]),
          count: 1,
          xy: new Float32Array([0, 0]),
          orders: new Uint32Array([0]),
          text: "AB",
          style: { fontFamily: "Fixture", fontSize: 16, fill: 0xffffff },
        },
        {
          slots: new Uint32Array([1]),
          count: 1,
          xy: new Float32Array([12, 4]),
          orders: new Uint32Array([1]),
          text: "CD",
          style: { fontFamily: "Fixture", fontSize: 16, fill: 0xffffff },
        },
      ]),
    ).toMatchObject({ stale: false, appliedLabels: 2 });
    expect(fillWrites).toBe(1);
    expect(Array.from(coordinator.transforms.data.subarray(0, 2))).toEqual([0, 0]);
    expect(Array.from(coordinator.transforms.data.subarray(8, 10))).toEqual([12, 4]);
    expect(coordinator.transforms.data[6]).toBe(0xffffff);
    expect(coordinator.transforms.data[14]).toBe(0xffffff);

    fillWrites = 0;
    expect(
      await coordinator.applyAdmitLane([
        {
          slots: new Uint32Array([2]),
          count: 1,
          xy: new Float32Array([24, 0]),
          orders: new Uint32Array([2]),
          text: "EF",
          style: { fontFamily: "Fixture", fontSize: 16, fill: 0xff0000 },
        },
        {
          slots: new Uint32Array([3]),
          count: 1,
          xy: new Float32Array([36, 0]),
          orders: new Uint32Array([3]),
          text: "GH",
          style: { fontFamily: "Fixture", fontSize: 16, fill: 0x00ff00 },
        },
      ]),
    ).toMatchObject({ stale: false, appliedLabels: 2 });
    expect(fillWrites).toBe(2);
    expect(coordinator.transforms.data[22]).toBe(0xff0000);
    expect(coordinator.transforms.data[30]).toBe(0x00ff00);

    coordinator.destroy();
    registry.destroy();
  });

  test("keeps the draw-list epoch while draw states only append", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          return run(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 64, pageHeight: 64, maxBytes: 4_096 },
      instanceOptions: { initialCapacity: 16 },
      transformOptions: { initialCapacity: 8, textureWidth: 8 },
    });

    await coordinator.commit(1, [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0) },
    ]);
    expect(coordinator.getDrawStates().length).toBe(1);
    const packedEpoch = coordinator.drawListEpoch;

    await coordinator.commit(2, [
      { slot: 1, mask: CONTENT | TRANSFORM | STYLE, snapshot: { ...label(1, 10, 0), order: 2 } },
    ]);
    expect(coordinator.getDrawStates().length).toBe(2);
    expect(coordinator.drawListEpoch).toBe(packedEpoch);

    await coordinator.commit(3, [{ slot: 0, mask: CONTENT, snapshot: undefined }]);
    coordinator.getDrawStates();
    const removedEpoch = coordinator.drawListEpoch;
    expect(removedEpoch).not.toBe(packedEpoch);

    await coordinator.commit(4, [
      {
        slot: 1,
        mask: TRANSFORM,
        snapshot: { ...label(1, 10, 0), order: 2, zIndex: 5 },
      },
    ]);
    coordinator.getDrawStates();
    expect(coordinator.drawListEpoch).not.toBe(removedEpoch);

    coordinator.destroy();
    registry.destroy();
  });

  test("rasterizes HarfBuzz misses with the real glyph text despite packed identities", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const rasterTexts: string[] = [];
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          const { glyphKeys: _glyphKeys, ...shaped } = run(input.text);
          return Object.freeze({ ...shaped, source: "harfbuzz" as const });
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(request: RasterGlyphRequest): Promise<GlyphRaster> {
          rasterTexts.push(request.glyphText);
          return {
            mode: "msdf",
            width: 4,
            height: 6,
            pixels: new Uint8Array(96).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4, fieldRange: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
      instanceOptions: { initialCapacity: 4 },
      transformOptions: { initialCapacity: 4, textureWidth: 4 },
    });

    await coordinator.commit(1, [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0) },
    ]);
    expect(rasterTexts).toEqual(["A", "B"]);

    coordinator.destroy();
    registry.destroy();
  });

  test("pins live atlas entries and unpins them when the last user leaves", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          return run(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 64, pageHeight: 64, maxBytes: 4_096 },
      instanceOptions: { initialCapacity: 8 },
      transformOptions: { initialCapacity: 4, textureWidth: 4 },
    });

    await coordinator.commit(1, [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0) },
      { slot: 1, mask: CONTENT | TRANSFORM | STYLE, snapshot: { ...label(1, 10, 0), order: 2 } },
    ]);
    // "AB" shares two glyph entries between both labels.
    expect(coordinator.atlas.stats.pinnedEntries).toBe(2);

    await coordinator.commit(2, [{ slot: 0, mask: CONTENT, snapshot: undefined }]);
    expect(coordinator.atlas.stats.pinnedEntries).toBe(2);

    await coordinator.commit(3, [{ slot: 1, mask: CONTENT, snapshot: undefined }]);
    expect(coordinator.atlas.stats.pinnedEntries).toBe(0);

    coordinator.destroy();
    registry.destroy();
  });

  test("requests TinySDF for HarfBuzz glyphs when the option is on", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const modes: string[] = [];
    const coordinator = new RenderCoordinator({
      registry,
      rasterizerOptions: { tinySdf: true },
      layoutEngine: {
        layout(_slot, _revision, input) {
          return Object.freeze({ ...run(input.text), source: "harfbuzz" as const });
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(request: RasterGlyphRequest): Promise<GlyphRaster> {
          modes.push(request.mode);
          return {
            mode: "sdf",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(200),
            metrics: { bearingX: 0, bearingY: 5, advance: 4, fieldRange: 8 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 256 },
      instanceOptions: { initialCapacity: 4 },
      transformOptions: { initialCapacity: 4, textureWidth: 4 },
    });

    await coordinator.commit(1, [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0) },
    ]);
    expect(modes).toEqual(["sdf", "sdf"]);

    coordinator.destroy();
    registry.destroy();
  });

  test("skips empty-ink scalars so spaces do not raster or instance", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const rasterTexts: string[] = [];
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          return runChars(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(request: RasterGlyphRequest): Promise<GlyphRaster> {
          rasterTexts.push(request.glyphText);
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
      instanceOptions: { initialCapacity: 8 },
      transformOptions: { initialCapacity: 4, textureWidth: 4 },
    });

    const spaced = await coordinator.commit(1, [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0, "A B") },
    ]);
    expect(rasterTexts).toEqual(["A", "B"]);
    expect(spaced).toMatchObject({ stale: false, appliedLabels: 1, glyphs: 2 });
    expect(coordinator.instances.getRange(0)).toEqual({ offset: 0, count: 2, capacity: 2 });
    expect(coordinator.instances.stats.highWater).toBe(2);

    rasterTexts.length = 0;
    await coordinator.commit(2, [
      { slot: 1, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 8, 0, "C\u3000D\u200b") },
    ]);
    expect(rasterTexts).toEqual(["C", "D"]);

    rasterTexts.length = 0;
    await coordinator.commit(3, [
      { slot: 2, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 16, 0, "E · F") },
    ]);
    expect(rasterTexts).toEqual(["E", "·", "F"]);

    rasterTexts.length = 0;
    await coordinator.commit(4, [
      { slot: 3, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 24, 0, "G\u1680H") },
    ]);
    expect(rasterTexts).toEqual(["G", "\u1680", "H"]);

    rasterTexts.length = 0;
    await coordinator.commit(5, [
      { slot: 4, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 32, 0, "   ") },
    ]);
    expect(rasterTexts).toEqual([]);
    expect(coordinator.instances.getRange(4)).toBeUndefined();

    coordinator.destroy();
    registry.destroy();
  });

  test("skips a HarfBuzz space in RTL cluster order without resolving every suffix", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const rasterTexts: string[] = [];
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout() {
          return runRtlClusters("A B");
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(request: RasterGlyphRequest): Promise<GlyphRaster> {
          rasterTexts.push(request.glyphText);
          return {
            mode: "msdf",
            width: 4,
            height: 6,
            pixels: new Uint8Array(96).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4, fieldRange: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
      instanceOptions: { initialCapacity: 8 },
      transformOptions: { initialCapacity: 4, textureWidth: 4 },
    });

    await coordinator.commit(1, [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0, "A B") },
    ]);
    expect(rasterTexts).toEqual(["B", "A"]);
    expect(coordinator.instances.getRange(0)?.count).toBe(2);

    coordinator.destroy();
    registry.destroy();
  });

  test("still rasters trusted empty-ink glyphs, ligatures, and shared-cluster marks", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const rasterTexts: string[] = [];
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          if (input.text === "A B") {
            return Object.freeze({ ...runChars("A B"), source: "trusted" as const });
          }
          if (input.text === "fi") return runLigature("fi");
          return runSharedCluster(" \u0301");
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(request: RasterGlyphRequest): Promise<GlyphRaster> {
          rasterTexts.push(request.glyphText);
          return {
            mode: "alpha",
            width: 4,
            height: 6,
            pixels: new Uint8Array(24).fill(255),
            metrics: { bearingX: 0, bearingY: 5, advance: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
      instanceOptions: { initialCapacity: 8 },
      transformOptions: { initialCapacity: 4, textureWidth: 4 },
    });

    await coordinator.commit(1, [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0, "A B") },
    ]);
    expect(rasterTexts).toEqual(["A", " ", "B"]);
    expect(coordinator.instances.getRange(0)?.count).toBe(3);

    rasterTexts.length = 0;
    await coordinator.commit(2, [
      { slot: 1, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 8, 0, "fi") },
    ]);
    expect(rasterTexts).toEqual(["fi"]);

    rasterTexts.length = 0;
    await coordinator.commit(3, [
      { slot: 2, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 16, 0, " \u0301") },
    ]);
    expect(rasterTexts).toHaveLength(2);
    expect(coordinator.instances.getRange(2)?.count).toBe(2);

    coordinator.destroy();
    registry.destroy();
  });
});

function label(
  sourceRevision: number,
  x: number,
  y: number,
  text = "AB",
): NonNullable<RenderChange["snapshot"]> {
  return {
    sourceRevision,
    text,
    x,
    y,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    zIndex: 0,
    order: 1,
    blendMode: "normal",
    alpha: 1,
    visible: true,
    anchorX: 0,
    anchorY: 0,
    style: { fontFamily: "Fixture", fontSize: 16, fill: 0xffffff },
  };
}

function run(text: string): Readonly<PositionedRun> {
  return Object.freeze({
    source: "bitmap",
    text,
    fontFamily: "Fixture",
    fontFamilies: Object.freeze(["Fixture", "sans-serif"]),
    fontRevision: 1,
    glyphCount: 2,
    direction: "ltr",
    glyphIds: new Uint32Array([65, 66]),
    clusters: new Uint32Array([0, 1]),
    x: new Float32Array([0, 5]),
    y: new Float32Array([0, 0]),
    xAdvance: new Float32Array([5, 5]),
    yAdvance: new Float32Array([0, 0]),
    lineIndices: new Uint32Array([0, 0]),
    glyphKeys: Object.freeze(["A", "B"]),
    bounds: Object.freeze({ x: 0, y: -5, width: 10, height: 6 }),
  });
}

function runChars(
  text: string,
  source: PositionedRun["source"] = "bitmap",
): Readonly<PositionedRun> {
  const chars = [...text];
  const glyphCount = chars.length;
  const glyphIds = new Uint32Array(glyphCount);
  const clusters = new Uint32Array(glyphCount);
  const x = new Float32Array(glyphCount);
  const xAdvance = new Float32Array(glyphCount);
  const glyphKeys: string[] = [];
  let cursor = 0;
  let pen = 0;
  for (let index = 0; index < glyphCount; index += 1) {
    const glyph = chars[index] ?? "";
    glyphIds[index] = glyph.codePointAt(0) ?? 0;
    clusters[index] = cursor;
    x[index] = pen;
    xAdvance[index] = 5;
    glyphKeys.push(glyph);
    cursor += glyph.length;
    pen += 5;
  }
  return Object.freeze({
    source,
    text,
    fontFamily: "Fixture",
    fontFamilies: Object.freeze(["Fixture", "sans-serif"]),
    fontRevision: 1,
    glyphCount,
    direction: "ltr",
    glyphIds,
    clusters,
    x,
    y: new Float32Array(glyphCount),
    xAdvance,
    yAdvance: new Float32Array(glyphCount),
    lineIndices: new Uint32Array(glyphCount),
    glyphKeys: Object.freeze(glyphKeys),
    bounds: Object.freeze({ x: 0, y: -5, width: pen, height: 6 }),
  });
}

/** Visual RTL order: last char, space, first char. No glyphKeys, like HarfBuzz. */
function runRtlClusters(text: string): Readonly<PositionedRun> {
  const chars = [...text];
  if (chars.length !== 3 || chars[1] !== " ") {
    throw new Error("runRtlClusters expects a single space between two scalars");
  }
  const first = chars[0] ?? "";
  const last = chars[2] ?? "";
  return Object.freeze({
    source: "harfbuzz" as const,
    text,
    fontFamily: "Fixture",
    fontRevision: 1,
    glyphCount: 3,
    direction: "rtl" as const,
    glyphIds: new Uint32Array([last.codePointAt(0) ?? 0, 32, first.codePointAt(0) ?? 0]),
    clusters: new Uint32Array([first.length + 1, first.length, 0]),
    x: new Float32Array([0, 5, 10]),
    y: new Float32Array(3),
    xAdvance: new Float32Array([5, 5, 5]),
    yAdvance: new Float32Array(3),
    lineIndices: new Uint32Array(3),
    bounds: Object.freeze({ x: 0, y: -5, width: 15, height: 6 }),
  });
}

function runLigature(text: string): Readonly<PositionedRun> {
  return Object.freeze({
    source: "bitmap" as const,
    text,
    fontFamily: "Fixture",
    fontRevision: 1,
    glyphCount: 1,
    direction: "ltr" as const,
    glyphIds: new Uint32Array([1]),
    clusters: new Uint32Array([0]),
    x: new Float32Array([0]),
    y: new Float32Array([0]),
    xAdvance: new Float32Array([8]),
    yAdvance: new Float32Array([0]),
    lineIndices: new Uint32Array([0]),
    glyphKeys: Object.freeze([text]),
    bounds: Object.freeze({ x: 0, y: -5, width: 8, height: 6 }),
  });
}

function runSharedCluster(text: string): Readonly<PositionedRun> {
  return Object.freeze({
    source: "harfbuzz" as const,
    text,
    fontFamily: "Fixture",
    fontRevision: 1,
    glyphCount: 2,
    direction: "ltr" as const,
    glyphIds: new Uint32Array([32, 1]),
    clusters: new Uint32Array([0, 0]),
    x: new Float32Array([0, 0]),
    y: new Float32Array(2),
    xAdvance: new Float32Array([5, 0]),
    yAdvance: new Float32Array(2),
    lineIndices: new Uint32Array(2),
    bounds: Object.freeze({ x: 0, y: -5, width: 5, height: 6 }),
  });
}

async function waitForGate(gates: Map<string, () => void>, key: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (gates.has(key)) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for layout gate: ${key}`);
}
