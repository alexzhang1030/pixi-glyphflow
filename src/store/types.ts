import type { TextStyleOptions } from "pixi.js";

import type { TextId } from "../types";

export const TextDirty: Readonly<{
  None: 0;
  Content: 1;
  Transform: 2;
  Style: 4;
}> = Object.freeze({
  None: 0,
  Content: 1,
  Transform: 2,
  Style: 4,
});

export type TextDirtyMask = number;

export interface TextStoreLabel {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotation: number;
  readonly zIndex: number;
  readonly alpha: number;
  readonly visible: boolean;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly style: Readonly<TextStyleOptions>;
}

export type TextStoreLabelPatch = Partial<TextStoreLabel>;

export interface TextStoreSnapshot extends TextStoreLabel {
  readonly id: TextId;
  readonly sourceRevision: number;
}

export interface TextStoreStats {
  readonly size: number;
  readonly capacity: number;
  readonly freeSlots: number;
  readonly numericBytes: number;
  readonly referenceSlotBytes: number;
  readonly allocatedBytes: number;
}

export interface TextStoreCompaction {
  readonly beforeCapacity: number;
  readonly afterCapacity: number;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly releasedBytes: number;
}
