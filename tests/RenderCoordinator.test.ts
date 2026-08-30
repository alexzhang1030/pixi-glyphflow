import { describe, expect, test } from "bun:test";

import type { TextStyleOptions } from "pixi.js";

import { FontRegistry, type PositionedRun } from "../src";
import {
  GlyphAtlas,
  GLYPH_INSTANCE_STRIDE,
  GlyphInstanceStore,
  LayoutEngine,
  RasterGlyphProvider,
  RenderCoordinator,
  TransformPalette,
  type AdmitLaneGroup,
  type ContentLaneInput,
  type ExternalColorGlyphRaster,
  type GlyphRaster,
  type RasterGlyphRequest,
  type RenderChange,
  type RenderCommitResult,
  type TextLayoutInput,
} from "../src/advanced";
import { leasePositionedRun } from "../src/layout/PositionedRunLease";
import { GpuSceneCompiler } from "../src/render/GpuSceneCompiler";
import { unpackF16 } from "../src/render/pack";
import { residentAdmitLaneEligible } from "../src/render/RenderCoordinator";

const CONTENT = 1;
const TRANSFORM = 2;
const STYLE = 4;
const FIXTURE_STYLE = Object.freeze({
  fontFamily: "Fixture",
  fontSize: 16,
  fill: 0xffffff,
}) satisfies Readonly<TextStyleOptions>;

describe("RenderCoordinator", () => {
  test("isolates interned runs across embedded tuple separators", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const layoutTexts: string[] = [];
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          layoutTexts.push(input.text);
          return runChars(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return alphaRaster();
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 1_024 },
    });
    const first = label(1, 0, 0, "x\u0000y");
    const second = label(1, 10, 0, "x");

    await coordinator.commit(1, [
      {
        slot: 0,
        mask: CONTENT | STYLE,
        snapshot: {
          ...first,
          style: { ...first.style, fontFamily: "z" },
          shaping: { direction: "ltr" },
        },
      },
      {
        slot: 1,
        mask: CONTENT | STYLE,
        snapshot: {
          ...second,
          style: { ...second.style, fontFamily: "y\u0000z" },
          shaping: { direction: "ltr" },
        },
      },
    ]);

    expect(layoutTexts).toEqual(["x\u0000y", "x"]);
    expect(coordinator.getRun(0)?.text).toBe("x\u0000y");
    expect(coordinator.getRun(1)?.text).toBe("x");

    await destroyCoordinatorFixture(coordinator, registry);
  });

  test("isolates shared prototypes across glyph-text and variation-key boundaries", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const requests: Array<readonly [string, string]> = [];
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          const variationKey = input.text === "x\u0000y" ? "z" : "y\u0000z";
          return exactHarfBuzzRun(input.text, [500], [0], [input.text.length], variationKey);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(request): Promise<GlyphRaster> {
          requests.push([request.glyphText, request.variationKey ?? ""]);
          return {
            mode: "msdf",
            width: 2,
            height: 2,
            pixels: new Uint8Array(16).fill(255),
            metrics: { bearingX: 0, bearingY: 2, advance: 2, fieldRange: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
    });
    const style = { fontFamily: "Fixture", fontSize: 16, fill: 0xffffff } as const;

    await coordinator.applyContentLane(contentLane(0, 0, 0, "x\u0000y", style));
    await coordinator.applyContentLane(contentLane(1, 10, 0, "x", style));

    expect(requests).toEqual([
      ["x\u0000y", "z"],
      ["x", "y\u0000z"],
    ]);
    expect(coordinator.instances.getRange(0)?.offset).not.toBe(
      coordinator.instances.getRange(1)?.offset,
    );

    await destroyCoordinatorFixture(coordinator, registry);
  });

  test("keeps distinct run geometry isolated across ordinary, content, and resident lanes", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          const shifted =
            input.text === "O"
              ? input.direction === "rtl"
                ? 10
                : 0
              : input.text === "C"
                ? input.style.fontStyle === "oblique"
                  ? 30
                  : 20
                : input.style.fontStyle === "oblique"
                  ? 50
                  : 40;
          return shiftedRun(input.text, shifted, input.direction === "rtl" ? "rtl" : "ltr");
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return alphaRaster();
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
      instanceOptions: { initialCapacity: 8 },
    });
    const ordinary = label(1, 0, 0, "O");
    await coordinator.commit(1, [
      {
        slot: 0,
        mask: CONTENT | TRANSFORM | STYLE,
        snapshot: { ...ordinary, shaping: { direction: "ltr" } },
      },
      {
        slot: 1,
        mask: CONTENT | TRANSFORM | STYLE,
        snapshot: { ...ordinary, order: 2, shaping: { direction: "rtl" } },
      },
    ]);

    const italic = {
      fontFamily: "Fixture",
      fontSize: 16,
      fontWeight: "400",
      fontStyle: "italic",
      fill: 0xffffff,
    } satisfies Readonly<TextStyleOptions>;
    const oblique = { ...italic, fontStyle: "oblique" } satisfies Readonly<TextStyleOptions>;
    await coordinator.applyContentLane(contentLane(2, 0, 0, "C", italic));
    await coordinator.applyContentLane(contentLane(3, 0, 0, "C", oblique));
    const resident = await coordinator.applyResidentAdmitLane([
      { ...singleAdmitGroup(4, 0, 0, "R", italic), zIndex: 0, blendMode: "normal" },
      { ...singleAdmitGroup(5, 0, 0, "R", oblique), zIndex: 0, blendMode: "normal" },
    ]);

    expect([instanceX(coordinator, 0), instanceX(coordinator, 1)]).toEqual([0, 10]);
    expect([instanceX(coordinator, 2), instanceX(coordinator, 3)]).toEqual([20, 30]);
    expect(resident?.residentColumns.map((column) => column.instanceOffset)).toEqual([4, 5]);
    expect([instanceX(coordinator, 4), instanceX(coordinator, 5)]).toEqual([40, 50]);

    await destroyCoordinatorFixture(coordinator, registry);
  });

  test("isolates fractional sizes and string weights by style identity", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const layoutFaces: Array<readonly [number | string | undefined, unknown]> = [];
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          layoutFaces.push([input.style.fontSize, input.style.fontWeight]);
          return shiftedRun(input.text, layoutFaces.length * 4);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return alphaRaster();
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
      instanceOptions: { initialCapacity: 8 },
    });
    const face = (
      text: string,
      fontSize: number,
      fontWeight: NonNullable<TextStyleOptions["fontWeight"]>,
      order: number,
    ): NonNullable<RenderChange["snapshot"]> => ({
      ...label(1, 0, 0, text),
      order,
      style: { fontFamily: "Fixture", fontSize, fontWeight, fill: 0xffffff },
    });

    await coordinator.commit(1, [
      {
        slot: 0,
        mask: CONTENT | TRANSFORM | STYLE,
        snapshot: face("F", 16, 400 as unknown as NonNullable<TextStyleOptions["fontWeight"]>, 0),
      },
      {
        slot: 1,
        mask: CONTENT | TRANSFORM | STYLE,
        snapshot: face(
          "F",
          15.90234375,
          500 as unknown as NonNullable<TextStyleOptions["fontWeight"]>,
          1,
        ),
      },
      { slot: 2, mask: CONTENT | TRANSFORM | STYLE, snapshot: face("S", 16, "normal", 2) },
      { slot: 3, mask: CONTENT | TRANSFORM | STYLE, snapshot: face("S", 16, "500", 3) },
    ]);

    expect(layoutFaces).toEqual([
      [16, 400],
      [15.90234375, 500],
      [16, "normal"],
      [16, "500"],
    ]);
    expect(coordinator.getRun(0)).not.toBe(coordinator.getRun(1));
    expect(coordinator.getRun(2)).not.toBe(coordinator.getRun(3));
    expect([0, 1, 2, 3].map((slot) => instanceX(coordinator, slot))).toEqual([4, 8, 12, 16]);

    await destroyCoordinatorFixture(coordinator, registry);
  });

  test("isolates horizontal letter spacing in ordinary layout interns", async () => {
    const fixture = await createStyleSensitiveCoordinator();
    const first = label(1, 0, 0, "A");
    const second = { ...first, order: 2 };

    await fixture.coordinator.commit(1, [
      {
        slot: 0,
        mask: CONTENT | TRANSFORM | STYLE,
        snapshot: { ...first, style: { ...first.style, letterSpacing: 1 } },
      },
      {
        slot: 1,
        mask: CONTENT | TRANSFORM | STYLE,
        snapshot: { ...second, style: { ...second.style, letterSpacing: 7 } },
      },
    ]);

    expect(fixture.layoutCalls()).toBe(2);
    expect([instanceX(fixture.coordinator, 0), instanceX(fixture.coordinator, 1)]).toEqual([1, 7]);
    await destroyCoordinatorFixture(fixture.coordinator, fixture.registry);
  });

  test("isolates horizontal word-wrap width in content layout interns", async () => {
    const fixture = await createStyleSensitiveCoordinator();
    const base = {
      fontFamily: "Fixture",
      fontSize: 16,
      fill: 0xffffff,
      wordWrap: true,
    } satisfies Readonly<TextStyleOptions>;

    await fixture.coordinator.applyContentLane(
      contentLane(0, 0, 0, "A", { ...base, wordWrapWidth: 20 }),
    );
    await fixture.coordinator.applyContentLane(
      contentLane(1, 0, 0, "A", { ...base, wordWrapWidth: 40 }),
    );

    expect(fixture.layoutCalls()).toBe(2);
    expect([instanceX(fixture.coordinator, 0), instanceX(fixture.coordinator, 1)]).toEqual([
      20, 40,
    ]);
    await destroyCoordinatorFixture(fixture.coordinator, fixture.registry);
  });

  test("isolates horizontal line metrics in resident layout interns", async () => {
    const fixture = await createStyleSensitiveCoordinator();
    const base = {
      fontFamily: "Fixture",
      fontSize: 16,
      fill: 0xffffff,
    } satisfies Readonly<TextStyleOptions>;

    const result = await fixture.coordinator.applyResidentAdmitLane([
      {
        ...singleAdmitGroup(0, 0, 0, "A", { ...base, lineHeight: 12 }),
        zIndex: 0,
        blendMode: "normal",
      },
      {
        ...singleAdmitGroup(1, 0, 0, "A", { ...base, lineHeight: 24 }),
        zIndex: 0,
        blendMode: "normal",
      },
    ]);

    expect(result).toBeDefined();
    expect(fixture.layoutCalls()).toBe(2);
    expect([instanceX(fixture.coordinator, 0), instanceX(fixture.coordinator, 1)]).toEqual([
      12, 24,
    ]);
    await destroyCoordinatorFixture(fixture.coordinator, fixture.registry);
  });

  test("isolates vertical line height in layout interns", async () => {
    const fixture = await createStyleSensitiveCoordinator();
    const first = label(1, 0, 0, "A");

    await fixture.coordinator.commit(1, [
      {
        slot: 0,
        mask: CONTENT | TRANSFORM | STYLE,
        snapshot: {
          ...first,
          style: { ...first.style, lineHeight: 18 },
          layout: { writingMode: "vertical-rl" },
        },
      },
      {
        slot: 1,
        mask: CONTENT | TRANSFORM | STYLE,
        snapshot: {
          ...first,
          order: 2,
          style: { ...first.style, lineHeight: 36 },
          layout: { writingMode: "vertical-rl" },
        },
      },
    ]);

    expect(fixture.layoutCalls()).toBe(2);
    expect([instanceX(fixture.coordinator, 0), instanceX(fixture.coordinator, 1)]).toEqual([
      18, 36,
    ]);
    await destroyCoordinatorFixture(fixture.coordinator, fixture.registry);
  });

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
          return layoutRaster();
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

    await destroyCoordinatorFixture(coordinator, registry);
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

    await destroyCoordinatorFixture(coordinator, registry);
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

    await destroyCoordinatorFixture(coordinator, registry);
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

    await destroyCoordinatorFixture(coordinator, registry);
  });

  test("publishes the newer raster across an out-of-order commit pair", async () => {
    const { coordinator, gates, registry } = await createGatedCoordinator();

    const older = coordinator.commit(1, [
      { slot: 0, mask: CONTENT | STYLE, snapshot: label(1, 0, 0, "O") },
    ]);
    await waitForGate(gates, "O");
    const newer = coordinator.commit(2, [
      { slot: 0, mask: CONTENT | STYLE, snapshot: label(2, 0, 0, "N") },
    ]);
    await waitForGate(gates, "N");
    gates.get("N")?.();
    expect(await newer).toMatchObject({ stale: false, atlasUploads: 1 });

    gates.get("O")?.();
    expect(await older).toMatchObject({ stale: true, appliedLabels: 0 });

    const nextFrame = await coordinator.commit(3, [
      { slot: 0, mask: TRANSFORM, snapshot: label(2, 4, 8, "N") },
    ]);
    expect(nextFrame).toMatchObject({ stale: false, atlasUploads: 0 });

    await destroyCoordinatorFixture(coordinator, registry);
  });

  test("keeps a newer source revision when the glyph identity stays the same", async () => {
    const { coordinator, gates, registry } = await createGatedCoordinator();

    const older = coordinator.commit(1, [
      { slot: 0, mask: CONTENT | STYLE, snapshot: label(1, 0, 0, "S") },
    ]);
    await waitForGate(gates, "S");
    const newer = coordinator.commit(2, [
      { slot: 0, mask: CONTENT | STYLE, snapshot: label(2, 0, 0, "S") },
    ]);
    await waitForGate(gates, "S#2");

    gates.get("S#2")?.();
    expect(await newer).toMatchObject({ stale: false, atlasUploads: 1 });
    gates.get("S")?.();
    expect(await older).toMatchObject({ stale: true, appliedLabels: 0 });
    expect(
      await coordinator.commit(3, [{ slot: 0, mask: TRANSFORM, snapshot: label(2, 4, 8, "S") }]),
    ).toMatchObject({ stale: false, atlasUploads: 0 });

    await destroyCoordinatorFixture(coordinator, registry);
  });

  test("rejects a raster whose font revision changed while it was pending", async () => {
    const { coordinator, gates, registry } = await createGatedCoordinator();

    const pending = coordinator.commit(1, [
      { slot: 0, mask: CONTENT | STYLE, snapshot: label(1, 0, 0, "F") },
    ]);
    await waitForGate(gates, "F");
    gates.get("F")?.();
    await Promise.resolve();
    expect(coordinator.atlas.stats.stagedResults).toBe(1);
    expect(registry.unregister("Fixture")).toBe(true);

    expect(await pending).toMatchObject({ stale: true, appliedLabels: 0, atlasUploads: 0 });
    expect(coordinator.stats).toMatchObject({ staleGlyphResults: 1, pendingGlyphs: 0 });
    expect(coordinator.atlas.stats.pendingEntries).toBe(0);

    await destroyCoordinatorFixture(coordinator, registry);
  });

  test("keeps public atlas frames isolated from an injected coordinator lifetime", async () => {
    const atlas = new GlyphAtlas({ pageWidth: 16, pageHeight: 16, maxBytes: 1_024 });
    const { coordinator, gates, registry } = await createGatedCoordinator(atlas);
    const pending = coordinator.commit(1, [
      { slot: 0, mask: CONTENT | STYLE, snapshot: label(1, 0, 0, "A") },
    ]);
    await waitForGate(gates, "A");
    gates.get("A")?.();
    await Promise.resolve();
    expect(atlas.stats.pendingEntries).toBe(1);

    const manual = atlas.request("manual");
    expect(atlas.stage(manual, alphaRaster())).toBe(true);
    expect(atlas.commitFrame().uploads.map((upload) => upload.entry.key)).toEqual(["manual"]);
    expect(atlas.stats.pendingEntries).toBe(1);
    expect(await pending).toMatchObject({ stale: false, atlasUploads: 1 });

    coordinator.destroy();
    const afterDestroy = atlas.request("after-destroy");
    expect(atlas.stage(afterDestroy, alphaRaster())).toBe(true);
    expect(atlas.commitFrame().uploads).toHaveLength(1);

    atlas.destroy();
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
          return layoutRaster();
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

    await destroyCoordinatorFixture(coordinator, registry);
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
          return layoutRaster();
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

    await destroyCoordinatorFixture(coordinator, registry);
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
          return layoutRaster();
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

    await destroyCoordinatorFixture(coordinator, registry);
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
          return layoutRaster();
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

    await destroyCoordinatorFixture(coordinator, registry);
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
          return layoutRaster();
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

    await destroyCoordinatorFixture(coordinator, registry);
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
          return layoutRaster();
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
    const style = Object.freeze({ fontFamily: "Fixture", fontSize: 16, fill: 0x336699 });

    const first = await coordinator.applyAdmitLane([
      {
        slots,
        count: 8,
        xy,
        orders,
        text: "AB",
        style,
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
        style,
      }),
    ).toBe(true);
    expect(
      coordinator.hasInternedLayout({
        text: "ZZ",
        style,
      }),
    ).toBe(false);

    await destroyCoordinatorFixture(coordinator, registry);
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
          return layoutRaster();
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 64, pageHeight: 64, maxBytes: 4_096 },
      instanceOptions: { initialCapacity: 16 },
      transformOptions: { initialCapacity: 8, textureWidth: 8 },
    });
    const style = { fontFamily: "Fixture", fontSize: 16, fill: 0xffffff };
    const first = coordinator.applyAdmitLane([
      singleAdmitGroup(0, 0, 0, "AB", style),
      singleAdmitGroup(1, 12, 0, "CD", style),
    ]);
    await waitForGate(gates, "AB");
    await waitForGate(gates, "CD");
    expect(layoutCalls).toBe(2);
    gates.get("AB")?.();
    gates.get("CD")?.();
    expect(await first).toMatchObject({ stale: false, appliedLabels: 2, glyphs: 4 });
    expect(coordinator.getRun(0)?.text).toBe("AB");
    expect(coordinator.getRun(1)?.text).toBe("CD");

    await destroyCoordinatorFixture(coordinator, registry);
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
          return layoutRaster();
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
        singleAdmitGroup(0, 0, 0, "AB", { ...FIXTURE_STYLE }),
        singleAdmitGroup(1, 12, 4, "CD", { ...FIXTURE_STYLE }),
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
        singleAdmitGroup(2, 24, 0, "EF", { ...FIXTURE_STYLE, fill: 0xff0000 }),
        singleAdmitGroup(3, 36, 0, "GH", { ...FIXTURE_STYLE, fill: 0x00ff00 }),
      ]),
    ).toMatchObject({ stale: false, appliedLabels: 2 });
    expect(fillWrites).toBe(2);
    expect(coordinator.transforms.data[22]).toBe(0xff0000);
    expect(coordinator.transforms.data[30]).toBe(0x00ff00);

    await destroyCoordinatorFixture(coordinator, registry);
  });

  test("admits a resident shared column with one run, instance range, and draw state", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    let layoutCalls = 0;
    let rasterCalls = 0;
    const count = 100_000;
    const slots = new Uint32Array(count);
    const orders = new Uint32Array(count);
    const xy = new Float32Array(count * 2);
    for (let slot = 0; slot < count; slot += 1) {
      slots[slot] = slot;
      orders[slot] = slot + 1;
      xy[slot * 2] = slot % 1_000;
      xy[slot * 2 + 1] = Math.floor(slot / 1_000);
    }
    const style = Object.freeze({ fontFamily: "Fixture", fontSize: 16, fill: 0xffffff });
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
          rasterCalls += 1;
          return layoutRaster();
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 256 },
      instanceOptions: { initialCapacity: 4 },
      transformOptions: { initialCapacity: count, textureWidth: 1_024 },
    });

    const first = await coordinator.applyResidentAdmitLane([
      {
        slots,
        count,
        xy,
        orders,
        text: "AB",
        style,
        zIndex: 0,
        blendMode: "normal",
      },
    ]);
    expect(first).toMatchObject({ stale: false, appliedLabels: count });
    if (first === undefined) throw new Error("Resident admit lane unexpectedly declined");
    expect(first.residentColumns).toHaveLength(1);
    expect(first.residentColumns[0]).toMatchObject({
      count,
      prototypeId: 0,
      instanceOffset: 0,
      instanceCount: 2,
    });
    expect(Array.from(first.residentColumns[0]?.localBounds ?? [])).toEqual([0, -5, 10, 6]);
    expect(first.atlasUploads).toBe(2);
    expect(first.atlasCommit.entries).toHaveLength(2);
    expect(first.atlasCommit.uploads).toHaveLength(2);
    expect(coordinator.atlas.stats.pinnedEntries).toBe(2);
    expect({ layoutCalls, rasterCalls }).toEqual({ layoutCalls: 1, rasterCalls: 2 });
    expect(coordinator.instances.stats).toMatchObject({ labels: 1, activeInstances: 2 });
    const prototypeWords = new Uint32Array(coordinator.instances.buffer, 0, 12);
    expect([prototypeWords[4], prototypeWords[10]]).toEqual([0, 0]);
    expect([
      ((prototypeWords[5] ?? 0) & 0x8000_0000) >>> 0,
      ((prototypeWords[11] ?? 0) & 0x8000_0000) >>> 0,
    ]).toEqual([0x8000_0000, 0x8000_0000]);
    expect(coordinator.transforms.stats.activeLabels).toBe(count);
    const palette = coordinator.transforms.data;
    const paletteBits = new Uint32Array(palette.buffer, palette.byteOffset, palette.length);
    const farOffset = (count - 1) * 8;
    expect(Array.from(palette.subarray(0, 4))).toEqual([0, 0, 1, 1]);
    expect([paletteBits[4], paletteBits[5], palette[6], palette[7]]).toEqual([
      0x3c00_0000, 0, 0xffffff, 0xffff,
    ]);
    expect(Array.from(palette.subarray(farOffset, farOffset + 4))).toEqual([999, 99, 1, 1]);
    expect([
      paletteBits[farOffset + 4],
      paletteBits[farOffset + 5],
      palette[farOffset + 6],
      palette[farOffset + 7],
    ]).toEqual([0x3c00_0000, 0, 0xffffff, 0xffff]);
    expect(coordinator.getDrawStates()).toEqual([
      { slot: 0, zIndex: 0, order: 1, blendMode: "normal" },
    ]);
    expect(coordinator.getRun(0)).toBeDefined();
    expect(coordinator.getRun(1)).toBeUndefined();
    expect(coordinator.stats).toMatchObject({
      residentLabels: count,
      residentPrototypeCount: 1,
      residentPerLabelObjectCount: 0,
    });

    const appended = await coordinator.applyResidentAdmitLane([
      {
        slots: new Uint32Array([count, count + 1]),
        count: 2,
        xy: new Float32Array([0, 100, 10, 100]),
        orders: new Uint32Array([count + 1, count + 2]),
        text: "AB",
        style,
        zIndex: 0,
        blendMode: "normal",
      },
    ]);
    expect(appended?.residentColumns[0]?.prototypeId).toBe(0);
    expect({ layoutCalls, rasterCalls }).toEqual({ layoutCalls: 1, rasterCalls: 2 });
    expect(coordinator.instances.stats).toMatchObject({ labels: 1, activeInstances: 2 });
    expect(coordinator.getDrawStates()).toHaveLength(1);
    expect(coordinator.atlas.stats.pinnedEntries).toBe(2);
    expect(coordinator.stats).toMatchObject({
      residentLabels: count + 2,
      residentPrototypeCount: 1,
      residentPerLabelObjectCount: 0,
    });

    await destroyCoordinatorFixture(coordinator, registry);
  });

  test("compiles interleaved prototype and canonical paint groups into one resident revision", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    let layoutCalls = 0;
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          layoutCalls += 1;
          return shiftedRun(input.text, input.text === "B" ? 4 : 0);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return alphaRaster();
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
      instanceOptions: { initialCapacity: 8 },
      transformOptions: { initialCapacity: 8 },
    });
    const compiler = new GpuSceneCompiler();
    const red = Object.freeze({ fontFamily: "Fixture", fontSize: 16, fill: 0xff0000 });
    const green = Object.freeze({ fontFamily: "Fixture", fontSize: 16, fill: "#00ff00" });
    const group = (
      slots: readonly number[],
      text: string,
      style: Readonly<TextStyleOptions>,
      prototypeCandidateIndex: number,
    ) => ({
      slots: Uint32Array.from(slots),
      count: slots.length,
      xy: Float32Array.from(slots.flatMap((slot) => [slot * 10, slot * 20])),
      orders: Uint32Array.from(slots, (slot) => slot + 1),
      text,
      style,
      zIndex: 0,
      blendMode: "normal" as const,
      prototypeCandidateIndex,
    });

    const result = await coordinator.applyResidentAdmitLane(
      [
        group([0, 4], "A", red, 0),
        group([1, 5], "A", green, 0),
        group([2, 6], "B", red, 1),
        group([3, 7], "B", green, 1),
      ],
      compiler,
    );

    expect(result?.residentColumns.map((column) => Array.from(column.slots))).toEqual([
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ]);
    expect(coordinator.instances.stats).toMatchObject({ labels: 2, activeInstances: 2 });
    expect(coordinator.getDrawStates()).toHaveLength(2);
    expect(compiler.prototypeCount).toBe(2);
    expect(compiler.paintCount).toBe(2);
    expect(layoutCalls).toBe(2);
    const palette = coordinator.transforms.data;
    expect([palette[6], palette[14], palette[22], palette[30]]).toEqual([
      0xff0000, 0x00ff00, 0xff0000, 0x00ff00,
    ]);

    const appended = await coordinator.applyResidentAdmitLane(
      [group([8], "A", { ...red, fill: "#ff0000" }, 0)],
      compiler,
    );
    expect(appended?.residentColumns).toHaveLength(1);
    expect(appended?.residentColumns[0]?.prototypeId).toBe(result?.residentColumns[0]?.prototypeId);
    expect(coordinator.instances.stats).toMatchObject({ labels: 2, activeInstances: 2 });
    expect(compiler.prototypeCount).toBe(2);
    expect(compiler.paintCount).toBe(2);

    await destroyCoordinatorFixture(coordinator, registry);
  });

  test("checks resident blend, z, and slot-order eligibility before layout", () => {
    const base = {
      slots: new Uint32Array([0, 1]),
      count: 2,
      xy: new Float32Array([0, 0, 10, 0]),
      orders: new Uint32Array([1, 2]),
      text: "AB",
      style: Object.freeze({ fontFamily: "Fixture", fontSize: 16, fill: 0xffffff }),
      zIndex: 0,
      blendMode: "normal" as const,
    };
    expect(residentAdmitLaneEligible([base])).toBe(true);
    expect(
      residentAdmitLaneEligible([
        { ...base, slots: new Uint32Array([0, 2]), orders: new Uint32Array([1, 3]) },
        { ...base, slots: new Uint32Array([1, 3]), orders: new Uint32Array([2, 4]) },
      ]),
    ).toBe(true);
    expect(residentAdmitLaneEligible([{ ...base, zIndex: 1 }])).toBe(false);
    expect(residentAdmitLaneEligible([{ ...base, blendMode: "add" }])).toBe(false);
    expect(
      residentAdmitLaneEligible([
        { ...base, slots: new Uint32Array([1, 0]), orders: new Uint32Array([1, 2]) },
      ]),
    ).toBe(false);
  });

  test("declines more than 512 resident groups before layout", async () => {
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
          return alphaRaster();
        },
        destroy() {},
      },
    });
    const group = {
      ...singleAdmitGroup(0, 0, 0, "A", FIXTURE_STYLE, 1),
      zIndex: 0,
      blendMode: "normal" as const,
    };

    expect(await coordinator.applyResidentAdmitLane(Array(513).fill(group))).toBeUndefined();
    expect(layoutCalls).toBe(0);

    await destroyCoordinatorFixture(coordinator, registry);
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
          return layoutRaster();
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

    await destroyCoordinatorFixture(coordinator, registry);
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

    await destroyCoordinatorFixture(coordinator, registry);
  });

  test("preserves exact HarfBuzz spans and variation identity through raster requests", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const requests: RasterGlyphRequest[] = [];
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          const variationKey = Object.entries(input.variations ?? {})
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([axis, value]) => `${axis}=${String(value)}`)
            .join(",");
          if (input.text === "fi") {
            return exactHarfBuzzRun(input.text, [500], [0], [2], variationKey);
          }
          return exactHarfBuzzRun(input.text, [65, 701], [0, 0], [2, 2], variationKey);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(request: RasterGlyphRequest): Promise<GlyphRaster> {
          requests.push(request);
          return {
            mode: "msdf",
            width: 2,
            height: 2,
            pixels: new Uint8Array(16).fill(255),
            metrics: { bearingX: 0, bearingY: 2, advance: 2, fieldRange: 4 },
          };
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 2_048 },
    });

    await coordinator.commit(1, [
      {
        slot: 0,
        mask: CONTENT | STYLE,
        snapshot: {
          ...label(1, 0, 0, "fi"),
          shaping: { variations: { wght: 400 } },
        },
      },
    ]);
    await coordinator.commit(2, [
      {
        slot: 1,
        mask: CONTENT | STYLE,
        snapshot: {
          ...label(1, 10, 0, "fi"),
          shaping: { variations: { wght: 700 } },
        },
      },
    ]);
    await coordinator.commit(3, [
      { slot: 2, mask: CONTENT | STYLE, snapshot: label(1, 20, 0, "a\u0301") },
    ]);

    expect(requests.map(({ glyphText, variationKey }) => [glyphText, variationKey])).toEqual([
      ["fi", "wght=400"],
      ["fi", "wght=700"],
      ["a\u0301", ""],
      ["a\u0301", ""],
    ]);

    await destroyCoordinatorFixture(coordinator, registry);
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
          return layoutRaster();
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
    expect(coordinator.atlas.stats.pinnedEntries).toBe(2);

    await coordinator.commit(2, [{ slot: 0, mask: CONTENT, snapshot: undefined }]);
    expect(coordinator.atlas.stats.pinnedEntries).toBe(2);

    await coordinator.commit(3, [{ slot: 1, mask: CONTENT, snapshot: undefined }]);
    expect(coordinator.atlas.stats.pinnedEntries).toBe(0);

    await destroyCoordinatorFixture(coordinator, registry);
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

    await destroyCoordinatorFixture(coordinator, registry);
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
          return layoutRaster();
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

    await destroyCoordinatorFixture(coordinator, registry);
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

    await destroyCoordinatorFixture(coordinator, registry);
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
          return layoutRaster();
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

    await destroyCoordinatorFixture(coordinator, registry);
  });

  for (const lane of ["commit", "content", "admit", "resident"] as const) {
    test(`replays the atlas publication after a ${lane} lane post-commit write fault`, async () => {
      const leaseFailure = new Error(`${lane} lane lease release failed`);
      const fixture = await createFaultingLaneCoordinator(leaseFailure);
      const failure = new Error(`${lane} lane write failed`);
      if (lane === "commit" || lane === "admit") fixture.instances.failNextSet = failure;
      else if (lane === "content") fixture.transforms.failNextPositions = failure;
      else fixture.transforms.failNextFills = failure;

      const invoke = async (): Promise<Readonly<RenderCommitResult>> => {
        const snapshot = label(1, 0, 0, "A");
        if (lane === "commit") {
          return fixture.coordinator.commit(1, [
            { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot },
          ]);
        }
        if (lane === "content") {
          return fixture.coordinator.applyContentLane(contentLane(0, 0, 0, "A", snapshot.style));
        }
        const group = singleAdmitGroup(0, 0, 0, "A", snapshot.style);
        if (lane === "admit") return fixture.coordinator.applyAdmitLane([group]);
        const result = await fixture.coordinator.applyResidentAdmitLane([
          { ...group, zIndex: 0, blendMode: "normal" },
        ]);
        if (result === undefined) throw new Error("resident lane unexpectedly declined");
        return result;
      };

      await expect(invoke()).rejects.toBe(failure);
      expect(fixture.releaseCalls()).toBe(1);
      expect(fixture.rasterCalls()).toBe(1);
      const retry = await invoke();
      expect(retry.atlasCommit.uploads).toHaveLength(1);
      expect(fixture.rasterCalls()).toBe(1);

      await fixture.coordinator.destroy();
      fixture.instances.destroy();
      fixture.transforms.destroy();
      fixture.registry.destroy();
    });
  }

  test("replays a late draw rebuild and publishes ordinary commit stats once", async () => {
    const fixture = await createFaultingLaneCoordinator();
    await fixture.coordinator.commit(1, [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0, "A") },
      { slot: 1, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 8, 0, "B") },
    ]);
    const baseline = fixture.coordinator.stats;
    const failure = new Error("late new-slot instance write failed");
    fixture.instances.failNextSet = failure;
    const changes = [
      { slot: 0, mask: CONTENT, snapshot: undefined },
      { slot: 1, mask: TRANSFORM, snapshot: label(1, 16, 0, "B") },
      { slot: 2, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 24, 0, "C") },
    ] satisfies readonly RenderChange[];

    await expect(fixture.coordinator.commit(2, changes)).rejects.toBe(failure);
    expect(fixture.coordinator.stats).toMatchObject({
      revisions: baseline.revisions,
      appliedLabels: baseline.appliedLabels,
      shapedLabels: baseline.shapedLabels,
      transformOnlyLabels: baseline.transformOnlyLabels,
      removedLabels: baseline.removedLabels,
    });

    const retry = await fixture.coordinator.commit(2, changes);
    expect(retry.drawOrderChanged).toBe(true);
    expect(fixture.coordinator.getDrawStates().map((state) => state.slot)).toEqual([1, 2]);
    expect(fixture.coordinator.stats).toMatchObject({
      revisions: baseline.revisions + 1,
      appliedLabels: baseline.appliedLabels + 3,
      shapedLabels: baseline.shapedLabels + 1,
      transformOnlyLabels: baseline.transformOnlyLabels + 1,
      removedLabels: baseline.removedLabels + 1,
    });

    await fixture.coordinator.destroy();
    fixture.instances.destroy();
    fixture.transforms.destroy();
    fixture.registry.destroy();
  });

  test("keeps the old atlas key pinned until a faulted instance replacement succeeds", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const instances = new FaultingGlyphInstanceStore({ initialCapacity: 4 });
    const coordinator = new RenderCoordinator({
      registry,
      instances,
      layoutEngine: {
        layout(_slot, _revision, input) {
          return runChars(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return alphaRaster();
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 2, pageHeight: 2, maxBytes: 8 },
    });
    const initial = await coordinator.commit(1, [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0, "A") },
    ]);
    const oldKey = initial.atlasCommit.entries[0]?.key;
    if (oldKey === undefined) throw new Error("Initial atlas key is missing");
    const failure = new Error("replacement instance write failed");
    instances.failNextSet = failure;
    const replacement = [
      { slot: 0, mask: CONTENT, snapshot: label(2, 0, 0, "B") },
    ] satisfies readonly RenderChange[];

    await expect(coordinator.commit(2, replacement)).rejects.toBe(failure);
    expect(coordinator.atlas.get(oldKey)).toBeDefined();
    expect(coordinator.atlas.stats.pinnedEntries).toBe(2);

    await expect(
      coordinator.commit(3, [
        { slot: 1, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 8, 0, "C") },
      ]),
    ).rejects.toBeInstanceOf(Error);
    expect(coordinator.atlas.stats.capacityFailures).toBeGreaterThan(0);
    expect(coordinator.atlas.get(oldKey)).toBeDefined();

    const retry = await coordinator.commit(2, replacement);
    const replacementKey = retry.atlasCommit.entries.find((entry) => entry.key !== oldKey)?.key;
    expect(replacementKey).toBeDefined();
    expect(coordinator.atlas.stats.pinnedEntries).toBe(1);

    await coordinator.destroy();
    instances.destroy();
    registry.destroy();
  });

  test("releases every positioned-run lease once and reports the first cleanup failure", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const firstFailure = new Error("first positioned-run release failed");
    const releases = [0, 0];
    const coordinator = new RenderCoordinator({
      registry,
      layoutEngine: {
        layout(_slot, _revision, input) {
          const index = input.text === "A" ? 0 : 1;
          return leasePositionedRun(runChars(input.text), () => {
            releases[index] = (releases[index] ?? 0) + 1;
            throw index === 0 ? firstFailure : new Error("second positioned-run release failed");
          });
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return alphaRaster();
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
    });

    const changes = [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0, "A") },
      { slot: 1, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 8, 0, "B") },
    ];
    await expect(coordinator.commit(1, changes)).rejects.toBe(firstFailure);
    expect(releases).toEqual([1, 1]);
    expect((await coordinator.commit(1, changes)).atlasCommit.uploads).toHaveLength(2);

    await destroyCoordinatorFixture(coordinator, registry);
    expect(releases).toEqual([1, 1]);
  });

  for (const exit of ["capacity", "invalid"] as const) {
    test(`consumes an external raster once when atlas staging reports ${exit}`, async () => {
      const registry = new FontRegistry();
      await registry.register({ family: "Fixture" });
      const external = coordinatorExternalRaster(exit === "invalid" ? { width: 0 } : undefined);
      const coordinator = new RenderCoordinator({
        registry,
        layoutEngine: {
          layout(_slot, _revision, input) {
            return runChars(input.text);
          },
          destroy() {},
        },
        glyphProvider: {
          async rasterize(): Promise<GlyphRaster> {
            return external.raster as unknown as GlyphRaster;
          },
          destroy() {},
        },
        atlasOptions: {
          pageWidth: 16,
          pageHeight: 16,
          maxBytes: exit === "capacity" ? 255 : 1_024,
        },
      });

      await expect(
        coordinator.commit(1, [
          { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0, "A") },
        ]),
      ).rejects.toBeInstanceOf(Error);
      expect(external.releases()).toBe(1);

      await coordinator.destroy();
      registry.destroy();
      expect(external.releases()).toBe(1);
    });
  }

  test("lets a destroyed atlas consume a completed external raster once", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const atlas = new GlyphAtlas({ pageWidth: 16, pageHeight: 16, maxBytes: 1_024 });
    const external = coordinatorExternalRaster();
    let resolveRaster!: (raster: GlyphRaster) => void;
    let rasterStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      rasterStarted = resolve;
    });
    const coordinator = new RenderCoordinator({
      registry,
      atlas,
      layoutEngine: {
        layout(_slot, _revision, input) {
          return runChars(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        rasterize(): Promise<GlyphRaster> {
          rasterStarted();
          return new Promise((resolve) => {
            resolveRaster = resolve;
          });
        },
        destroy() {},
      },
    });
    const pending = coordinator.commit(1, [
      { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0, "A") },
    ]);
    await started;
    atlas.destroy();
    resolveRaster(external.raster as unknown as GlyphRaster);

    await expect(pending).rejects.toThrow("GlyphAtlas has been destroyed");
    expect(external.releases()).toBe(1);
    await destroyCoordinatorFixture(coordinator, registry);
    expect(external.releases()).toBe(1);
  });

  test("replays one externally owned upload after an instance fault and transfers it once", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const instances = new FaultingGlyphInstanceStore({ initialCapacity: 4 });
    const external = coordinatorExternalRaster();
    const coordinator = new RenderCoordinator({
      registry,
      instances,
      layoutEngine: {
        layout(_slot, _revision, input) {
          return runChars(input.text);
        },
        destroy() {},
      },
      glyphProvider: {
        async rasterize(): Promise<GlyphRaster> {
          return external.raster as unknown as GlyphRaster;
        },
        destroy() {},
      },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
    });
    const failure = new Error("external instance write failed");
    instances.failNextSet = failure;
    const changes = [{ slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0, "A") }];

    await expect(coordinator.commit(1, changes)).rejects.toBe(failure);
    expect(external.releases()).toBe(0);
    const retry = await coordinator.commit(1, changes);
    expect(retry.atlasCommit.externalUploads).toHaveLength(1);
    retry.atlasCommit.externalUploads[0]?.release();
    expect(external.releases()).toBe(1);

    await coordinator.destroy();
    instances.destroy();
    registry.destroy();
    expect(external.releases()).toBe(1);
  });

  for (const malformed of ["position", "note-position", "content", "admit", "resident"] as const) {
    test(`validates malformed ${malformed} lane input before layout and atlas mutation`, async () => {
      const fixture = await createFaultingLaneCoordinator();
      const snapshot = label(1, 0, 0, "A");
      const invoke = (): unknown => {
        if (malformed === "position") {
          return fixture.coordinator.applyPositionLane(
            new Uint32Array([0]),
            2,
            new Float32Array([0, 0, 1, 1]),
          );
        }
        if (malformed === "note-position") return fixture.coordinator.notePositionLane(0.5);
        if (malformed === "content") {
          return fixture.coordinator.applyContentLane({
            slots: new Uint32Array([0]),
            count: 2,
            xy: new Float32Array([0, 0, 1, 1]),
            text: "A",
            style: snapshot.style,
          });
        }
        const group = {
          slots: new Uint32Array([malformed === "resident" ? 0x100_0000 : 0]),
          count: malformed === "admit" ? 0.5 : 1,
          xy: new Float32Array([0, 0]),
          orders: new Uint32Array([0]),
          text: "A",
          style: snapshot.style,
        };
        if (malformed === "admit") return fixture.coordinator.applyAdmitLane([group]);
        return fixture.coordinator.applyResidentAdmitLane([
          { ...group, zIndex: 0, blendMode: "normal" },
        ]);
      };

      await expect(Promise.resolve().then(invoke)).rejects.toBeInstanceOf(Error);
      expect(fixture.layoutCalls()).toBe(0);
      expect(fixture.rasterCalls()).toBe(0);
      expect(fixture.coordinator.atlas.stats).toMatchObject({ entries: 0, pendingEntries: 0 });
      expect(fixture.coordinator.stats.revisions).toBe(0);

      await fixture.coordinator.destroy();
      fixture.instances.destroy();
      fixture.transforms.destroy();
      fixture.registry.destroy();
    });
  }

  test("finishes every owned teardown and preserves the first fault across async provider disposal", async () => {
    const registry = new FontRegistry();
    await registry.register({ family: "Fixture" });
    const layout = LayoutEngine.prototype.layout;
    LayoutEngine.prototype.layout = function (_slot, _revision, input) {
      return run(input.text);
    };
    const coordinator = new RenderCoordinator({
      registry,
      rasterizerOptions: { canvasRasterizer: async () => alphaRaster() },
      atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
    });
    try {
      await coordinator.commit(1, [
        { slot: 0, mask: CONTENT | TRANSFORM | STYLE, snapshot: label(1, 0, 0) },
      ]);
    } finally {
      LayoutEngine.prototype.layout = layout;
    }

    const layoutFailure = new Error("layout teardown failed");
    const providerFailure = new Error("provider teardown failed");
    const atlasFailure = new Error("atlas teardown failed");
    const instanceFailure = new Error("instance teardown failed");
    const transformFailure = new Error("transform teardown failed");
    const calls = { layout: 0, provider: 0, atlas: 0, instances: 0, transforms: 0 };
    let inactiveBeforeLayoutDestroy = false;
    let rejectProvider: ((reason: unknown) => void) | undefined;
    const layoutDestroy = LayoutEngine.prototype.destroy;
    const providerDestroy = RasterGlyphProvider.prototype.destroy;
    const atlasDestroy = GlyphAtlas.prototype.destroy;
    const instanceDestroy = GlyphInstanceStore.prototype.destroy;
    const transformDestroy = TransformPalette.prototype.destroy;

    LayoutEngine.prototype.destroy = function (): void {
      calls.layout += 1;
      try {
        coordinator.getDrawStates();
      } catch {
        inactiveBeforeLayoutDestroy = true;
      }
      layoutDestroy.call(this);
      throw layoutFailure;
    };
    RasterGlyphProvider.prototype.destroy = function (): Promise<void> {
      calls.provider += 1;
      return new Promise((_resolve, reject) => {
        rejectProvider = reject;
      });
    };
    GlyphAtlas.prototype.destroy = function (): void {
      calls.atlas += 1;
      atlasDestroy.call(this);
      throw atlasFailure;
    };
    GlyphInstanceStore.prototype.destroy = function (): void {
      calls.instances += 1;
      instanceDestroy.call(this);
      throw instanceFailure;
    };
    TransformPalette.prototype.destroy = function (): void {
      calls.transforms += 1;
      transformDestroy.call(this);
      throw transformFailure;
    };

    try {
      const teardown = coordinator.destroy();
      expect(teardown).toBeInstanceOf(Promise);
      expect(() => coordinator.getDrawStates()).toThrow("RenderCoordinator has been destroyed");
      await waitForPredicate(() => rejectProvider !== undefined, "provider destroy");
      expect(calls).toEqual({ layout: 1, provider: 1, atlas: 1, instances: 1, transforms: 1 });
      expect(inactiveBeforeLayoutDestroy).toBe(true);
      expect(coordinator.destroy()).toBe(teardown);

      rejectProvider?.(providerFailure);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(teardown).rejects.toBe(layoutFailure);
      expect(coordinator.destroy()).toBe(teardown);
      expect(calls).toEqual({ layout: 1, provider: 1, atlas: 1, instances: 1, transforms: 1 });
    } finally {
      LayoutEngine.prototype.destroy = layoutDestroy;
      RasterGlyphProvider.prototype.destroy = providerDestroy;
      GlyphAtlas.prototype.destroy = atlasDestroy;
      GlyphInstanceStore.prototype.destroy = instanceDestroy;
      TransformPalette.prototype.destroy = transformDestroy;
      registry.destroy();
    }
  });
});

class FaultingGlyphInstanceStore extends GlyphInstanceStore {
  failNextSet: Error | undefined;

  override set(...args: Parameters<GlyphInstanceStore["set"]>): boolean {
    const failure = this.failNextSet;
    this.failNextSet = undefined;
    if (failure !== undefined) throw failure;
    return super.set(...args);
  }
}

class FaultingTransformPalette extends TransformPalette {
  failNextPositions: Error | undefined;
  failNextFills: Error | undefined;

  override writePositions(...args: Parameters<TransformPalette["writePositions"]>): number {
    const failure = this.failNextPositions;
    this.failNextPositions = undefined;
    if (failure !== undefined) throw failure;
    return super.writePositions(...args);
  }

  override writeFills(...args: Parameters<TransformPalette["writeFills"]>): number {
    const failure = this.failNextFills;
    this.failNextFills = undefined;
    if (failure !== undefined) throw failure;
    return super.writeFills(...args);
  }

  override writeCanonicalFills(
    ...args: Parameters<TransformPalette["writeCanonicalFills"]>
  ): number {
    const failure = this.failNextFills;
    this.failNextFills = undefined;
    if (failure !== undefined) throw failure;
    return super.writeCanonicalFills(...args);
  }
}

async function createFaultingLaneCoordinator(releaseFailure?: Error): Promise<{
  readonly coordinator: RenderCoordinator;
  readonly instances: FaultingGlyphInstanceStore;
  readonly transforms: FaultingTransformPalette;
  readonly registry: FontRegistry;
  readonly layoutCalls: () => number;
  readonly rasterCalls: () => number;
  readonly releaseCalls: () => number;
}> {
  const registry = new FontRegistry();
  await registry.register({ family: "Fixture" });
  const instances = new FaultingGlyphInstanceStore({ initialCapacity: 4 });
  const transforms = new FaultingTransformPalette({ initialCapacity: 4, textureWidth: 4 });
  let layouts = 0;
  let rasters = 0;
  let releases = 0;
  const coordinator = new RenderCoordinator({
    registry,
    instances,
    transforms,
    layoutEngine: {
      layout(_slot, _revision, input) {
        layouts += 1;
        const run = runChars(input.text);
        if (releaseFailure === undefined) return run;
        return leasePositionedRun(run, () => {
          releases += 1;
          throw releaseFailure;
        });
      },
      destroy() {},
    },
    glyphProvider: {
      async rasterize(): Promise<GlyphRaster> {
        rasters += 1;
        return alphaRaster();
      },
      destroy() {},
    },
    atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 },
  });
  return {
    coordinator,
    instances,
    transforms,
    registry,
    layoutCalls: () => layouts,
    rasterCalls: () => rasters,
    releaseCalls: () => releases,
  };
}

async function createStyleSensitiveCoordinator(): Promise<{
  readonly coordinator: RenderCoordinator;
  readonly registry: FontRegistry;
  readonly layoutCalls: () => number;
}> {
  const registry = new FontRegistry();
  await registry.register({ family: "Fixture" });
  let layouts = 0;
  const coordinator = new RenderCoordinator({
    registry,
    layoutEngine: {
      layout(_slot, _revision, input) {
        layouts += 1;
        const shift =
          Number(input.style.letterSpacing ?? 0) +
          Number(input.style.wordWrapWidth ?? 0) +
          Number(input.style.lineHeight ?? 0);
        return shiftedRun(input.text, shift);
      },
      destroy() {},
    },
    glyphProvider: {
      async rasterize(): Promise<GlyphRaster> {
        return alphaRaster();
      },
      destroy() {},
    },
    atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
    instanceOptions: { initialCapacity: 4 },
  });
  return { coordinator, registry, layoutCalls: () => layouts };
}

function coordinatorExternalRaster(
  overrides: Partial<Pick<ExternalColorGlyphRaster, "width" | "height">> = {},
): {
  readonly raster: ExternalColorGlyphRaster;
  readonly releases: () => number;
} {
  let releases = 0;
  const raster: ExternalColorGlyphRaster = {
    mode: "color",
    width: overrides.width ?? 2,
    height: overrides.height ?? 2,
    source: {
      texture: {} as GPUTexture,
      format: "rgba8unorm",
      width: 2,
      height: 2,
    },
    sourceX: 0,
    sourceY: 0,
    release() {
      releases += 1;
    },
  };
  return { raster, releases: () => releases };
}

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
    style: FIXTURE_STYLE,
  };
}

function contentLane(
  slot: number,
  x: number,
  y: number,
  text: string,
  style: Readonly<TextStyleOptions>,
): ContentLaneInput {
  return {
    slots: new Uint32Array([slot]),
    count: 1,
    xy: new Float32Array([x, y]),
    text,
    style,
  };
}

function singleAdmitGroup(
  slot: number,
  x: number,
  y: number,
  text: string,
  style: Readonly<TextStyleOptions>,
  order = slot,
): AdmitLaneGroup {
  return {
    slots: new Uint32Array([slot]),
    count: 1,
    xy: new Float32Array([x, y]),
    orders: new Uint32Array([order]),
    text,
    style,
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

function shiftedRun(
  text: string,
  x: number,
  direction: PositionedRun["direction"] = "ltr",
): Readonly<PositionedRun> {
  const base = runChars(text);
  return Object.freeze({
    ...base,
    direction,
    x: new Float32Array(base.glyphCount).fill(x),
    bounds: Object.freeze({ ...base.bounds, x: 0 }),
  });
}

function instanceX(coordinator: RenderCoordinator, slot: number): number | undefined {
  const range = coordinator.instances.getRange(slot);
  if (range === undefined) return undefined;
  const view = new DataView(
    coordinator.instances.buffer,
    range.offset * GLYPH_INSTANCE_STRIDE,
    GLYPH_INSTANCE_STRIDE,
  );
  return unpackF16(view.getUint16(0, true));
}

async function createGatedCoordinator(atlas?: GlyphAtlas): Promise<{
  readonly coordinator: RenderCoordinator;
  readonly gates: Map<string, () => void>;
  readonly registry: FontRegistry;
}> {
  const registry = new FontRegistry();
  await registry.register({ family: "Fixture" });
  const gates = new Map<string, () => void>();
  const coordinator = new RenderCoordinator({
    registry,
    layoutEngine: {
      layout(_slot, _revision, input) {
        return runChars(input.text);
      },
      destroy() {},
    },
    glyphProvider: {
      rasterize(request: RasterGlyphRequest): Promise<GlyphRaster> {
        return new Promise((resolve) => {
          let gateKey = request.glyphText;
          let occurrence = 2;
          while (gates.has(gateKey)) {
            gateKey = `${request.glyphText}#${String(occurrence)}`;
            occurrence += 1;
          }
          gates.set(gateKey, () => {
            resolve({
              mode: request.mode,
              width: 2,
              height: 2,
              pixels: new Uint8Array(request.mode === "color" ? 16 : 4).fill(255),
            });
          });
        });
      },
      destroy() {},
    },
    ...(atlas === undefined
      ? { atlasOptions: { pageWidth: 16, pageHeight: 16, maxBytes: 1_024 } }
      : { atlas }),
  });
  return { coordinator, gates, registry };
}

function alphaRaster(): GlyphRaster {
  return {
    mode: "alpha",
    width: 2,
    height: 2,
    pixels: new Uint8Array(4).fill(255),
  };
}

function layoutRaster(): GlyphRaster {
  return {
    mode: "alpha",
    width: 4,
    height: 6,
    pixels: new Uint8Array(24).fill(255),
    metrics: { bearingX: 0, bearingY: 5, advance: 4 },
  };
}

async function destroyCoordinatorFixture(
  coordinator: RenderCoordinator,
  registry: FontRegistry,
): Promise<void> {
  await coordinator.destroy();
  registry.destroy();
}

async function waitForPredicate(predicate: () => boolean, name: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${name}`);
}

/** Visual RTL order: last char, space, first char, with HarfBuzz-style omitted glyph keys. */
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

function exactHarfBuzzRun(
  text: string,
  glyphIds: readonly number[],
  clusters: readonly number[],
  clusterEnds: readonly number[],
  variationKey: string,
): Readonly<PositionedRun> {
  const glyphCount = glyphIds.length;
  return Object.freeze({
    source: "harfbuzz" as const,
    text,
    fontFamily: "Fixture",
    fontRevision: 1,
    glyphCount,
    direction: "ltr" as const,
    glyphIds: new Uint32Array(glyphIds),
    clusters: new Uint32Array(clusters),
    clusterEnds: new Uint32Array(clusterEnds),
    variationKey,
    x: Float32Array.from({ length: glyphCount }, (_, index) => index * 5),
    y: new Float32Array(glyphCount),
    xAdvance: new Float32Array(glyphCount).fill(5),
    yAdvance: new Float32Array(glyphCount),
    lineIndices: new Uint32Array(glyphCount),
    bounds: Object.freeze({ x: 0, y: -5, width: glyphCount * 5, height: 6 }),
  });
}

async function waitForGate(gates: Map<string, () => void>, key: string): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (gates.has(key)) return;
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for layout gate: ${key}`);
}
