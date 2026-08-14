import type { TextStyle, TextStyleOptions } from "pixi.js";

export type TextDirection = "ltr" | "rtl";

export interface RunBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PositionedRun {
  readonly source: "bitmap" | "harfbuzz" | "trusted";
  readonly text: string;
  readonly fontFamily: string;
  readonly fontRevision: number;
  readonly glyphCount: number;
  readonly direction: TextDirection;
  readonly glyphIds: Readonly<Uint32Array>;
  readonly clusters: Readonly<Uint32Array>;
  readonly x: Readonly<Float32Array>;
  readonly y: Readonly<Float32Array>;
  readonly xAdvance: Readonly<Float32Array>;
  readonly yAdvance: Readonly<Float32Array>;
  readonly lineIndices: Readonly<Uint32Array>;
  readonly glyphKeys?: readonly string[];
  readonly bounds: Readonly<RunBounds>;
}

export interface BitmapLayoutInput {
  readonly text: string;
  readonly style: Readonly<TextStyleOptions>;
  readonly fontRevision?: number;
  readonly direction?: TextDirection;
  readonly trimEnd?: boolean;
  readonly maxLines?: number;
  readonly ellipsis?: string;
}

export interface BitmapLayoutLine {
  readonly width: number;
  readonly charPositions: readonly number[];
  readonly chars: readonly string[];
}

export interface BitmapLayoutData {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly offsetY: number;
  readonly lines: readonly BitmapLayoutLine[];
}

export interface BitmapFontView {
  readonly chars: Readonly<Record<string, { readonly id: number } | undefined>>;
  readonly lineHeight: number;
}

export interface BitmapLayoutManager {
  getFont(text: string, style: TextStyle): BitmapFontView;
  getLayout(text: string, style: TextStyle, trimEnd?: boolean): BitmapLayoutData;
}

export interface BitmapLayoutAdapterOptions {
  readonly cacheSize?: number;
}

export interface LayoutCacheStats {
  readonly entries: number;
  readonly hits: number;
  readonly misses: number;
}

export interface TextLayoutInput {
  readonly text: string;
  readonly style: Readonly<TextStyleOptions>;
  readonly direction?: TextDirection;
  readonly language?: string;
  readonly script?: string;
  readonly features?: readonly string[];
  readonly variations?: Readonly<Record<string, number>>;
  readonly trimEnd?: boolean;
  readonly maxLines?: number;
  readonly ellipsis?: string;
}

export interface PositionedRunShaper {
  shape(
    labelId: number,
    sourceRevision: number,
    input: import("../shaping/types").HarfBuzzShapeInput,
  ): Promise<Readonly<PositionedRun>>;
  destroy?(): void;
}

export interface BitmapLayoutAdapterLike {
  layout(input: BitmapLayoutInput): Readonly<PositionedRun>;
}

export interface LayoutEngineOptions {
  readonly bitmapAdapter?: BitmapLayoutAdapterLike;
  readonly harfbuzzShaper?: PositionedRunShaper;
}

export interface LayoutEngineStats {
  readonly layouts: number;
  readonly bitmapLayouts: number;
  readonly harfbuzzLayouts: number;
}
