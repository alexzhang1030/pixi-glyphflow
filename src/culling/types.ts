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
