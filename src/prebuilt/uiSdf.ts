import type { TextStyleFontWeight } from "pixi.js";

import { prebuiltGlyphKey } from "../atlas/PrebuiltGlyphProvider";
import { encodeTinySdf, TINY_SDF_RADIUS } from "../atlas/tinySdf";
import type { GlyphMetrics, PrebuiltGlyphPage, PrebuiltGlyphProviderOptions } from "../atlas/types";
import { LATIN_8X8, LATIN_8X8_COUNT, LATIN_8X8_FIRST } from "./latin8x8";

export const UI_SDF_FONT_SIZE: number = 16;
export const UI_SDF_FAMILY: string = "glyphflow-ui";

const BITMAP_SIZE = 8;
const INK_SCALE = 2;
const INK_SIZE = BITMAP_SIZE * INK_SCALE;
const CELL_SIZE = INK_SIZE + TINY_SDF_RADIUS * 2;
const PAGE_WIDTH = 512;
const CELLS_PER_ROW = PAGE_WIDTH / CELL_SIZE;
const PAGE_HEIGHT = Math.ceil(LATIN_8X8_COUNT / CELLS_PER_ROW) * CELL_SIZE;
const PAGE_ID = "glyphflow-ui-sdf-16";

export interface UiSdfPrebuiltOptions {
  readonly family: string;
  readonly fontSize?: number;
  readonly fontWeight?: TextStyleFontWeight;
}

interface BakedUiSdf {
  readonly pages: readonly PrebuiltGlyphPage[];
  readonly glyphs: readonly BakedUiSdfGlyph[];
}

interface BakedUiSdfGlyph {
  readonly glyphText: string;
  readonly pageId: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly metrics: Readonly<GlyphMetrics>;
}

const UI_SDF_METRICS: Readonly<GlyphMetrics> = Object.freeze({
  bearingX: -TINY_SDF_RADIUS,
  bearingY: INK_SIZE + TINY_SDF_RADIUS,
  advance: INK_SIZE,
  fieldRange: TINY_SDF_RADIUS,
});

let baked: BakedUiSdf | undefined;

/**
 * Coarse VGA 8×8 SDF pages for printable ASCII. First call encodes; later calls remap keys. Not
 * production typography. `fontSize` must be 16 so `rasterScale` stays ≥ 1.
 */
export function uiSdfPrebuilt(options: UiSdfPrebuiltOptions): PrebuiltGlyphProviderOptions {
  if (typeof options.family !== "string" || options.family.length === 0) {
    throw new TypeError("family must be a non-empty string");
  }
  const fontSize = options.fontSize ?? UI_SDF_FONT_SIZE;
  if (fontSize !== UI_SDF_FONT_SIZE) {
    throw new TypeError(`uiSdfPrebuilt only supports fontSize ${String(UI_SDF_FONT_SIZE)}`);
  }
  const fontWeight = options.fontWeight ?? "normal";
  const pages = ensureBaked().pages;
  return {
    pages,
    glyphs: pages[0] === undefined ? [] : remapGlyphs(options.family, fontSize, fontWeight),
  };
}

function remapGlyphs(
  family: string,
  fontSize: number,
  fontWeight: TextStyleFontWeight,
): PrebuiltGlyphProviderOptions["glyphs"] {
  return ensureBaked().glyphs.map((glyph) => ({
    key: prebuiltGlyphKey({
      family,
      glyphId: 0,
      glyphText: glyph.glyphText,
      fontSize,
      fontWeight,
      mode: "sdf",
    }),
    pageId: glyph.pageId,
    x: glyph.x,
    y: glyph.y,
    width: glyph.width,
    height: glyph.height,
    metrics: glyph.metrics,
  }));
}

function ensureBaked(): BakedUiSdf {
  baked ??= bakeUiSdf();
  return baked;
}

function bakeUiSdf(): BakedUiSdf {
  const pixels = new Uint8Array(PAGE_WIDTH * PAGE_HEIGHT);
  const glyphs: BakedUiSdfGlyph[] = [];
  const cell = new Uint8Array(CELL_SIZE * CELL_SIZE);
  for (let index = 0; index < LATIN_8X8_COUNT; index += 1) {
    const column = index % CELLS_PER_ROW;
    const row = Math.trunc(index / CELLS_PER_ROW);
    const x = column * CELL_SIZE;
    const y = row * CELL_SIZE;
    cell.fill(0);
    blitInk(cell, LATIN_8X8.subarray(index * BITMAP_SIZE, index * BITMAP_SIZE + BITMAP_SIZE));
    const field = encodeTinySdf(cell, CELL_SIZE, CELL_SIZE, TINY_SDF_RADIUS);
    copyCell(pixels, field, x, y);
    glyphs.push({
      glyphText: String.fromCodePoint(LATIN_8X8_FIRST + index),
      pageId: PAGE_ID,
      x,
      y,
      width: CELL_SIZE,
      height: CELL_SIZE,
      metrics: UI_SDF_METRICS,
    });
  }
  return {
    pages: [
      {
        id: PAGE_ID,
        mode: "sdf",
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        pixels,
      },
    ],
    glyphs,
  };
}

function blitInk(cell: Uint8Array, rows: Uint8Array): void {
  for (let row = 0; row < BITMAP_SIZE; row += 1) {
    const bits = rows[row] ?? 0;
    for (let column = 0; column < BITMAP_SIZE; column += 1) {
      if ((bits & (1 << column)) === 0) continue;
      const originX = TINY_SDF_RADIUS + column * INK_SCALE;
      const originY = TINY_SDF_RADIUS + row * INK_SCALE;
      for (let dy = 0; dy < INK_SCALE; dy += 1) {
        for (let dx = 0; dx < INK_SCALE; dx += 1) {
          cell[(originY + dy) * CELL_SIZE + originX + dx] = 255;
        }
      }
    }
  }
}

function copyCell(page: Uint8Array, cell: Uint8Array, x: number, y: number): void {
  for (let row = 0; row < CELL_SIZE; row += 1) {
    page.set(
      cell.subarray(row * CELL_SIZE, row * CELL_SIZE + CELL_SIZE),
      (y + row) * PAGE_WIDTH + x,
    );
  }
}
