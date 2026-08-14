import type { BoundsData } from "../culling/types";

/** ARIA and focus metadata for one selected label. */
export interface AccessibleLabelOptions {
  /** ARIA role applied to the mirror element. */
  readonly role?: string;
  /** Accessible-name override. The rendered text remains the element text content. */
  readonly label?: string;
  /** Optional accessible description. */
  readonly description?: string;
  /** Native tab order. Omit for a read-only accessibility-tree entry. */
  readonly tabIndex?: number;
  /** BCP 47 language tag applied to the mirror element. */
  readonly lang?: string;
}

/** Construction options for the sparse DOM accessibility mirror. */
export interface AccessibilityAdapterOptions {
  /** DOM host that receives one owned overlay element. */
  readonly container: HTMLElement;
  /** Optional class name for the owned overlay. */
  readonly className?: string;
  /** Bounds coordinate space relative to the supplied container. */
  readonly coordinateSpace?: "local" | "world";
  /** Observe a synchronous mirror failure from a layer commit. */
  readonly onError?: (error: unknown) => void;
}

/** Immutable diagnostics for an accessibility adapter. */
export interface AccessibilityAdapterStats {
  readonly selectedLabels: number;
  readonly mirroredLabels: number;
  readonly syncs: number;
  readonly createdElements: number;
  readonly updatedElements: number;
  readonly removedElements: number;
  readonly lastUpdatedElements: number;
  readonly lastBounds: Readonly<BoundsData> | undefined;
  readonly destroyed: boolean;
}
