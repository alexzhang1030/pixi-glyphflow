import { describe, expect, test } from "bun:test";

import { TextLayer } from "../src";

describe("TextLayer label collision", () => {
  test("keeps collision disabled until it is opted in", async () => {
    const layer = new TextLayer({ rendering: false });
    layer.create({ text: "first", x: 0, y: 0, priority: 10, style: { fontSize: 10 } });
    const second = layer.create({
      text: "second",
      x: 0,
      y: 0,
      priority: 1,
      zIndex: 5,
      style: { fontSize: 10 },
    });

    await layer.commit();

    expect(layer.stats).toMatchObject({
      collisionEnabled: false,
      visibleLabelCount: 2,
      collisionCulledLabelCount: 0,
    });
    expect(layer.hitTest({ x: 1, y: 1 })).toBe(second);
    layer.destroy();

    const explicitlyDisabled = new TextLayer({
      rendering: false,
      culling: { collision: { enabled: false } },
    });
    const objectOptIn = new TextLayer({ rendering: false, culling: { collision: {} } });
    expect(explicitlyDisabled.stats.collisionEnabled).toBe(false);
    expect(objectOptIn.stats.collisionEnabled).toBe(true);
    explicitlyDisabled.destroy();
    objectOptIn.destroy();
  });

  test("validates the collision policy boundary", () => {
    expect(
      () =>
        new TextLayer({
          rendering: false,
          culling: { collision: null as never },
        }),
    ).toThrow("Culling collision must be false or an options object");
  });

  test("selects by priority while authored visibility stays independent", async () => {
    const layer = new TextLayer({
      rendering: false,
      culling: { collision: { enabled: true } },
    });
    const important = layer.create({
      text: "important",
      x: 0,
      y: 0,
      priority: 10,
      zIndex: 0,
      style: { fontSize: 10 },
    });
    const decorative = layer.create({
      text: "decorative",
      x: 0,
      y: 0,
      priority: 1,
      zIndex: 100,
      style: { fontSize: 10 },
    });

    await layer.commit();

    expect(layer.get(important)).toMatchObject({ priority: 10, effectiveVisible: true });
    expect(layer.get(decorative)).toMatchObject({ priority: 1, effectiveVisible: true });
    expect(layer.stats).toMatchObject({
      collisionEnabled: true,
      collisionCandidateCount: 2,
      collisionVisibleLabelCount: 1,
      collisionCulledLabelCount: 1,
      visibleLabelCount: 1,
    });
    expect(layer.hitTest({ x: 1, y: 1 })).toBe(important);

    layer.update(decorative, { priority: 20 });
    await layer.commit();
    expect(layer.hitTest({ x: 1, y: 1 })).toBe(decorative);
    layer.destroy();
  });

  test("refreshes the selected set when the camera viewport moves", async () => {
    const layer = new TextLayer({
      rendering: false,
      culling: {
        bounds: { x: 0, y: 0, width: 40, height: 20 },
        collision: { enabled: true },
      },
    });
    const near = layer.create({ text: "near", x: 0, y: 0, priority: 2, style: { fontSize: 10 } });
    layer.create({ text: "near low", x: 0, y: 0, priority: 1, style: { fontSize: 10 } });
    const far = layer.create({ text: "far", x: 100, y: 0, priority: 2, style: { fontSize: 10 } });
    layer.create({ text: "far low", x: 100, y: 0, priority: 1, style: { fontSize: 10 } });

    await layer.commit();
    expect(layer.hitTest({ x: 1, y: 1 })).toBe(near);
    expect(layer.hitTest({ x: 101, y: 1 })).toBeUndefined();

    layer.setViewportBounds({ x: 90, y: 0, width: 40, height: 20 });
    await layer.commit();
    expect(layer.hitTest({ x: 1, y: 1 })).toBeUndefined();
    expect(layer.hitTest({ x: 101, y: 1 })).toBe(far);
    layer.destroy();
  });

  test("reprojects fixed pixel padding after zoom changes", async () => {
    const layer = new TextLayer({
      rendering: false,
      culling: { collision: { enabled: true, padding: 1 } },
    });
    layer.create({ text: "A", x: 0, y: 0, style: { fontSize: 10 } });
    layer.create({ text: "B", x: 7, y: 0, style: { fontSize: 10 } });
    await layer.commit();
    expect(layer.stats.collisionVisibleLabelCount).toBe(1);
    const passes = layer.stats.cullingQueries;

    layer.scale.set(4);
    await layer.commit();
    expect(layer.stats.collisionVisibleLabelCount).toBe(2);
    expect(layer.stats.cullingQueries).toBeGreaterThan(passes);
    layer.destroy();
  });

  test("invalidates cached screen records after a label moves", async () => {
    const layer = new TextLayer({
      rendering: false,
      culling: { collision: { enabled: true } },
    });
    const moving = layer.create({ text: "moving", x: 0, y: 0, priority: 2 });
    const revealed = layer.create({ text: "revealed", x: 0, y: 0, priority: 1 });
    await layer.commit();
    expect(layer.hitTest({ x: 1, y: 1 })).toBe(moving);

    layer.update(moving, { x: 300 });
    await layer.commit();
    expect(layer.hitTest({ x: 1, y: 1 })).toBe(revealed);
    expect(layer.hitTest({ x: 301, y: 1 })).toBe(moving);
    layer.destroy();
  });

  test("keeps priority selection after a removed slot is reused", async () => {
    const layer = new TextLayer({
      rendering: false,
      culling: { collision: { enabled: true } },
    });
    const removed = layer.create({ text: "removed", x: 0, y: 0, priority: 3 });
    const survivor = layer.create({ text: "survivor", x: 0, y: 0, priority: 2 });
    await layer.commit();

    layer.remove(removed);
    const replacement = layer.create({ text: "replacement", x: 0, y: 0, priority: 1 });
    await layer.commit();

    expect(layer.hitTest({ x: 1, y: 1 })).toBe(survivor);
    expect(layer.get(replacement)?.effectiveVisible).toBe(true);
    layer.destroy();
  });

  test("enforces maxVisible after priority selection", async () => {
    const layer = new TextLayer({
      rendering: false,
      culling: { collision: { enabled: true, maxVisible: 2 } },
    });
    const first = layer.create({ text: "A", x: 0, y: 0, priority: 1 });
    const second = layer.create({ text: "B", x: 100, y: 0, priority: 3 });
    const third = layer.create({ text: "C", x: 200, y: 0, priority: 2 });
    await layer.commit();

    expect(layer.stats).toMatchObject({
      collisionCandidateCount: 3,
      collisionVisibleLabelCount: 2,
      densityCulledLabelCount: 1,
    });
    expect(layer.hitTest({ x: 1, y: 1 })).toBeUndefined();
    expect(layer.hitTest({ x: 101, y: 1 })).toBe(second);
    expect(layer.hitTest({ x: 201, y: 1 })).toBe(third);
    expect(layer.get(first)?.effectiveVisible).toBe(true);
    layer.destroy();
  });

  test("publishes collision commit phase timings and clears them on an idle commit", async () => {
    const layer = new TextLayer({
      rendering: false,
      culling: { collision: { enabled: true } },
    });
    layer.create({ text: "phase", x: 0, y: 0 });

    await layer.commit();
    expect(layer.stats.lastVisibilitySelectionMs).toBeGreaterThanOrEqual(0);
    expect(layer.stats.lastRenderPreparationMs).toBeGreaterThanOrEqual(0);
    expect(layer.stats.lastRenderCoordinatorMs).toBe(0);
    expect(layer.stats.lastSurfaceApplyMs).toBe(0);

    await layer.commit();
    expect(layer.stats).toMatchObject({
      lastVisibilitySelectionMs: 0,
      lastRenderPreparationMs: 0,
      lastRenderCoordinatorMs: 0,
      lastSurfaceApplyMs: 0,
    });
    layer.destroy();
  });
});
