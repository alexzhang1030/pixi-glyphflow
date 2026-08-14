import { BitmapFontManager, TextStyle } from "pixi.js";

import type {
  BitmapLayoutAdapterOptions,
  BitmapLayoutInput,
  BitmapLayoutManager,
  LayoutCacheStats,
  PositionedRun,
} from "../../layout/types";

export class BitmapLayoutAdapter {
  readonly #manager: BitmapLayoutManager;
  readonly #cacheSize: number;
  readonly #cache = new Map<string, Readonly<PositionedRun>>();
  readonly #styleIds = new WeakMap<object, number>();
  #nextStyleId = 1;
  #hits = 0;
  #misses = 0;

  constructor(
    manager: BitmapLayoutManager = BitmapFontManager,
    options: BitmapLayoutAdapterOptions = {},
  ) {
    this.#manager = manager;
    this.#cacheSize = options.cacheSize ?? 1_000;
    if (!Number.isSafeInteger(this.#cacheSize) || this.#cacheSize <= 0) {
      throw new TypeError("cacheSize must be a positive safe integer");
    }
  }

  layout(input: BitmapLayoutInput): Readonly<PositionedRun> {
    assertInput(input);
    const textStyle = new TextStyle(input.style);
    const fontRevision = input.fontRevision ?? 0;
    const direction = input.direction ?? "ltr";
    const trimEnd = input.trimEnd ?? true;
    const styleKey = this.#styleKey(input.style, textStyle.styleKey);
    const key = `${input.text}\u0000${styleKey}\u0000${String(fontRevision)}\u0000${direction}\u0000${String(trimEnd)}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#hits += 1;
      return cached;
    }

    this.#misses += 1;
    const font = this.#manager.getFont(input.text, textStyle);
    const layout = this.#manager.getLayout(input.text, textStyle, trimEnd);
    const glyphCount = layout.lines.reduce((total, line) => total + line.chars.length, 0);
    const glyphIds = new Uint32Array(glyphCount);
    const clusters = new Uint32Array(glyphCount);
    const x = new Float32Array(glyphCount);
    const y = new Float32Array(glyphCount);
    const xAdvance = new Float32Array(glyphCount);
    const yAdvance = new Float32Array(glyphCount);
    const lineIndices = new Uint32Array(glyphCount);
    const glyphKeys: string[] = [];
    const lineHeight =
      typeof input.style.lineHeight === "number" && input.style.lineHeight > 0
        ? input.style.lineHeight
        : font.lineHeight * layout.scale;
    let glyphIndex = 0;
    let clusterCursor = 0;

    for (let lineIndex = 0; lineIndex < layout.lines.length; lineIndex += 1) {
      const line = layout.lines[lineIndex];
      if (line === undefined) {
        throw new Error(`Bitmap layout line missing at index ${String(lineIndex)}`);
      }

      for (let charIndex = 0; charIndex < line.chars.length; charIndex += 1) {
        const glyphKey = line.chars[charIndex];
        const position = line.charPositions[charIndex];
        if (glyphKey === undefined || position === undefined) {
          throw new Error(
            `Bitmap layout glyph data missing at line ${String(lineIndex)}, index ${String(charIndex)}`,
          );
        }
        const nextPosition = line.charPositions[charIndex + 1] ?? line.width;
        const cluster = input.text.indexOf(glyphKey, clusterCursor);
        const resolvedCluster = cluster >= 0 ? cluster : clusterCursor;

        glyphIds[glyphIndex] = font.chars[glyphKey]?.id ?? glyphKey.codePointAt(0) ?? 0;
        clusters[glyphIndex] = resolvedCluster;
        x[glyphIndex] = position * layout.scale;
        y[glyphIndex] = layout.offsetY + lineIndex * lineHeight;
        xAdvance[glyphIndex] = (nextPosition - position) * layout.scale;
        yAdvance[glyphIndex] = 0;
        lineIndices[glyphIndex] = lineIndex;
        glyphKeys.push(glyphKey);
        clusterCursor = resolvedCluster + glyphKey.length;
        glyphIndex += 1;
      }
    }

    const run = Object.freeze({
      source: "bitmap" as const,
      text: input.text,
      fontFamily: resolveFontFamily(input.style.fontFamily),
      fontRevision,
      glyphCount,
      direction,
      glyphIds,
      clusters,
      x,
      y,
      xAdvance,
      yAdvance,
      lineIndices,
      glyphKeys: Object.freeze(glyphKeys),
      bounds: Object.freeze({
        x: 0,
        y: 0,
        width: layout.width,
        height: layout.height,
      }),
    });

    this.#cache.set(key, run);
    if (this.#cache.size > this.#cacheSize) {
      const oldest = this.#cache.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.#cache.delete(oldest);
      }
    }

    return run;
  }

  get stats(): Readonly<LayoutCacheStats> {
    return Object.freeze({
      entries: this.#cache.size,
      hits: this.#hits,
      misses: this.#misses,
    });
  }

  clear(): number {
    const entries = this.#cache.size;
    this.#cache.clear();

    return entries;
  }

  #styleKey(style: object, fallback: string): string {
    try {
      return stableStringify(style);
    } catch {
      const existing = this.#styleIds.get(style);
      if (existing !== undefined) {
        return `${fallback}:${String(existing)}`;
      }
      const id = this.#nextStyleId;
      this.#nextStyleId += 1;
      this.#styleIds.set(style, id);

      return `${fallback}:${String(id)}`;
    }
  }
}

function assertInput(input: BitmapLayoutInput): void {
  if (typeof input.text !== "string") {
    throw new TypeError("Layout text must be a string");
  }
  const revision = input.fontRevision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError("fontRevision must be a non-negative safe integer");
  }
  if (input.direction !== undefined && input.direction !== "ltr" && input.direction !== "rtl") {
    throw new TypeError("direction must be ltr or rtl");
  }
}

function resolveFontFamily(fontFamily: string | string[] | undefined): string {
  if (Array.isArray(fontFamily)) {
    return fontFamily[0] ?? "sans-serif";
  }

  return fontFamily ?? "sans-serif";
}

function stableStringify(value: object): string {
  return JSON.stringify(value, (_key, candidate: unknown) => {
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      !Array.isArray(candidate) &&
      Object.getPrototypeOf(candidate) === Object.prototype
    ) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(candidate).sort()) {
        sorted[key] = (candidate as Record<string, unknown>)[key];
      }
      return sorted;
    }

    return candidate;
  });
}
