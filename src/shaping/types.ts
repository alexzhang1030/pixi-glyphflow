import type { PositionedRun, TextDirection } from "../layout/types";

export type HarfBuzzRuntime = typeof import("harfbuzzjs");
export type HarfBuzzRuntimeLoader = () => Promise<HarfBuzzRuntime>;

export interface HarfBuzzShapeInput {
  readonly family: string;
  readonly text: string;
  readonly fontSize: number;
  readonly fontRevision?: number;
  readonly direction?: TextDirection;
  readonly language?: string;
  readonly script?: string;
  readonly features?: readonly string[];
  readonly variations?: Readonly<Record<string, number>>;
}

export interface HarfBuzzShaperOptions {
  readonly loadRuntime?: HarfBuzzRuntimeLoader;
  readonly cacheSize?: number;
  readonly fontResourceCacheEntries?: number;
  readonly fontResourceCacheBytes?: number;
}

export interface HarfBuzzShaperStats {
  readonly runtimeLoads: number;
  readonly fontObjects: number;
  readonly fontResourceEntries: number;
  readonly fontResourceBytes: number;
  readonly fontResourceEvictions: number;
  readonly cacheEntries: number;
  readonly hits: number;
  readonly misses: number;
  readonly shapes: number;
  readonly pooledBuffers: number;
  readonly cacheEvictions: number;
}

export type HarfBuzzPositionedRun = PositionedRun & {
  readonly source: "harfbuzz";
};
