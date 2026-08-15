import { FontRegistry } from "../FontRegistry";
import { BitmapLayoutAdapter } from "../pixi/compat/bitmapLayout";
import { HarfBuzzWorkerShaper } from "../shaping/HarfBuzzWorkerShaper";
import type { HarfBuzzShapeInput } from "../shaping/types";
import type {
  LayoutEngineOptions,
  LayoutEngineStats,
  PositionedRun,
  PositionedRunShaper,
  TextDirection,
  TextLayoutInput,
} from "./types";

export class LayoutEngine {
  readonly #registry: FontRegistry;
  readonly #bitmap: NonNullable<LayoutEngineOptions["bitmapAdapter"]>;
  readonly #harfbuzz: PositionedRunShaper;
  readonly #ownsHarfBuzz: boolean;
  readonly #shapeCache = new Map<string, Promise<Readonly<PositionedRun>>>();
  #layouts = 0;
  #bitmapLayouts = 0;
  #harfbuzzLayouts = 0;
  #destroyed = false;

  constructor(registry: FontRegistry, options: LayoutEngineOptions = {}) {
    this.#registry = registry;
    this.#bitmap = options.bitmapAdapter ?? new BitmapLayoutAdapter();
    this.#harfbuzz = options.harfbuzzShaper ?? new HarfBuzzWorkerShaper(registry);
    this.#ownsHarfBuzz = options.harfbuzzShaper === undefined;
  }

  async layout(
    labelId: number,
    sourceRevision: number,
    input: TextLayoutInput,
  ): Promise<Readonly<PositionedRun>> {
    this.#assertActive();
    assertIdentity("labelId", labelId);
    assertIdentity("sourceRevision", sourceRevision);
    assertInput(input);
    const direction = input.direction ?? detectDirection(input.text);
    const families = this.#resolveFamilies(input.style.fontFamily);
    this.#layouts += 1;
    let missingRun: Readonly<PositionedRun> | undefined;

    for (let index = 0; index < families.length; index += 1) {
      const family = families[index];
      if (family === undefined) continue;
      const registered = this.#registry.get(family);
      if (registered?.kind === "binary") {
        const shapeInput: HarfBuzzShapeInput = {
          family,
          text: input.text,
          fontSize: resolveFontSize(input.style.fontSize),
          fontRevision: registered.revision,
          direction,
          ...(input.language === undefined ? {} : { language: input.language }),
          ...(input.script === undefined ? {} : { script: input.script }),
          ...(input.features === undefined ? {} : { features: input.features }),
          ...(input.variations === undefined ? {} : { variations: input.variations }),
        };
        const run = await this.#shape(labelId, sourceRevision, shapeInput);
        if (hasCompleteGlyphCoverage(run)) return run;
        missingRun ??= run;
        continue;
      }

      const bitmapFamilies = families
        .slice(index)
        .filter((candidate) => this.#registry.get(candidate)?.kind !== "binary");
      const primary = bitmapFamilies[0] ?? family;
      const primaryFont = this.#registry.get(primary);
      this.#bitmapLayouts += 1;
      return this.#bitmap.layout({
        text: input.text,
        style: { ...input.style, fontFamily: bitmapFamilies },
        fontRevision: primaryFont?.revision ?? 0,
        cacheRevision: this.#registry.stats.revision,
        direction,
        trimEnd: input.trimEnd ?? true,
        ...(input.maxLines === undefined ? {} : { maxLines: input.maxLines }),
        ...(input.ellipsis === undefined ? {} : { ellipsis: input.ellipsis }),
      });
    }

    if (missingRun !== undefined) return missingRun;
    throw new Error("Font fallback resolution produced no layout candidate");
  }

  get stats(): Readonly<LayoutEngineStats> {
    return Object.freeze({
      layouts: this.#layouts,
      bitmapLayouts: this.#bitmapLayouts,
      harfbuzzLayouts: this.#harfbuzzLayouts,
    });
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    if (this.#ownsHarfBuzz) {
      this.#harfbuzz.destroy?.();
    }
    this.#shapeCache.clear();
    this.#destroyed = true;
  }

  #shape(
    labelId: number,
    sourceRevision: number,
    input: HarfBuzzShapeInput,
  ): Promise<Readonly<PositionedRun>> {
    const key = shapeCacheKey(input);
    const cached = this.#shapeCache.get(key);
    if (cached !== undefined) {
      this.#shapeCache.delete(key);
      this.#shapeCache.set(key, cached);
      return cached;
    }

    this.#harfbuzzLayouts += 1;
    const pending = this.#harfbuzz.shape(labelId, sourceRevision, input);
    this.#shapeCache.set(key, pending);
    void pending.catch(() => {
      if (this.#shapeCache.get(key) === pending) this.#shapeCache.delete(key);
    });
    while (this.#shapeCache.size > 1_000) {
      const oldest = this.#shapeCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#shapeCache.delete(oldest);
    }
    return pending;
  }

  #resolveFamilies(value: string | string[] | undefined): readonly string[] {
    const requested = Array.isArray(value) ? value : [value ?? "Arial"];
    const resolved: string[] = [];
    const seen = new Set<string>();
    const active = new Set<string>();
    const append = (name: string): void => {
      if (active.has(name)) return;
      const fallback = this.#registry.getFallback(name);
      if (fallback !== undefined) {
        active.add(name);
        for (const family of fallback) append(family);
        active.delete(name);
        return;
      }
      if (seen.has(name)) return;
      seen.add(name);
      resolved.push(name);
    };
    for (const name of requested) {
      append(name);
    }

    return Object.freeze(resolved.length > 0 ? resolved : [requested[0] ?? "Arial"]);
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("LayoutEngine has been destroyed");
    }
  }
}

function hasCompleteGlyphCoverage(run: Readonly<PositionedRun>): boolean {
  return run.glyphCount === 0 || !run.glyphIds.includes(0);
}

function shapeCacheKey(input: HarfBuzzShapeInput): string {
  const variations = Object.entries(input.variations ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([axis, value]) => `${axis}=${String(value)}`)
    .join(",");
  return [
    input.family,
    input.fontRevision ?? 0,
    input.fontSize,
    input.direction ?? "",
    input.language ?? "",
    input.script ?? "",
    input.features?.join(",") ?? "",
    variations,
    input.text,
  ].join("\u0000");
}

function assertIdentity(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertInput(input: TextLayoutInput): void {
  if (typeof input.text !== "string") {
    throw new TypeError("Layout text must be a string");
  }
  if (typeof input.style !== "object" || input.style === null) {
    throw new TypeError("Layout style must be an object");
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

function resolveFontSize(value: number | string | undefined): number {
  const resolved = typeof value === "number" ? value : Number.parseFloat(value ?? "26");
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TypeError("fontSize must resolve to a positive finite number");
  }

  return resolved;
}

function detectDirection(text: string): TextDirection {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint >= 0x0590 && codePoint <= 0x08ff) ||
      (codePoint >= 0xfb1d && codePoint <= 0xfdff) ||
      (codePoint >= 0xfe70 && codePoint <= 0xfeff)
    ) {
      return "rtl";
    }
    if (
      (codePoint >= 0x0041 && codePoint <= 0x005a) ||
      (codePoint >= 0x0061 && codePoint <= 0x007a) ||
      (codePoint >= 0x00c0 && codePoint <= 0x02af)
    ) {
      return "ltr";
    }
  }

  return "ltr";
}
