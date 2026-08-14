import type { Viewport } from "pixi-viewport";
import type { Container } from "pixi.js";

import type { BoundsData, PointLike } from "../culling/types";

export type PixiViewport = Viewport;

export interface ViewportLike {
  readonly screenWidth: number;
  readonly screenHeight: number;
  readonly rotation: number;
  addChild<T extends Container>(child: T): T;
  getVisibleBounds(): Readonly<BoundsData>;
  toWorld(point: PointLike): Readonly<PointLike>;
  on(event: "moved" | "zoomed" | "frame-end", listener: () => void): this;
  off(event: "moved" | "zoomed" | "frame-end", listener: () => void): this;
}

export interface ViewportBindingOptions {
  /** Add the layer as a viewport child during binding. */
  readonly addChild?: boolean;
  /** Run the first bounds query during construction. */
  readonly immediate?: boolean;
  /** Remove a layer added by this binding during destruction. */
  readonly removeOnDestroy?: boolean;
  /** Observe an asynchronous culling commit failure. */
  readonly onError?: (error: unknown) => void;
}

export interface ViewportBindingStats {
  readonly pending: boolean;
  readonly inputEvents: number;
  readonly movedEvents: number;
  readonly zoomedEvents: number;
  readonly frameEndEvents: number;
  readonly coalescedEvents: number;
  readonly refreshes: number;
  readonly commits: number;
  readonly failedCommits: number;
  readonly lastDurationMs: number;
  readonly lastBounds: Readonly<BoundsData> | undefined;
}
