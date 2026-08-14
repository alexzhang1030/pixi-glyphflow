import type { PointData, Renderer, TextStyleOptions } from "pixi.js";

import type { BoundsData, MutableBoundsData, PointLike } from "./culling/types";
import type { RenderCoordinatorOptions } from "./render/RenderCoordinator";

declare const textIdBrand: unique symbol;
declare const textRevisionBrand: unique symbol;

/** Stable identity for a label owned by one {@link TextLayer}. */
export type TextId = number & { readonly [textIdBrand]: "TextId" };

/** Monotonic revision published by {@link TextLayer.commit}. */
export type TextRevision = number & { readonly [textRevisionBrand]: "TextRevision" };

/** Construction options for a dense text layer. */
export interface TextLayerOptions {
  /** Initial label capacity. Geometric growth preserves accepted identities. */
  readonly initialCapacity?: number;
  /** Renderer association used by the rendering coordinator. */
  readonly renderer?: Renderer;
  /** Rendering coordinator overrides, or false for a CPU-only layer. */
  readonly rendering?: false | TextLayerRenderingOptions;
  /** Dense viewport culling policy. */
  readonly culling?: false | TextLayerCullingOptions;
}

/** Advanced construction seams for custom shaping, rasterization, atlas, and storage policies. */
export type TextLayerRenderingOptions = Omit<RenderCoordinatorOptions, "registry">;

export interface TextLayerCullingOptions {
  readonly enabled?: boolean;
  readonly padding?: number;
  readonly bounds?: BoundsData;
}

/** Label state accepted by {@link TextLayer.create}. */
export interface TextLabelSpec {
  /** Text content. Empty strings remain valid labels. */
  readonly text: string;
  /** Horizontal position in layer-local coordinates. */
  readonly x?: number;
  /** Vertical position in layer-local coordinates. */
  readonly y?: number;
  /** Uniform or x/y scale. */
  readonly scale?: PointData | number;
  /** Horizontal scale override. */
  readonly scaleX?: number;
  /** Vertical scale override. */
  readonly scaleY?: number;
  /** Rotation in radians. */
  readonly rotation?: number;
  /** Draw and hit-test order. Higher values appear above lower values. */
  readonly zIndex?: number;
  /** Opacity multiplier. */
  readonly alpha?: number;
  /** Render visibility. */
  readonly visible?: boolean;
  /** Origin used for positioning and rotation. */
  readonly anchor?: PointData | number;
  /** PixiJS text style options captured by value. */
  readonly style?: Readonly<TextStyleOptions>;
}

/** Mutable fields accepted by {@link TextLayer.update}. */
export type TextLabelPatch = Partial<TextLabelSpec>;

/** Immutable label state returned by {@link TextLayer.get}. */
export interface TextLabelSnapshot {
  readonly id: TextId;
  readonly sourceRevision: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotation: number;
  readonly zIndex: number;
  readonly alpha: number;
  readonly visible: boolean;
  readonly anchor: Readonly<PointData>;
  readonly style: Readonly<TextStyleOptions>;
}

/** One entry accepted by {@link TextLayer.updateMany}. */
export interface TextUpdate {
  readonly id: TextId;
  readonly patch: TextLabelPatch;
}

/** Memory effect of an explicit CPU-store compaction. */
export interface TextCompactionResult {
  readonly beforeCapacity: number;
  readonly afterCapacity: number;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly releasedBytes: number;
}

/** Observable core state. Rendering, atlas, culling, and worker fields extend this shape. */
export interface TextLayerStats {
  readonly backend: "glyphflow-core";
  readonly labelCount: number;
  readonly capacity: number;
  readonly pendingMutations: number;
  readonly pendingDirtyMask: number;
  readonly pendingDirtyLabels: number;
  readonly revision: TextRevision;
  readonly attached: boolean;
  readonly acceptedMutations: number;
  readonly commits: number;
  readonly numericStoreBytes: number;
  readonly referenceSlotBytes: number;
  readonly allocatedStoreBytes: number;
  readonly lastCommitDurationMs: number;
  readonly lastCommitDirtyLabels: number;
  readonly lastCommitContentLabels: number;
  readonly lastCommitTransformLabels: number;
  readonly lastCommitStyleLabels: number;
  readonly glyphCount: number;
  readonly shapedLabels: number;
  readonly transformOnlyLabels: number;
  readonly removedRenderLabels: number;
  readonly staleRenderRevisions: number;
  readonly visibleLabelCount: number;
  readonly culledLabelCount: number;
  readonly spatialIndexBytes: number;
  readonly cullingQueries: number;
}

/** Type-only forward declaration used by API documentation links. */
export interface TextLayer {
  readonly stats: Readonly<TextLayerStats>;
  commit(): Promise<TextRevision>;
  create(spec: TextLabelSpec): TextId;
  get(id: TextId): Readonly<TextLabelSnapshot> | undefined;
  update(id: TextId, patch: TextLabelPatch): boolean;
  setViewportBounds(bounds: BoundsData | undefined): void;
  getBoundsFor(
    id: TextId,
    output?: MutableBoundsData,
    space?: "local" | "world",
  ): Readonly<BoundsData> | undefined;
  hitTest(point: PointLike, space?: "local" | "world"): TextId | undefined;
}
