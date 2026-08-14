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
    const family = this.#resolveFamily(input.style.fontFamily);
    const registered = this.#registry.get(family);
    this.#layouts += 1;

    if (registered?.kind === "binary") {
      this.#harfbuzzLayouts += 1;
      const shapeInput: HarfBuzzShapeInput = {
        family,
        text: input.text,
        fontSize: resolveFontSize(input.style.fontSize),
        direction,
        ...(input.language === undefined ? {} : { language: input.language }),
        ...(input.script === undefined ? {} : { script: input.script }),
        ...(input.features === undefined ? {} : { features: input.features }),
        ...(input.variations === undefined ? {} : { variations: input.variations }),
      };

      return this.#harfbuzz.shape(labelId, sourceRevision, shapeInput);
    }

    this.#bitmapLayouts += 1;
    return this.#bitmap.layout({
      text: input.text,
      style: input.style,
      fontRevision: registered?.revision ?? 0,
      direction,
      trimEnd: input.trimEnd ?? true,
      ...(input.maxLines === undefined ? {} : { maxLines: input.maxLines }),
      ...(input.ellipsis === undefined ? {} : { ellipsis: input.ellipsis }),
    });
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
    this.#destroyed = true;
  }

  #resolveFamily(value: string | string[] | undefined): string {
    const requested = Array.isArray(value) ? value : [value ?? "Arial"];
    for (const name of requested) {
      const fallback = this.#registry.getFallback(name);
      if (fallback !== undefined) {
        for (const family of fallback) {
          if (this.#registry.get(family) !== undefined) {
            return family;
          }
        }
        return fallback[0] ?? name;
      }
      if (this.#registry.get(name) !== undefined) {
        return name;
      }
    }

    return requested[0] ?? "Arial";
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("LayoutEngine has been destroyed");
    }
  }
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
