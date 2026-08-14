import type { PointData, TextStyleOptions } from "pixi.js";

declare const textIdBrand: unique symbol;
declare const textRevisionBrand: unique symbol;

/** Stable identity for a label owned by one {@link TextLayer}. */
export type TextId = number & { readonly [textIdBrand]: "TextId" };

/** Monotonic revision published by {@link TextLayer.commit}. */
export type TextRevision = number & { readonly [textRevisionBrand]: "TextRevision" };

/**
 * A label accepted by the POC layer.
 *
 * The style object follows PixiJS v8 Canvas Text options. Version `0.0.x` keeps this contract
 * intentionally small while the batched glyph renderer is built.
 */
export interface TextLabelSpec {
  /** Text content rendered by PixiJS. */
  text: string;
  /** Horizontal position in layer-local coordinates. */
  x?: number;
  /** Vertical position in layer-local coordinates. */
  y?: number;
  /** Rotation in radians. */
  rotation?: number;
  /** Opacity multiplier. */
  alpha?: number;
  /** Render visibility. */
  visible?: boolean;
  /** Origin used for positioning and rotation. */
  anchor?: PointData | number;
  /** PixiJS v8 Canvas Text style. */
  style?: TextStyleOptions;
}

/** Mutable fields accepted by `TextLayer.updateLabel`. */
export type TextLabelPatch = Partial<TextLabelSpec>;

/** Observable state for the current POC implementation. */
export interface TextLayerStats {
  /** Rendering path active in this release. */
  readonly backend: "pixi-text-poc";
  /** Labels currently owned by the layer. */
  readonly labelCount: number;
  /** Mutations waiting for the next commit. */
  readonly pendingMutations: number;
  /** Last published revision. */
  readonly revision: TextRevision;
  /** Whether a renderer was supplied through `TextLayer.attach`. */
  readonly attached: boolean;
}
