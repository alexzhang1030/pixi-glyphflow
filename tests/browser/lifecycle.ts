import { Application } from "pixi.js";

import { TextLayer } from "../../src";
import { measureVisiblePixels } from "./pixels";

interface LifecycleFixtureState {
  done: boolean;
  error?: string;
  result?: {
    rendererAdapter: string;
    primaryRevision: number;
    reattachedRevision: number;
    primaryInitialChildren: number;
    detachedChildren: number;
    reattachedChildren: number;
    primaryDestroyed: boolean;
    primaryRemovedFromStage: boolean;
    siblingBeforePixels: number;
    siblingAfterDetachPixels: number;
    siblingAfterDestroyPixels: number;
    remoteBeforePixels: number;
    remoteAfterApplicationDestroyPixels: number;
  };
}

declare global {
  interface Window {
    __glyphflowLifecycle: LifecycleFixtureState;
  }
}

window.__glyphflowLifecycle = { done: false };

void run().catch((error: unknown) => {
  window.__glyphflowLifecycle.error =
    error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  window.__glyphflowLifecycle.done = true;
});

async function run(): Promise<void> {
  const renderer =
    new URL(window.location.href).searchParams.get("renderer") === "webgpu" ? "webgpu" : "webgl";
  const firstApp = await createApp(renderer);
  const secondApp = await createApp(renderer);
  document.body.append(firstApp.canvas, secondApp.canvas);

  const primary = new TextLayer({ renderer: firstApp.renderer, culling: false });
  const sibling = new TextLayer({ renderer: firstApp.renderer, culling: false });
  const remote = new TextLayer({ renderer: secondApp.renderer, culling: false });
  firstApp.stage.addChild(primary, sibling);
  secondApp.stage.addChild(remote);

  primary.create({ text: "Primary", x: 24, y: 58, style: { fontSize: 32 } });
  sibling.create({ text: "Sibling", x: 24, y: 118, style: { fontSize: 30 } });
  remote.create({ text: "Remote", x: 36, y: 84, style: { fontSize: 34 } });
  await Promise.all([primary.commit(), sibling.commit(), remote.commit()]);

  const primaryRevision = primary.stats.revision;
  const primaryInitialChildren = primary.children.length;
  const siblingBeforePixels = (await measureVisiblePixels(firstApp, sibling)).count;
  const remoteBeforePixels = (await measureVisiblePixels(secondApp, remote)).count;

  primary.detach();
  const detachedChildren = primary.children.length;
  const siblingAfterDetachPixels = (await measureVisiblePixels(firstApp, sibling)).count;

  primary.attach(firstApp.renderer);
  await primary.commit();
  const reattachedRevision = primary.stats.revision;
  const reattachedChildren = primary.children.length;

  primary.destroy();
  const primaryDestroyed = primary.destroyed;
  const primaryRemovedFromStage = !firstApp.stage.children.includes(primary);
  const siblingAfterDestroyPixels = (await measureVisiblePixels(firstApp, sibling)).count;
  const rendererAdapter = sibling.stats.rendererAdapter;

  firstApp.destroy({ removeView: true }, { children: true, context: true });
  const remoteAfterApplicationDestroyPixels = (await measureVisiblePixels(secondApp, remote)).count;

  window.__glyphflowLifecycle.result = {
    rendererAdapter,
    primaryRevision,
    reattachedRevision,
    primaryInitialChildren,
    detachedChildren,
    reattachedChildren,
    primaryDestroyed,
    primaryRemovedFromStage,
    siblingBeforePixels,
    siblingAfterDetachPixels,
    siblingAfterDestroyPixels,
    remoteBeforePixels,
    remoteAfterApplicationDestroyPixels,
  };
  window.__glyphflowLifecycle.done = true;

  remote.destroy();
  secondApp.destroy({ removeView: true }, { children: true, context: true });
}

async function createApp(renderer: "webgl" | "webgpu"): Promise<Application> {
  const app = new Application();
  await app.init({
    width: 320,
    height: 180,
    backgroundAlpha: 0,
    antialias: false,
    preference: renderer,
    preferWebGLVersion: 2,
    preserveDrawingBuffer: true,
  });
  return app;
}
