import type { BitmapFont } from "pixi.js";

import type {
  BinaryFontData,
  FontRegistration,
  FontRegistryOptions,
  FontRegistryStats,
  FontSource,
  RegisteredFont,
} from "./fonts/types";

interface FontRecord {
  readonly snapshot: Readonly<RegisteredFont>;
  readonly binary?: Uint8Array;
  readonly bitmap?: BitmapFont;
  readonly owned: boolean;
}

export class FontRegistry {
  readonly #fetch: typeof fetch;
  readonly #fonts = new Map<string, FontRecord>();
  readonly #fallbacks = new Map<string, readonly string[]>();
  readonly #pendingFamilies = new Set<string>();
  #revision = 0;
  #destroyed = false;

  constructor(options: FontRegistryOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async register(options: FontRegistration): Promise<Readonly<RegisteredFont>> {
    this.#assertActive();
    const family = normalizeName("Font family", options.family);
    if (this.#fonts.has(family) || this.#pendingFamilies.has(family)) {
      throw new RangeError(`Font family is already registered: ${family}`);
    }

    this.#pendingFamilies.add(family);
    try {
      const record = await this.#loadRecord(family, options.source);
      this.#assertActive();
      this.#revision += 1;
      const snapshot = Object.freeze({
        ...record.snapshot,
        revision: this.#revision,
      });
      this.#fonts.set(family, { ...record, snapshot });

      return snapshot;
    } finally {
      this.#pendingFamilies.delete(family);
    }
  }

  registerFallback(name: string, families: readonly string[]): number {
    this.#assertActive();
    const normalizedName = normalizeName("Fallback name", name);
    if (families.length === 0) {
      throw new TypeError("A fallback chain requires at least one font family");
    }
    const normalizedFamilies = families.map((family) => normalizeName("Font family", family));
    const previous = this.#fallbacks.get(normalizedName);
    if (
      previous !== undefined &&
      previous.length === normalizedFamilies.length &&
      previous.every((family, index) => family === normalizedFamilies[index])
    ) {
      return this.#revision;
    }

    this.#fallbacks.set(normalizedName, Object.freeze(normalizedFamilies));
    this.#revision += 1;

    return this.#revision;
  }

  has(family: string): boolean {
    this.#assertActive();
    return this.#fonts.has(family);
  }

  get(family: string): Readonly<RegisteredFont> | undefined {
    this.#assertActive();
    return this.#fonts.get(family)?.snapshot;
  }

  getFallback(name: string): readonly string[] | undefined {
    this.#assertActive();
    return this.#fallbacks.get(name);
  }

  unregister(family: string): boolean {
    this.#assertActive();
    const record = this.#fonts.get(family);
    if (record === undefined) {
      return false;
    }

    this.#releaseRecord(record);
    this.#fonts.delete(family);
    this.#revision += 1;

    return true;
  }

  clear(): number {
    this.#assertActive();
    const removed = this.#fonts.size + this.#fallbacks.size;
    if (removed === 0) {
      return 0;
    }

    for (const record of this.#fonts.values()) {
      this.#releaseRecord(record);
    }
    this.#fonts.clear();
    this.#fallbacks.clear();
    this.#revision += 1;

    return removed;
  }

  get stats(): Readonly<FontRegistryStats> {
    let systemFonts = 0;
    let binaryFonts = 0;
    let bitmapFonts = 0;
    let binaryBytes = 0;

    for (const record of this.#fonts.values()) {
      systemFonts += Number(record.snapshot.kind === "system");
      binaryFonts += Number(record.snapshot.kind === "binary");
      bitmapFonts += Number(record.snapshot.kind === "bitmap");
      binaryBytes += record.snapshot.bytes;
    }

    return Object.freeze({
      revision: this.#revision,
      registeredFonts: this.#fonts.size,
      systemFonts,
      binaryFonts,
      bitmapFonts,
      binaryBytes,
      fallbackChains: this.#fallbacks.size,
      pendingLoads: this.#pendingFamilies.size,
    });
  }

  /** @internal */
  getBinaryData(family: string): Uint8Array | undefined {
    this.#assertActive();
    return this.#fonts.get(family)?.binary;
  }

  /** @internal */
  getBitmapFont(family: string): BitmapFont | undefined {
    this.#assertActive();
    return this.#fonts.get(family)?.bitmap;
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }

    for (const record of this.#fonts.values()) {
      this.#releaseRecord(record);
    }
    this.#fonts.clear();
    this.#fallbacks.clear();
    this.#pendingFamilies.clear();
    this.#destroyed = true;
  }

  async #loadRecord(family: string, source: FontSource | undefined): Promise<FontRecord> {
    if (source === undefined || (isSourceDescriptor(source) && source.type === "system")) {
      return {
        snapshot: Object.freeze({ family, kind: "system", revision: 0, bytes: 0 }),
        owned: false,
      };
    }
    if (isSourceDescriptor(source) && source.type === "bitmap") {
      return {
        snapshot: Object.freeze({ family, kind: "bitmap", revision: 0, bytes: 0 }),
        bitmap: source.font,
        owned: source.owned ?? false,
      };
    }

    const input = isSourceDescriptor(source) && source.type === "binary" ? source.data : source;
    const binary = await this.#loadBinary(input as URL | string | BinaryFontData);

    return {
      snapshot: Object.freeze({
        family,
        kind: "binary",
        revision: 0,
        bytes: binary.byteLength,
      }),
      binary,
      owned: true,
    };
  }

  async #loadBinary(source: URL | string | BinaryFontData): Promise<Uint8Array> {
    let bytes: Uint8Array;
    if (source instanceof Uint8Array) {
      bytes = source.slice();
    } else if (source instanceof ArrayBuffer) {
      bytes = new Uint8Array(source.slice(0));
    } else {
      const response = await this.#fetch(source);
      if (!response.ok) {
        throw new Error(
          `Font request failed with ${String(response.status)} ${response.statusText}`,
        );
      }
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    if (bytes.byteLength === 0) {
      throw new TypeError("Binary font data must contain at least one byte");
    }

    return bytes;
  }

  #releaseRecord(record: FontRecord): void {
    if (record.owned && record.bitmap !== undefined) {
      record.bitmap.destroy();
    }
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("FontRegistry has been destroyed");
    }
  }
}

function isSourceDescriptor(
  source: FontSource,
): source is Extract<FontSource, { readonly type: string }> {
  return (
    typeof source === "object" &&
    source !== null &&
    "type" in source &&
    typeof source.type === "string"
  );
}

function normalizeName(label: string, value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  return value.trim();
}
