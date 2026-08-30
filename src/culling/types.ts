export interface BoundsData {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface MutableBoundsData {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PointLike {
  readonly x: number;
  readonly y: number;
}

/** Affine local-to-screen transform used by CPU culling helpers. */
export interface ScreenTransform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly tx: number;
  readonly ty: number;
}

/** Axis-aligned screen-space box encoded as minimum and maximum edges. */
export interface LabelCollisionAabb {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface MutableLabelCollisionAabb {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface SpatialIndexOptions {
  readonly initialCapacity?: number;
  readonly maxCapacity?: number;
}

export interface SpatialIndexStats {
  readonly entries: number;
  readonly capacity: number;
  readonly allocatedBytes: number;
  readonly queries: number;
  readonly testedEntries: number;
  readonly returnedEntries: number;
  readonly hits: number;
}
