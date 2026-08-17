import type { BLEND_MODES, PointData, Renderer, TextStyleOptions } from "pixi.js";

import type { CullPath } from "./culling/computeCull";
import type { BoundsData, MutableBoundsData, PointLike } from "./culling/types";
import type { TextDirection, TextWritingMode } from "./layout/types";
import type { RenderCoordinatorOptions } from "./render/RenderCoordinator";

declare const textIdBrand: unique symbol;
declare const textGroupIdBrand: unique symbol;
declare const textRevisionBrand: unique symbol;

/** Stable identity for a label owned by one {@link TextLayer}. */
export type TextId = number & { readonly [textIdBrand]: "TextId" };

/** Opaque identity for a label group owned by one {@link TextLayer}. */
export type TextGroupId = symbol & { readonly [textGroupIdBrand]: "TextGroupId" };

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
  /**
   * WebGPU compute compact when a device exists. WebGL 2 and missing devices stay on the CPU hash
   * grid. Default is automatic.
   */
  readonly computeCull?: boolean;
}

/** Optional shaping controls for multilingual and variable-font labels. */
export interface TextShapingOptions {
  /** Explicit inline direction. HarfBuzz detects direction when omitted. */
  readonly direction?: TextDirection;
  /** BCP 47 language tag used for language-specific glyph selection. */
  readonly language?: string;
  /** ISO 15924 script tag such as Latn, Hans, Hant, Jpan, or Kore. */
  readonly script?: string;
  /** HarfBuzz/OpenType feature strings such as kern=0 or liga. */
  readonly features?: readonly string[];
  /** OpenType variable-font axis coordinates keyed by axis tag. */
  readonly variations?: Readonly<Record<string, number>>;
}

/** Optional label layout controls applied after shaping. */
export interface TextLayoutOptions {
  /** Horizontal lines or upright top-to-bottom columns ordered from right to left. */
  readonly writingMode?: TextWritingMode;
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
  /** PixiJS blend mode applied to this label's ordered draw segment. */
  readonly blendMode?: BLEND_MODES;
  /** Opacity multiplier. */
  readonly alpha?: number;
  /** Render visibility. */
  readonly visible?: boolean;
  /** Optional layer-local group identity created by {@link TextLayer.createGroup}. */
  readonly group?: TextGroupId;
  /** Origin used for positioning and rotation. */
  readonly anchor?: PointData | number;
  /** PixiJS text style options captured by value. */
  readonly style?: Readonly<TextStyleOptions>;
  /** Writing-flow controls captured by value. */
  readonly layout?: Readonly<TextLayoutOptions>;
  /** Language, script, direction, OpenType feature, and variation controls. */
  readonly shaping?: Readonly<TextShapingOptions>;
}

/** Mutable fields accepted by {@link TextLayer.update}. */
export type TextLabelPatch = Partial<Omit<TextLabelSpec, "group" | "layout" | "shaping">> & {
  /** Replacement group identity. Null clears the current group membership. */
  readonly group?: TextGroupId | null;
  /** Replacement layout controls. Null clears a previous override. */
  readonly layout?: Readonly<TextLayoutOptions> | null;
  /** Replacement shaping controls. Null clears a previous override. */
  readonly shaping?: Readonly<TextShapingOptions> | null;
};

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
  readonly blendMode: BLEND_MODES;
  readonly alpha: number;
  readonly visible: boolean;
  /** Visibility after composing the label flag with its optional group mask. */
  readonly effectiveVisible: boolean;
  readonly group?: TextGroupId;
  readonly anchor: Readonly<PointData>;
  readonly style: Readonly<TextStyleOptions>;
  readonly layout?: Readonly<TextLayoutOptions>;
  readonly shaping?: Readonly<TextShapingOptions>;
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
  readonly lastLayoutMs: number;
  readonly lastInstanceWriteMs: number;
  readonly lastPaletteWriteMs: number;
  readonly lastSpatialUpdateMs: number;
  readonly lastUploadMs: number;
  readonly glyphCount: number;
  readonly pendingGlyphCount: number;
  readonly shapedLabels: number;
  readonly transformOnlyLabels: number;
  readonly removedRenderLabels: number;
  readonly staleRenderRevisions: number;
  readonly visibleLabelCount: number;
  readonly culledLabelCount: number;
  readonly spatialIndexBytes: number;
  readonly cullingQueries: number;
  readonly rendererAdapter: "detached" | "webgl" | "webgpu" | "unknown";
  readonly cullPath: CullPath;
  readonly drawCalls: number;
  readonly submittedGlyphs: number;
  readonly atlasTextureCount: number;
  readonly instanceUploadBytes: number;
  readonly transformUploadBytes: number;
  readonly atlasUploadBytes: number;
}

/** Type-only forward declaration used by API documentation links. */
export interface TextLayer {
  readonly stats: Readonly<TextLayerStats>;
  commit(): Promise<TextRevision>;
  create(spec: TextLabelSpec): TextId;
  get(id: TextId): Readonly<TextLabelSnapshot> | undefined;
  update(id: TextId, patch: TextLabelPatch): boolean;
  createGroup(): TextGroupId;
  hasGroup(group: TextGroupId): boolean;
  setGroupVisible(group: TextGroupId, visible: boolean): number;
  removeGroup(group: TextGroupId): boolean;
  showAll(): number;
  hideAll(): number;
  setViewportBounds(bounds: BoundsData | undefined): void;
  getBoundsFor(
    id: TextId,
    output?: MutableBoundsData,
    space?: "local" | "world",
  ): Readonly<BoundsData> | undefined;
  hitTest(point: PointLike, space?: "local" | "world"): TextId | undefined;
}
