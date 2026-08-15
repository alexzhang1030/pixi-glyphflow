import { describe, expect, test } from "bun:test";

import type { Renderer } from "pixi.js";

import { TextLayer } from "../src";
import type { PositionedRun } from "../src";

describe("TextLayer groups", () => {
  test("creates unique groups and associates a label with its group identity", () => {
    const layer = new TextLayer({ culling: false, rendering: false });
    const foreignLayer = new TextLayer({ culling: false, rendering: false });
    const firstGroup = layer.createGroup();
    const secondGroup = layer.createGroup();
    const foreignGroup = foreignLayer.createGroup();

    const id = layer.create({ text: "station", group: firstGroup });

    expect(firstGroup).not.toBe(secondGroup);
    expect(layer.hasGroup(firstGroup)).toBe(true);
    expect(layer.hasGroup(secondGroup)).toBe(true);
    expect(layer.hasGroup(foreignGroup)).toBe(false);
    expect(layer.get(id)).toMatchObject({ group: firstGroup });
    expect(() => layer.create({ text: "foreign", group: foreignGroup })).toThrow(RangeError);

    foreignLayer.destroy();
    layer.destroy();
  });

  test("composes group visibility with each label's local visibility", async () => {
    const layer = new TextLayer({ culling: false, rendering: false });
    const group = layer.createGroup();
    const background = layer.create({ text: "background", zIndex: 1 });
    const member = layer.create({ text: "member", group, zIndex: 2 });
    const locallyHidden = layer.create({ text: "hidden", group, visible: false, zIndex: 3 });
    await layer.commit();

    expect(layer.hitTest({ x: 1, y: 1 })).toBe(member);
    expect(layer.setGroupVisible(group, false)).toBe(1);
    expect(layer.get(member)).toMatchObject({ visible: true, effectiveVisible: false });
    expect(layer.get(locallyHidden)).toMatchObject({ visible: false, effectiveVisible: false });
    expect(layer.hitTest({ x: 1, y: 1 })).toBe(background);
    await layer.commit();
    expect(layer.stats).toMatchObject({
      visibleLabelCount: 1,
      lastCommitDirtyLabels: 1,
      lastCommitTransformLabels: 1,
    });

    expect(layer.setGroupVisible(group, true)).toBe(1);
    expect(layer.get(member)).toMatchObject({ visible: true, effectiveVisible: true });
    expect(layer.get(locallyHidden)).toMatchObject({ visible: false, effectiveVisible: false });
    expect(layer.hitTest({ x: 1, y: 1 })).toBe(member);

    layer.destroy();
  });

  test("moves a label between groups and clears membership", async () => {
    const layer = new TextLayer({ culling: false, rendering: false });
    const firstGroup = layer.createGroup();
    const secondGroup = layer.createGroup();
    const id = layer.create({ text: "movable", group: firstGroup });
    await layer.commit();

    layer.setGroupVisible(firstGroup, false);
    expect(layer.get(id)).toMatchObject({ group: firstGroup, effectiveVisible: false });

    expect(layer.update(id, { group: secondGroup })).toBe(true);
    expect(layer.get(id)).toMatchObject({ group: secondGroup, effectiveVisible: true });

    layer.setGroupVisible(secondGroup, false);
    expect(layer.update(id, { group: null })).toBe(true);
    expect(layer.get(id)?.group).toBeUndefined();
    expect(layer.get(id)?.effectiveVisible).toBe(true);

    layer.destroy();
  });

  test("removes a group while retaining and detaching its labels", async () => {
    const layer = new TextLayer({ culling: false, rendering: false });
    const group = layer.createGroup();
    const id = layer.create({ text: "retained", group });
    await layer.commit();
    layer.setGroupVisible(group, false);

    expect(layer.removeGroup(group)).toBe(true);
    expect(layer.hasGroup(group)).toBe(false);
    expect(layer.get(id)).toMatchObject({ visible: true, effectiveVisible: true });
    expect(layer.get(id)?.group).toBeUndefined();
    expect(layer.removeGroup(group)).toBe(false);
    expect(() => layer.setGroupVisible(group, true)).toThrow(RangeError);

    layer.destroy();
  });

  test("validates group batches before moving any labels", () => {
    const layer = new TextLayer({ culling: false, rendering: false });
    const foreignLayer = new TextLayer({ culling: false, rendering: false });
    const firstGroup = layer.createGroup();
    const secondGroup = layer.createGroup();
    const foreignGroup = foreignLayer.createGroup();
    const ids = layer.createMany([
      { text: "first", group: firstGroup },
      { text: "second", group: firstGroup },
    ]);

    expect(() =>
      layer.updateMany([
        { id: ids[0]!, patch: { x: 20, group: secondGroup } },
        { id: ids[1]!, patch: { group: foreignGroup } },
      ]),
    ).toThrow(RangeError);
    expect(layer.get(ids[0]!)?.x).toBe(0);
    expect(layer.get(ids[0]!)?.group).toBe(firstGroup);

    expect(layer.updateMany(ids.map((id) => ({ id, patch: { group: secondGroup } })))).toBe(2);
    layer.setGroupVisible(secondGroup, false);
    expect(ids.map((id) => layer.get(id)?.effectiveVisible)).toEqual([false, false]);

    foreignLayer.destroy();
    layer.destroy();
  });

  test("retains independently created groups when labels are cleared", () => {
    const layer = new TextLayer({ culling: false, rendering: false });
    const group = layer.createGroup();
    layer.create({ text: "old", group });
    layer.setGroupVisible(group, false);

    expect(layer.clear()).toBe(1);
    expect(layer.hasGroup(group)).toBe(true);
    const replacement = layer.create({ text: "new", group });
    expect(layer.get(replacement)?.effectiveVisible).toBe(false);
    expect(layer.setGroupVisible(group, true)).toBe(1);
    expect(layer.get(replacement)?.effectiveVisible).toBe(true);

    layer.destroy();
  });

  test("ignores side-table patches for a stale label identity", () => {
    const layer = new TextLayer({ culling: false, rendering: false });
    const group = layer.createGroup();
    const stale = layer.create({ text: "removed" });
    expect(layer.remove(stale)).toBe(true);

    expect(() =>
      layer.update(stale, {
        group,
        layout: { writingMode: "vertical-rl" },
      }),
    ).toThrow(RangeError);
    expect(layer.setGroupVisible(group, false)).toBe(0);

    layer.destroy();
  });

  test("keeps the latest group mask after an earlier render commit finishes", async () => {
    let releaseLayout = (): void => {};
    let reportLayoutStarted = (): void => {};
    const layoutGate = new Promise<void>((resolve) => {
      releaseLayout = resolve;
    });
    const layoutStarted = new Promise<void>((resolve) => {
      reportLayoutStarted = resolve;
    });
    const run: Readonly<PositionedRun> = Object.freeze({
      source: "bitmap",
      text: "queued",
      fontFamily: "sans-serif",
      fontRevision: 0,
      glyphCount: 1,
      direction: "ltr",
      glyphIds: new Uint32Array([1]),
      clusters: new Uint32Array([0]),
      x: new Float32Array([0]),
      y: new Float32Array([0]),
      xAdvance: new Float32Array([16]),
      yAdvance: new Float32Array([0]),
      lineIndices: new Uint32Array([0]),
      glyphKeys: Object.freeze(["q"]),
      bounds: Object.freeze({ x: 0, y: 0, width: 16, height: 16 }),
    });
    const layer = new TextLayer({
      renderer: {} as Renderer,
      rendering: {
        layoutEngine: {
          async layout() {
            reportLayoutStarted();
            await layoutGate;
            return run;
          },
          destroy() {},
        },
        glyphProvider: {
          async rasterize() {
            return {
              mode: "alpha" as const,
              width: 8,
              height: 8,
              pixels: new Uint8Array(64).fill(255),
            };
          },
          destroy() {},
        },
        atlasOptions: { pageWidth: 32, pageHeight: 32, maxBytes: 4_096 },
      },
    });
    const group = layer.createGroup();
    layer.create({ text: "queued", group });

    const firstCommit = layer.commit();
    await layoutStarted;
    layer.setGroupVisible(group, false);
    const secondCommit = layer.commit();
    releaseLayout();
    await Promise.all([firstCommit, secondCommit]);

    expect(layer.hitTest({ x: 1, y: 1 })).toBeUndefined();
    expect(layer.stats.visibleLabelCount).toBe(0);

    layer.destroy();
  });
});
