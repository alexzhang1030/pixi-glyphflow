import { Application } from "pixi.js";

import { TextLayer } from "../../src";
import { AccessibilityAdapter } from "../../src/accessibility";
import type { AccessibilityAdapterStats } from "../../src/accessibility";

interface MirrorSnapshot {
  readonly text: string | null;
  readonly role: string | null;
  readonly label: string | null;
  readonly description: string | null;
  readonly tabIndex: number;
  readonly lang: string;
  readonly hidden: boolean;
  readonly ariaHidden: string | null;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface AccessibilityFixtureState {
  done: boolean;
  error?: string;
  result?: {
    firstId: string;
    secondId: string;
    initialFirst: MirrorSnapshot;
    initialSecond: MirrorSnapshot;
    updatedFirst: MirrorSnapshot;
    hiddenSecond: MirrorSnapshot;
    restoredSecond: MirrorSnapshot;
    firstElementStable: boolean;
    boundsMatch: boolean;
    noOpUpdates: number;
    removedMirrorCount: number;
    stats: Readonly<AccessibilityAdapterStats>;
  };
  destroy?: () => Readonly<{ overlays: number; mirrors: number }>;
}

declare global {
  interface Window {
    __glyphflowAccessibility: AccessibilityFixtureState;
  }
}

window.__glyphflowAccessibility = { done: false };

void run().catch((error: unknown) => {
  window.__glyphflowAccessibility.error =
    error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  window.__glyphflowAccessibility.done = true;
});

async function run(): Promise<void> {
  const fixture = document.querySelector<HTMLElement>("#fixture");
  if (fixture === null) throw new Error("Accessibility fixture host is unavailable");
  const app = new Application();
  await app.init({
    width: 320,
    height: 180,
    backgroundAlpha: 0,
    antialias: false,
    preference: "webgl",
    preferWebGLVersion: 2,
    preserveDrawingBuffer: true,
  });
  fixture.append(app.canvas);

  const layer = new TextLayer({ renderer: app.renderer, culling: false });
  app.stage.addChild(layer);
  const first = layer.create({
    text: "Primary action",
    x: 24,
    y: 72,
    style: { fontFamily: "Arial", fontSize: 34, fill: 0xffffff },
  });
  const second = layer.create({
    text: "Documentation",
    x: 142,
    y: 132,
    style: { fontFamily: "Arial", fontSize: 24, fill: 0xffffff },
  });
  const temporary = layer.create({
    text: "Temporary",
    x: 8,
    y: 24,
    style: { fontFamily: "Arial", fontSize: 16, fill: 0xffffff },
  });
  await layer.commit();
  app.render();

  const adapter = new AccessibilityAdapter(layer, {
    container: fixture,
    className: "glyphflow-a11y",
  });
  const firstElement = adapter.select(first, {
    role: "button",
    label: "Open primary action",
    tabIndex: 2,
    lang: "en",
  });
  const secondElement = adapter.select(second, {
    role: "link",
    description: "Opens the project documentation",
    tabIndex: 1,
    lang: "en",
  });
  adapter.select(temporary, { role: "note" });
  adapter.deselect(temporary);
  const initialFirst = snapshotElement(firstElement);
  const initialSecond = snapshotElement(secondElement);
  const expectedBounds = layer.getBoundsFor(first, undefined, "world");
  const boundsMatch =
    expectedBounds !== undefined &&
    close(initialFirst.left, expectedBounds.x) &&
    close(initialFirst.top, expectedBounds.y) &&
    close(initialFirst.width, expectedBounds.width) &&
    close(initialFirst.height, expectedBounds.height);

  layer.update(first, { text: "Primary action updated", x: 42 });
  layer.update(second, { visible: false });
  await layer.commit();
  app.render();
  const updatedFirst = snapshotElement(firstElement);
  const hiddenSecond = snapshotElement(secondElement);

  layer.update(second, { visible: true });
  await layer.commit();
  app.render();
  const restoredSecond = snapshotElement(secondElement);
  const noOpUpdates = adapter.sync();

  window.__glyphflowAccessibility.result = {
    firstId: String(first),
    secondId: String(second),
    initialFirst,
    initialSecond,
    updatedFirst,
    hiddenSecond,
    restoredSecond,
    firstElementStable: adapter.getElement(first) === firstElement,
    boundsMatch,
    noOpUpdates,
    removedMirrorCount: adapter.stats.removedElements,
    stats: adapter.stats,
  };
  window.__glyphflowAccessibility.destroy = () => {
    adapter.destroy();
    return {
      overlays: fixture.querySelectorAll("[data-pixi-glyphflow-accessibility]").length,
      mirrors: fixture.querySelectorAll("[data-pixi-glyphflow-text-id]").length,
    };
  };
  window.__glyphflowAccessibility.done = true;
}

function snapshotElement(element: HTMLElement): MirrorSnapshot {
  return {
    text: element.textContent,
    role: element.getAttribute("role"),
    label: element.getAttribute("aria-label"),
    description: element.getAttribute("aria-description"),
    tabIndex: element.tabIndex,
    lang: element.lang,
    hidden: element.hidden === true,
    ariaHidden: element.getAttribute("aria-hidden"),
    left: Number.parseFloat(element.style.left),
    top: Number.parseFloat(element.style.top),
    width: Number.parseFloat(element.style.width),
    height: Number.parseFloat(element.style.height),
  };
}

function close(first: number, second: number): boolean {
  return Math.abs(first - second) < 0.01;
}
