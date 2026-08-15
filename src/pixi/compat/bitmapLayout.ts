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
    const cacheRevision = input.cacheRevision ?? fontRevision;
    const direction = input.direction ?? "ltr";
    const trimEnd = input.trimEnd ?? true;
    const maxLines = input.maxLines;
    const ellipsis = input.ellipsis ?? "…";
    const styleKey = this.#styleKey(input.style, textStyle.styleKey);
    const key = `${input.text}\u0000${styleKey}\u0000${String(fontRevision)}\u0000${String(cacheRevision)}\u0000${direction}\u0000${String(trimEnd)}\u0000${String(maxLines)}\u0000${ellipsis}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#hits += 1;
      return cached;
    }

    this.#misses += 1;
    const font = this.#manager.getFont(input.text, textStyle);
    const layout = this.#manager.getLayout(input.text, textStyle, trimEnd);
    const lines = constrainLines(
      layout.lines,
      maxLines,
      ellipsis,
      this.#manager,
      textStyle,
      trimEnd,
      layout.scale,
      input.style.wordWrapWidth,
    );
    const glyphCount = lines.reduce((total, line) => total + line.chars.length, 0);
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

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
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

    const fontFamilies = resolveFontFamilies(input.style.fontFamily);
    const run = Object.freeze({
      source: "bitmap" as const,
      text: input.text,
      fontFamily: fontFamilies[0] ?? "sans-serif",
      ...(fontFamilies.length > 1 ? { fontFamilies: Object.freeze(fontFamilies) } : {}),
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
        width: Math.max(0, ...lines.map((line) => line.width * layout.scale)),
        height: Math.min(layout.height, lines.length * lineHeight),
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
  const cacheRevision = input.cacheRevision ?? revision;
  if (!Number.isSafeInteger(cacheRevision) || cacheRevision < 0) {
    throw new TypeError("cacheRevision must be a non-negative safe integer");
  }
  if (input.direction !== undefined && input.direction !== "ltr" && input.direction !== "rtl") {
    throw new TypeError("direction must be ltr or rtl");
  }
  if (
    input.maxLines !== undefined &&
    (!Number.isSafeInteger(input.maxLines) || input.maxLines <= 0)
  ) {
    throw new TypeError("maxLines must be a positive safe integer");
  }
  if (input.ellipsis !== undefined && typeof input.ellipsis !== "string") {
    throw new TypeError("ellipsis must be a string");
  }
}

function constrainLines(
  lines: readonly import("../../layout/types").BitmapLayoutLine[],
  maxLines: number | undefined,
  ellipsis: string,
  manager: BitmapLayoutManager,
  style: TextStyle,
  trimEnd: boolean,
  scale: number,
  wrapWidth: number | undefined,
): readonly import("../../layout/types").BitmapLayoutLine[] {
  if (maxLines === undefined || lines.length <= maxLines) {
    return lines;
  }

  const constrained = lines.slice(0, maxLines);
  if (ellipsis.length === 0) {
    return constrained;
  }
  const last = constrained.at(-1);
  if (last === undefined) {
    return constrained;
  }

  const ellipsisLayout = manager.getLayout(ellipsis, style, trimEnd);
  const ellipsisLine = ellipsisLayout.lines[0];
  if (ellipsisLine === undefined || ellipsisLine.chars.length === 0) {
    return constrained;
  }
  const targetWidth =
    wrapWidth !== undefined && Number.isFinite(wrapWidth) && wrapWidth > 0
      ? wrapWidth / scale
      : last.width;
  const chars = [...last.chars];
  const charPositions = [...last.charPositions];
  let keptWidth = last.width;
  while (chars.length > 0 && keptWidth + ellipsisLine.width > targetWidth) {
    chars.pop();
    const removedPosition = charPositions.pop();
    keptWidth = removedPosition ?? 0;
  }
  for (let index = 0; index < ellipsisLine.chars.length; index += 1) {
    const character = ellipsisLine.chars[index];
    const position = ellipsisLine.charPositions[index];
    if (character !== undefined && position !== undefined) {
      chars.push(character);
      charPositions.push(keptWidth + position);
    }
  }

  constrained[constrained.length - 1] = {
    width: Math.min(targetWidth, keptWidth + ellipsisLine.width),
    chars,
    charPositions,
  };

  return constrained;
}

function resolveFontFamilies(fontFamily: string | string[] | undefined): string[] {
  return Array.isArray(fontFamily) ? [...fontFamily] : [fontFamily ?? "sans-serif"];
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
