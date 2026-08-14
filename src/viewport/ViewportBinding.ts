import type { Container, Matrix } from "pixi.js";

import type { BoundsData, PointLike } from "../culling/types";
import type { TextLayer } from "../TextLayer";
import type { TextRevision } from "../types";
import type { ViewportBindingOptions, ViewportBindingStats, ViewportLike } from "./types";

export class ViewportBinding {
  readonly #layer: TextLayer;
  readonly #viewport: ViewportLike;
  readonly #options: ViewportBindingOptions;
  readonly #addedLayer: boolean;
  readonly #onMoved = (): void => this.#mark("moved");
  readonly #onZoomed = (): void => this.#mark("zoomed");
  readonly #onFrameEnd = (): void => {
    this.#frameEndEvents += 1;
    if (this.#pending) void this.flush();
  };
  #pending = false;
  #inputEvents = 0;
  #movedEvents = 0;
  #zoomedEvents = 0;
  #frameEndEvents = 0;
  #coalescedEvents = 0;
  #refreshes = 0;
  #commits = 0;
  #failedCommits = 0;
  #lastDurationMs = 0;
  #lastBounds: Readonly<BoundsData> | undefined;
  #lastCommit: Promise<TextRevision>;
  #destroyed = false;

  constructor(layer: TextLayer, viewport: ViewportLike, options: ViewportBindingOptions = {}) {
    this.#layer = layer;
    this.#viewport = viewport;
    this.#options = options;
    const viewportContainer = viewport as unknown as Container;
    this.#addedLayer = options.addChild !== false && layer.parent !== viewportContainer;
    if (this.#addedLayer) viewport.addChild(layer);
    viewport.on("moved", this.#onMoved);
    viewport.on("zoomed", this.#onZoomed);
    viewport.on("frame-end", this.#onFrameEnd);
    this.#lastCommit = Promise.resolve(layer.stats.revision);
    if (options.immediate !== false) {
      this.#pending = true;
      void this.flush();
    }
  }

  flush(): Promise<TextRevision> {
    this.#assertActive();
    if (!this.#pending) return this.#lastCommit;
    this.#pending = false;
    const start = performance.now();
    const bounds = viewportBoundsInLayer(this.#viewport, this.#layer);
    this.#lastBounds = Object.freeze({ ...bounds });
    this.#layer.setViewportBounds(bounds);
    this.#refreshes += 1;
    const work = this.#layer.commit().then(
      (revision) => {
        this.#commits += 1;
        this.#lastDurationMs = performance.now() - start;
        return revision;
      },
      (error: unknown) => {
        this.#failedCommits += 1;
        this.#lastDurationMs = performance.now() - start;
        throw error;
      },
    );
    this.#lastCommit = work;
    void work.catch((error: unknown) => this.#options.onError?.(error));

    return work;
  }

  whenIdle(): Promise<TextRevision> {
    return this.#lastCommit;
  }

  get stats(): Readonly<ViewportBindingStats> {
    return Object.freeze({
      pending: this.#pending,
      inputEvents: this.#inputEvents,
      movedEvents: this.#movedEvents,
      zoomedEvents: this.#zoomedEvents,
      frameEndEvents: this.#frameEndEvents,
      coalescedEvents: this.#coalescedEvents,
      refreshes: this.#refreshes,
      commits: this.#commits,
      failedCommits: this.#failedCommits,
      lastDurationMs: this.#lastDurationMs,
      lastBounds: this.#lastBounds,
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#viewport.off("moved", this.#onMoved);
    this.#viewport.off("zoomed", this.#onZoomed);
    this.#viewport.off("frame-end", this.#onFrameEnd);
    if (this.#addedLayer && this.#options.removeOnDestroy === true) {
      this.#layer.removeFromParent();
    }
    this.#pending = false;
    this.#destroyed = true;
  }

  #mark(kind: "moved" | "zoomed"): void {
    if (this.#destroyed) return;
    this.#inputEvents += 1;
    if (kind === "moved") this.#movedEvents += 1;
    else this.#zoomedEvents += 1;
    if (this.#pending) this.#coalescedEvents += 1;
    this.#pending = true;
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("ViewportBinding has been destroyed");
    }
  }
}

export function bindViewport(
  layer: TextLayer,
  viewport: ViewportLike,
  options?: ViewportBindingOptions,
): ViewportBinding {
  return new ViewportBinding(layer, viewport, options);
}

function viewportBoundsInLayer(viewport: ViewportLike, layer: TextLayer): BoundsData {
  const visible = viewport.getVisibleBounds();
  let x0 = visible.x;
  let y0 = visible.y;
  let x1 = visible.x + visible.width;
  let y1 = visible.y + visible.height;
  if (viewport.rotation !== 0) {
    const first = viewport.toWorld({ x: 0, y: 0 });
    const second = viewport.toWorld({ x: viewport.screenWidth, y: 0 });
    const third = viewport.toWorld({ x: viewport.screenWidth, y: viewport.screenHeight });
    const fourth = viewport.toWorld({ x: 0, y: viewport.screenHeight });
    x0 = Math.min(first.x, second.x, third.x, fourth.x);
    y0 = Math.min(first.y, second.y, third.y, fourth.y);
    x1 = Math.max(first.x, second.x, third.x, fourth.x);
    y1 = Math.max(first.y, second.y, third.y, fourth.y);
  }
  layer.updateLocalTransform();

  return inverseBounds({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, layer.localTransform);
}

function inverseBounds(bounds: BoundsData, matrix: Matrix): BoundsData {
  const first = inversePoint({ x: bounds.x, y: bounds.y }, matrix);
  const second = inversePoint({ x: bounds.x + bounds.width, y: bounds.y }, matrix);
  const third = inversePoint({ x: bounds.x + bounds.width, y: bounds.y + bounds.height }, matrix);
  const fourth = inversePoint({ x: bounds.x, y: bounds.y + bounds.height }, matrix);
  const minimumX = Math.min(first.x, second.x, third.x, fourth.x);
  const minimumY = Math.min(first.y, second.y, third.y, fourth.y);
  const maximumX = Math.max(first.x, second.x, third.x, fourth.x);
  const maximumY = Math.max(first.y, second.y, third.y, fourth.y);

  return {
    x: minimumX,
    y: minimumY,
    width: maximumX - minimumX,
    height: maximumY - minimumY,
  };
}

function inversePoint(point: PointLike, matrix: Matrix): PointLike {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (determinant === 0) {
    throw new RangeError("TextLayer local transform is singular");
  }
  const x = point.x - matrix.tx;
  const y = point.y - matrix.ty;

  return {
    x: (matrix.d * x - matrix.c * y) / determinant,
    y: (-matrix.b * x + matrix.a * y) / determinant,
  };
}
