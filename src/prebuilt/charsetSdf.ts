import type { TextStyleFontWeight } from "pixi.js";

import { prebuiltGlyphKey } from "../atlas/PrebuiltGlyphProvider";
import { encodeTinySdf, TINY_SDF_RADIUS } from "../atlas/tinySdf";
import type { GlyphMetrics, PrebuiltGlyphProviderOptions } from "../atlas/types";

const DEFAULT_DISTANCE_FIELD_MIN_FONT_SIZE = 48;
const PAGE_WIDTH = 1024;
const EMPTY_INK_RE = /[\p{White_Space}\p{Default_Ignorable_Code_Point}]/u;

export interface CharsetSdfPaint {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  readonly bearingX: number;
  readonly bearingY: number;
  readonly advance: number;
}

export interface CharsetSdfPaintRequest {
  readonly family: string;
  readonly glyphText: string;
  readonly fontSize: number;
  readonly fontWeight: TextStyleFontWeight;
}

export interface CharsetSdfPrebuiltOptions {
  readonly family: string;
  readonly charset: string;
  readonly fontSize: number;
  readonly fontWeight?: TextStyleFontWeight;
  readonly distanceFieldMinFontSize?: number;
  readonly rasterize?: (
    request: CharsetSdfPaintRequest,
  ) => CharsetSdfPaint | Promise<CharsetSdfPaint>;
}

interface BakedCharsetGlyph {
  readonly glyphText: string;
  readonly pageId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly bearingX: number;
  readonly bearingY: number;
  readonly advance: number;
}

interface BakedCharset {
  readonly pages: PrebuiltGlyphProviderOptions["pages"];
  readonly glyphs: readonly BakedCharsetGlyph[];
}

const bakedByKey = new Map<string, Promise<BakedCharset>>();

/**
 * Unique ink scalars from host text. Spaces, other White_Space except Ogham, and default ignorables
 * are omitted so the bake matches the coordinator skip.
 */
export function uniqueInkCharset(text: string): string {
  if (typeof text !== "string") throw new TypeError("charset text must be a string");
  const seen = new Set<number>();
  let out = "";
  for (const glyph of text) {
    const codePoint = glyph.codePointAt(0);
    if (codePoint === undefined || seen.has(codePoint) || isEmptyInkCodePoint(codePoint)) continue;
    seen.add(codePoint);
    out += glyph;
  }
  return out;
}

/**
 * TinySDF pages for a host charset. First bake for a family + physical size + weight + charset
 * encodes; later calls remap keys and logical `rasterScale`. Pages stay out of the core graph. Does
 * not ship CJK bitmaps — the host paints, typically after `FontFace.load`.
 */
export async function charsetSdfPrebuilt(
  options: CharsetSdfPrebuiltOptions,
): Promise<PrebuiltGlyphProviderOptions> {
  if (typeof options.family !== "string" || options.family.length === 0) {
    throw new TypeError("family must be a non-empty string");
  }
  if (typeof options.charset !== "string") {
    throw new TypeError("charset must be a string");
  }
  if (!Number.isFinite(options.fontSize) || options.fontSize <= 0) {
    throw new TypeError("fontSize must be a positive finite number");
  }
  const minSize = options.distanceFieldMinFontSize ?? DEFAULT_DISTANCE_FIELD_MIN_FONT_SIZE;
  if (!Number.isFinite(minSize) || minSize <= 0) {
    throw new TypeError("distanceFieldMinFontSize must be a positive finite number");
  }
  const fontWeight = options.fontWeight ?? "normal";
  const physicalSize = Math.max(options.fontSize, minSize);
  const rasterScale = physicalSize / options.fontSize;
  const charset = uniqueInkCharset(options.charset);
  const bakeKey = [
    options.family,
    fontWeight,
    String(physicalSize),
    [...charset].sort().join(""),
  ].join("\0");
  const rasterize = options.rasterize ?? paintAlphaGlyph;
  let pending = bakedByKey.get(bakeKey);
  if (pending === undefined) {
    pending = bakeCharset({
      family: options.family,
      charset,
      physicalSize,
      fontWeight,
      rasterize,
    });
    bakedByKey.set(bakeKey, pending);
    void pending.catch(() => {
      if (bakedByKey.get(bakeKey) === pending) bakedByKey.delete(bakeKey);
    });
  }
  const baked = await pending;
  return {
    pages: baked.pages,
    glyphs: baked.glyphs.map((glyph) => ({
      key: prebuiltGlyphKey({
        family: options.family,
        glyphId: 0,
        glyphText: glyph.glyphText,
        fontSize: options.fontSize,
        fontWeight,
        mode: "sdf",
      }),
      pageId: glyph.pageId,
      x: glyph.x,
      y: glyph.y,
      width: glyph.width,
      height: glyph.height,
      metrics: scaledFieldMetrics(
        glyph.bearingX,
        glyph.bearingY,
        glyph.advance,
        TINY_SDF_RADIUS,
        rasterScale,
      ),
    })),
  };
}

/** Concatenate family pages. Page ids and glyph keys must stay unique. */
export function mergePrebuilt(
  ...parts: readonly PrebuiltGlyphProviderOptions[]
): PrebuiltGlyphProviderOptions {
  const pages: PrebuiltGlyphProviderOptions["pages"][number][] = [];
  const glyphs: PrebuiltGlyphProviderOptions["glyphs"][number][] = [];
  const pageIds = new Set<string>();
  const keys = new Set<string>();
  for (const part of parts) {
    for (const page of part.pages) {
      if (pageIds.has(page.id)) {
        throw new RangeError(`Duplicate prebuilt page id: ${page.id}`);
      }
      pageIds.add(page.id);
      pages.push(page);
    }
    for (const glyph of part.glyphs) {
      if (keys.has(glyph.key)) {
        throw new RangeError(`Duplicate prebuilt glyph key: ${glyph.key}`);
      }
      keys.add(glyph.key);
      glyphs.push(glyph);
    }
  }
  return { pages, glyphs };
}

/**
 * Canvas alpha mask at `fontSize`. Used by `charsetSdfPrebuilt` when the host does not inject
 * paint.
 */
export function paintAlphaGlyph(request: CharsetSdfPaintRequest): CharsetSdfPaint {
  const canvas = createCanvas(1, 1);
  let context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    throw new Error("Canvas 2D context is unavailable");
  }
  context.font = canvasFont(request);
  const measurement = context.measureText(request.glyphText);
  const padding = Math.max(8, Math.ceil(request.fontSize * 0.25));
  const left = measurement.actualBoundingBoxLeft || 0;
  const right = measurement.actualBoundingBoxRight || measurement.width;
  const ascent = measurement.actualBoundingBoxAscent || request.fontSize;
  const descent = measurement.actualBoundingBoxDescent || request.fontSize * 0.25;
  const width = Math.max(1, Math.ceil(left + right) + padding * 2);
  const height = Math.max(1, Math.ceil(ascent + descent) + padding * 2);
  canvas.width = width;
  canvas.height = height;
  context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) {
    throw new Error("Canvas 2D context is unavailable after resize");
  }
  context.clearRect(0, 0, width, height);
  context.font = canvasFont(request);
  context.textBaseline = "alphabetic";
  context.fillStyle = "white";
  context.fillText(request.glyphText, padding + left, padding + ascent);
  const image = context.getImageData(0, 0, width, height);
  const pixels = new Uint8Array(width * height);
  for (let index = 0; index < pixels.length; index += 1) {
    pixels[index] = image.data[index * 4 + 3] ?? 0;
  }
  return {
    width,
    height,
    pixels,
    bearingX: -left,
    bearingY: ascent,
    advance: measurement.width,
  };
}

async function bakeCharset(input: {
  readonly family: string;
  readonly charset: string;
  readonly physicalSize: number;
  readonly fontWeight: TextStyleFontWeight;
  readonly rasterize: (
    request: CharsetSdfPaintRequest,
  ) => CharsetSdfPaint | Promise<CharsetSdfPaint>;
}): Promise<BakedCharset> {
  const fields: Array<{
    readonly glyphText: string;
    readonly width: number;
    readonly height: number;
    readonly pixels: Uint8Array;
    readonly bearingX: number;
    readonly bearingY: number;
    readonly advance: number;
  }> = [];
  for (const glyphText of input.charset) {
    const paint = await input.rasterize({
      family: input.family,
      glyphText,
      fontSize: input.physicalSize,
      fontWeight: input.fontWeight,
    });
    if (paint.pixels.length !== paint.width * paint.height) {
      throw new TypeError("charset paint length differs from width * height");
    }
    const field = encodeTinySdf(paint.pixels, paint.width, paint.height, TINY_SDF_RADIUS);
    if (field.every((value) => value === 0)) continue;
    fields.push({
      glyphText,
      width: paint.width,
      height: paint.height,
      pixels: field,
      bearingX: paint.bearingX,
      bearingY: paint.bearingY,
      advance: paint.advance,
    });
  }
  return packFields(input.family, input.physicalSize, fields);
}

function packFields(
  family: string,
  physicalSize: number,
  fields: readonly {
    readonly glyphText: string;
    readonly width: number;
    readonly height: number;
    readonly pixels: Uint8Array;
    readonly bearingX: number;
    readonly bearingY: number;
    readonly advance: number;
  }[],
): BakedCharset {
  const pages: Array<{
    id: string;
    width: number;
    height: number;
    pixels: Uint8Array;
  }> = [];
  const glyphs: BakedCharsetGlyph[] = [];
  let pageIndex = 0;
  let cursorX = 0;
  let cursorY = 0;
  let shelfHeight = 0;
  let pageHeight = 0;
  let pixels = new Uint8Array(0);

  const openPage = (): void => {
    const id = `charset-sdf-${family}-${String(physicalSize)}-${String(pageIndex)}`;
    pageHeight = 0;
    cursorX = 0;
    cursorY = 0;
    shelfHeight = 0;
    pixels = new Uint8Array(0);
    pages.push({ id, width: PAGE_WIDTH, height: 0, pixels });
  };

  const growPage = (height: number): void => {
    const page = pages[pageIndex];
    if (page === undefined) return;
    if (height <= pageHeight) return;
    const next = new Uint8Array(PAGE_WIDTH * height);
    next.set(pixels);
    pixels = next;
    page.pixels = next;
    page.height = height;
    pageHeight = height;
  };

  if (fields.length > 0) openPage();
  for (const field of fields) {
    if (field.width > PAGE_WIDTH) {
      throw new RangeError(`Charset glyph is wider than the prebuilt page: ${field.glyphText}`);
    }
    if (cursorX + field.width > PAGE_WIDTH) {
      cursorX = 0;
      cursorY += shelfHeight;
      shelfHeight = 0;
    }
    if (pages[pageIndex] !== undefined && cursorY + field.height > 4096) {
      pageIndex += 1;
      openPage();
    }
    growPage(cursorY + field.height);
    blit(pixels, field.pixels, field.width, field.height, cursorX, cursorY, PAGE_WIDTH);
    const page = pages[pageIndex];
    if (page === undefined) throw new Error("Charset prebuilt page list is incomplete");
    glyphs.push({
      glyphText: field.glyphText,
      pageId: page.id,
      x: cursorX,
      y: cursorY,
      width: field.width,
      height: field.height,
      bearingX: field.bearingX,
      bearingY: field.bearingY,
      advance: field.advance,
    });
    cursorX += field.width;
    shelfHeight = Math.max(shelfHeight, field.height);
  }

  return { pages: pages.map((page) => ({ ...page, mode: "sdf" as const })), glyphs };
}

function blit(
  page: Uint8Array,
  cell: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  pageWidth: number,
): void {
  for (let row = 0; row < height; row += 1) {
    page.set(cell.subarray(row * width, row * width + width), (y + row) * pageWidth + x);
  }
}

function scaledFieldMetrics(
  bearingX: number,
  bearingY: number,
  advance: number,
  fieldRange: number,
  rasterScale: number,
): Readonly<GlyphMetrics> {
  return Object.freeze({
    bearingX: bearingX / rasterScale,
    bearingY: bearingY / rasterScale,
    advance: advance / rasterScale,
    fieldRange: fieldRange / rasterScale,
    ...(rasterScale === 1 ? {} : { rasterScale }),
  });
}

function isEmptyInkCodePoint(codePoint: number): boolean {
  if (codePoint === 0x1680) return false;
  if (codePoint < 0x80) {
    return (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      codePoint === 0x0d ||
      codePoint === 0x20
    );
  }
  return EMPTY_INK_RE.test(String.fromCodePoint(codePoint));
}

interface CanvasLike {
  width: number;
  height: number;
  getContext(
    contextId: "2d",
    options?: CanvasRenderingContext2DSettings,
  ): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
}

function createCanvas(width: number, height: number): CanvasLike {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error("Canvas rasterization requires OffscreenCanvas or a browser document");
}

function canvasFont(request: CharsetSdfPaintRequest): string {
  return `${String(request.fontWeight)} ${String(request.fontSize)}px ${request.family}`;
}
