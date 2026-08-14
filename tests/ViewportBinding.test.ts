import { describe, expect, test } from "bun:test";

import type { Viewport } from "pixi-viewport";
import { Container } from "pixi.js";

import { TextLayer } from "../src";
import { bindViewport, type ViewportLike } from "../src/viewport";

const bindRealViewportType = (layer: TextLayer, viewport: Viewport) =>
  bindViewport(layer, viewport);
void bindRealViewportType;

class FakeViewport implements ViewportLike {
  readonly #host = new Container();
  readonly #listeners = new Map<string, Set<() => void>>();
  screenWidth = 100;
  screenHeight = 100;
  rotation = 0;
  bounds = { x: 0, y: 0, width: 100, height: 100 };

  addChild<T extends Container>(child: T): T {
    return this.#host.addChild(child);
  }

  getVisibleBounds(): Readonly<{ x: number; y: number; width: number; height: number }> {
    return this.bounds;
  }

  toWorld(point: Readonly<{ x: number; y: number }>): Readonly<{ x: number; y: number }> {
    return point;
  }

  on(event: string, listener: () => void): this {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: () => void): this {
    this.#listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string): void {
    for (const listener of this.#listeners.get(event) ?? []) listener();
  }

  listenerCount(event: string): number {
    return this.#listeners.get(event)?.size ?? 0;
  }
}

describe("ViewportBinding", () => {
  test("coalesces drag and zoom storms into one frame culling commit", async () => {
    const layer = new TextLayer({
      rendering: false,
      culling: { enabled: true, bounds: { x: 0, y: 0, width: 100, height: 100 } },
    });
    layer.create({ text: "near", x: 10, y: 10 });
    layer.create({ text: "far", x: 1_000, y: 10 });
    await layer.commit();
    const viewport = new FakeViewport();
    const binding = bindViewport(layer, viewport, { immediate: false });

    viewport.bounds = { x: 950, y: 0, width: 100, height: 100 };
    for (let index = 0; index < 1_000; index += 1) {
      viewport.emit("moved");
      viewport.emit("zoomed");
    }
    expect(binding.stats).toMatchObject({ pending: true, refreshes: 0, inputEvents: 2_000 });

    viewport.emit("frame-end");
    await binding.whenIdle();
    expect(Number(layer.stats.revision)).toBe(1);
    expect(layer.stats.visibleLabelCount).toBe(1);
    expect(binding.stats).toMatchObject({
      pending: false,
      refreshes: 1,
      commits: 1,
      coalescedEvents: 1_999,
    });

    binding.destroy();
    expect(viewport.listenerCount("moved")).toBe(0);
    expect(viewport.listenerCount("zoomed")).toBe(0);
    expect(viewport.listenerCount("frame-end")).toBe(0);
    binding.destroy();
    layer.destroy();
  });

  test("converts rotated viewport corners through the layer local transform", async () => {
    const layer = new TextLayer({ rendering: false });
    const viewport = new FakeViewport();
    viewport.rotation = Math.PI / 4;
    viewport.toWorld = ({ x, y }) => ({ x: x + 20, y: y - 10 });
    layer.position.set(10, -10);
    layer.scale.set(2, 2);
    const binding = bindViewport(layer, viewport);

    await binding.whenIdle();
    expect(binding.stats.lastBounds).toEqual({ x: 5, y: 0, width: 50, height: 50 });

    binding.destroy();
    layer.destroy();
  });
});
