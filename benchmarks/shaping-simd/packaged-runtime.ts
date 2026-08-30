import type { HarfBuzzRuntime } from "../../src/shaping/types";

export type PackagedHarfBuzzVariant = "scalar" | "simd";

export interface PackagedHarfBuzzRuntimeOptions {
  readonly readWasm?: (url: URL) => Promise<Uint8Array>;
}

interface EmscriptenHarfBuzzModule {
  readonly HEAP32: Int32Array;
  readonly HEAPU8: Uint8Array;
  readonly HEAPU16: Uint16Array;
  readonly HEAPU32: Uint32Array;
  readonly HEAPF32: Float32Array;
  readonly addFunction: (
    callback: (...arguments_: number[]) => number | void,
    signature: string,
  ) => number;
  readonly removeFunction: (pointer: number) => void;
  readonly stackSave: () => number;
  readonly stackAlloc: (bytes: number) => number;
  readonly stackRestore: (pointer: number) => void;
  readonly _malloc: (bytes: number) => number;
  readonly _free: (pointer: number) => void;
  readonly _hb_blob_create: (
    data: number,
    length: number,
    mode: number,
    userData: number,
    destroy: number,
  ) => number;
  readonly _hb_blob_destroy: (blob: number) => void;
  readonly _hb_face_create: (blob: number, index: number) => number;
  readonly _hb_face_reference: (face: number) => number;
  readonly _hb_face_destroy: (face: number) => void;
  readonly _hb_face_get_upem: (face: number) => number;
  readonly _hb_font_create: (face: number) => number;
  readonly _hb_font_destroy: (font: number) => void;
  readonly _hb_font_set_scale: (font: number, xScale: number, yScale: number) => void;
  readonly _hb_font_set_variations: (font: number, variations: number, count: number) => void;
  readonly _hb_font_get_h_extents: (font: number, extents: number) => number;
  readonly _hb_font_get_glyph_extents: (font: number, glyph: number, extents: number) => number;
  readonly _hb_buffer_create: () => number;
  readonly _hb_buffer_reference: (buffer: number) => number;
  readonly _hb_buffer_destroy: (buffer: number) => void;
  readonly _hb_buffer_add_utf16: (
    buffer: number,
    text: number,
    textLength: number,
    itemOffset: number,
    itemLength: number,
  ) => void;
  readonly _hb_buffer_guess_segment_properties: (buffer: number) => void;
  readonly _hb_buffer_set_direction: (buffer: number, direction: number) => void;
  readonly _hb_buffer_set_language: (buffer: number, language: number) => void;
  readonly _hb_language_from_string: (text: number, length: number) => number;
  readonly _hb_buffer_set_script: (buffer: number, script: number) => void;
  readonly _hb_script_from_string: (text: number, length: number) => number;
  readonly _hb_buffer_get_length: (buffer: number) => number;
  readonly _hb_buffer_get_glyph_infos: (buffer: number, length: number) => number;
  readonly _hb_glyph_info_get_glyph_flags: (glyphInfo: number) => number;
  readonly _hb_buffer_get_glyph_positions: (buffer: number, length: number) => number;
  readonly _hb_buffer_clear_contents: (buffer: number) => void;
  readonly _hb_feature_from_string: (text: number, length: number, feature: number) => number;
  readonly _hb_shape: (font: number, buffer: number, features: number, count: number) => void;
}

type EmscriptenHarfBuzzFactory = (
  options: Readonly<{ readonly wasmBinary: Uint8Array }>,
) => Promise<EmscriptenHarfBuzzModule>;

interface GlyphInfo {
  readonly codepoint: number;
  readonly cluster: number;
  readonly flags: number;
}

interface GlyphPosition {
  readonly xAdvance: number;
  readonly yAdvance: number;
  readonly xOffset: number;
  readonly yOffset: number;
}

interface GlyphExtents {
  readonly xBearing: number;
  readonly yBearing: number;
  readonly width: number;
  readonly height: number;
}

interface FontExtents {
  readonly ascender: number;
  readonly descender: number;
  readonly lineGap: number;
}

interface DisposablePointer {
  readonly pointer: number;
  readonly destroy: (pointer: number) => void;
}

const Direction = Object.freeze({ INVALID: 0, LTR: 4, RTL: 5, TTB: 6, BTT: 7 });

export async function loadPackagedHarfBuzzRuntime(
  variant: PackagedHarfBuzzVariant,
  options: Readonly<PackagedHarfBuzzRuntimeOptions> = {},
): Promise<HarfBuzzRuntime> {
  const assets = assetUrls(variant);
  const [factoryModule, wasmBinary] = await Promise.all([
    import(/* @vite-ignore */ assets.glue.href) as Promise<{
      readonly default: EmscriptenHarfBuzzFactory;
    }>,
    (options.readWasm ?? fetchWasm)(assets.wasm),
  ]);
  const module = await factoryModule.default({ wasmBinary });

  return createRuntime(module);
}

function createRuntime(module: EmscriptenHarfBuzzModule): HarfBuzzRuntime {
  const finalizer = new FinalizationRegistry<DisposablePointer>(({ pointer, destroy }) => {
    destroy(pointer);
  });
  const freeFunctionPointer = module.addFunction((pointer: number) => module._free(pointer), "vi");

  class OwnedPointer {
    readonly ptr: number;
    readonly #destroyPointer: (pointer: number) => void;
    #destroyed = false;

    constructor(pointer: number, destroyPointer: (pointer: number) => void) {
      if (pointer === 0) throw new Error("HarfBuzz returned a null object");
      this.ptr = pointer;
      this.#destroyPointer = destroyPointer;
      finalizer.register(this, { pointer, destroy: destroyPointer }, this);
    }

    destroy(): void {
      if (this.#destroyed) return;
      this.#destroyed = true;
      finalizer.unregister(this);
      this.#destroyPointer(this.ptr);
    }
  }

  class Blob extends OwnedPointer {
    constructor(data: ArrayBuffer | Uint8Array) {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      const pointer = module._malloc(bytes.byteLength);
      if (pointer === 0) throw new Error("HarfBuzz font allocation failed");
      module.HEAPU8.set(bytes, pointer);
      const blob = module._hb_blob_create(
        pointer,
        bytes.byteLength,
        2,
        pointer,
        freeFunctionPointer,
      );
      if (blob === 0) {
        module._free(pointer);
        throw new Error("HarfBuzz blob creation failed");
      }
      super(blob, module._hb_blob_destroy);
    }
  }

  class Face extends OwnedPointer {
    readonly upem: number;

    constructor(blobOrPointer: Blob | number, index = 0) {
      const pointer =
        typeof blobOrPointer === "number"
          ? module._hb_face_reference(blobOrPointer)
          : module._hb_face_create(blobOrPointer.ptr, index);
      super(pointer, module._hb_face_destroy);
      this.upem = module._hb_face_get_upem(pointer);
    }
  }

  class Variation {
    readonly tag: string;
    readonly value: number;

    constructor(tag: string, value = 0) {
      this.tag = tag;
      this.value = value;
    }

    writeTo(pointer: number): void {
      module.HEAPU32[pointer >>> 2] = hbTag(this.tag);
      module.HEAPF32[(pointer >>> 2) + 1] = this.value;
    }
  }

  class Font extends OwnedPointer {
    constructor(face: Face) {
      super(module._hb_font_create(face.ptr), module._hb_font_destroy);
    }

    setScale(xScale: number, yScale: number): void {
      module._hb_font_set_scale(this.ptr, xScale, yScale);
    }

    setVariations(variations: readonly Variation[]): void {
      const stack = module.stackSave();
      try {
        const pointer = module.stackAlloc(variations.length * 8);
        for (let index = 0; index < variations.length; index += 1) {
          variations[index]?.writeTo(pointer + index * 8);
        }
        module._hb_font_set_variations(this.ptr, pointer, variations.length);
      } finally {
        module.stackRestore(stack);
      }
    }

    hExtents(): Readonly<FontExtents> {
      const stack = module.stackSave();
      try {
        const pointer = module.stackAlloc(12);
        module._hb_font_get_h_extents(this.ptr, pointer);
        const offset = pointer >>> 2;

        return Object.freeze({
          ascender: module.HEAP32[offset] ?? 0,
          descender: module.HEAP32[offset + 1] ?? 0,
          lineGap: module.HEAP32[offset + 2] ?? 0,
        });
      } finally {
        module.stackRestore(stack);
      }
    }

    glyphExtents(glyphId: number): Readonly<GlyphExtents> | undefined {
      const stack = module.stackSave();
      try {
        const pointer = module.stackAlloc(16);
        if (module._hb_font_get_glyph_extents(this.ptr, glyphId, pointer) === 0) return undefined;
        const offset = pointer >>> 2;

        return Object.freeze({
          xBearing: module.HEAP32[offset] ?? 0,
          yBearing: module.HEAP32[offset + 1] ?? 0,
          width: module.HEAP32[offset + 2] ?? 0,
          height: module.HEAP32[offset + 3] ?? 0,
        });
      } finally {
        module.stackRestore(stack);
      }
    }
  }

  class Buffer extends OwnedPointer {
    constructor(pointer?: number) {
      super(
        pointer === undefined ? module._hb_buffer_create() : module._hb_buffer_reference(pointer),
        module._hb_buffer_destroy,
      );
    }

    addText(text: string): void {
      const pointer = module._malloc(text.length * 2);
      if (pointer === 0 && text.length > 0) throw new Error("HarfBuzz text allocation failed");
      try {
        const destination = module.HEAPU16.subarray(pointer >>> 1, (pointer >>> 1) + text.length);
        for (let index = 0; index < text.length; index += 1) {
          destination[index] = text.charCodeAt(index);
        }
        module._hb_buffer_add_utf16(this.ptr, pointer, text.length, 0, text.length);
      } finally {
        module._free(pointer);
      }
    }

    guessSegmentProperties(): void {
      module._hb_buffer_guess_segment_properties(this.ptr);
    }

    setDirection(direction: number): void {
      module._hb_buffer_set_direction(this.ptr, direction);
    }

    setLanguage(language: string): void {
      withAsciiString(module, language, (pointer) => {
        module._hb_buffer_set_language(this.ptr, module._hb_language_from_string(pointer, -1));
      });
    }

    setScript(script: string): void {
      withAsciiString(module, script, (pointer) => {
        module._hb_buffer_set_script(this.ptr, module._hb_script_from_string(pointer, -1));
      });
    }

    clearContents(): void {
      module._hb_buffer_clear_contents(this.ptr);
    }

    getGlyphInfos(): readonly Readonly<GlyphInfo>[] {
      const length = module._hb_buffer_get_length(this.ptr);
      const pointer = module._hb_buffer_get_glyph_infos(this.ptr, 0);
      const offset = pointer >>> 2;
      const result: GlyphInfo[] = [];
      for (let index = 0; index < length; index += 1) {
        const word = offset + index * 5;
        result.push(
          Object.freeze({
            codepoint: module.HEAPU32[word] ?? 0,
            cluster: module.HEAPU32[word + 2] ?? 0,
            flags: module._hb_glyph_info_get_glyph_flags(pointer + index * 20),
          }),
        );
      }

      return Object.freeze(result);
    }

    getGlyphPositions(): readonly Readonly<GlyphPosition>[] {
      const length = module._hb_buffer_get_length(this.ptr);
      const pointer = module._hb_buffer_get_glyph_positions(this.ptr, 0);
      if (pointer === 0) return Object.freeze([]);
      const offset = pointer >>> 2;
      const result: GlyphPosition[] = [];
      for (let index = 0; index < length; index += 1) {
        const word = offset + index * 5;
        result.push(
          Object.freeze({
            xAdvance: module.HEAP32[word] ?? 0,
            yAdvance: module.HEAP32[word + 1] ?? 0,
            xOffset: module.HEAP32[word + 2] ?? 0,
            yOffset: module.HEAP32[word + 3] ?? 0,
          }),
        );
      }

      return Object.freeze(result);
    }
  }

  class Feature {
    readonly tag: string;
    readonly value: number;
    readonly start: number;
    readonly end: number;

    constructor(tag: string, value = 1, start = 0, end = 0xffff_ffff) {
      this.tag = tag;
      this.value = value;
      this.start = start;
      this.end = end;
    }

    static fromString(text: string): Feature | undefined {
      const stack = module.stackSave();
      try {
        const featurePointer = module.stackAlloc(16);
        return withAsciiString(module, text, (textPointer) => {
          if (module._hb_feature_from_string(textPointer, -1, featurePointer) === 0) {
            return undefined;
          }
          const offset = featurePointer >>> 2;

          return new Feature(
            hbUntag(module.HEAPU32[offset] ?? 0),
            module.HEAPU32[offset + 1] ?? 0,
            module.HEAPU32[offset + 2] ?? 0,
            module.HEAPU32[offset + 3] ?? 0,
          );
        });
      } finally {
        module.stackRestore(stack);
      }
    }

    writeTo(pointer: number): void {
      const offset = pointer >>> 2;
      module.HEAPU32[offset] = hbTag(this.tag);
      module.HEAPU32[offset + 1] = this.value;
      module.HEAPU32[offset + 2] = this.start;
      module.HEAPU32[offset + 3] = this.end;
    }
  }

  function shape(font: Font, buffer: Buffer, features: readonly Feature[] = []): void {
    const stack = module.stackSave();
    try {
      const pointer = features.length === 0 ? 0 : module.stackAlloc(features.length * 16);
      for (let index = 0; index < features.length; index += 1) {
        features[index]?.writeTo(pointer + index * 16);
      }
      module._hb_shape(font.ptr, buffer.ptr, pointer, features.length);
    } finally {
      module.stackRestore(stack);
    }
  }

  return {
    Blob,
    Face,
    Font,
    Buffer,
    Feature,
    Variation,
    Direction,
    shape,
  } as unknown as HarfBuzzRuntime;
}

function assetUrls(variant: PackagedHarfBuzzVariant): Readonly<{ glue: URL; wasm: URL }> {
  return variant === "simd"
    ? {
        glue: new URL("./wasm/simd/harfbuzz.js", import.meta.url),
        wasm: new URL("./wasm/simd/harfbuzz.wasm", import.meta.url),
      }
    : {
        glue: new URL("./wasm/scalar/harfbuzz.js", import.meta.url),
        wasm: new URL("./wasm/scalar/harfbuzz.wasm", import.meta.url),
      };
}

async function fetchWasm(url: URL): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Packaged HarfBuzz Wasm fetch failed with ${String(response.status)}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

function withAsciiString<Result>(
  module: EmscriptenHarfBuzzModule,
  value: string,
  callback: (pointer: number) => Result,
): Result {
  const pointer = module._malloc(value.length + 1);
  if (pointer === 0) throw new Error("HarfBuzz string allocation failed");
  try {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code > 0x7f) throw new TypeError("HarfBuzz tags and languages must contain ASCII text");
      module.HEAPU8[pointer + index] = code;
    }
    module.HEAPU8[pointer + value.length] = 0;

    return callback(pointer);
  } finally {
    module._free(pointer);
  }
}

function hbTag(tag: string): number {
  if (tag.length !== 4) throw new TypeError("HarfBuzz tags must contain four characters");

  return (
    (((tag.charCodeAt(0) & 0xff) << 24) |
      ((tag.charCodeAt(1) & 0xff) << 16) |
      ((tag.charCodeAt(2) & 0xff) << 8) |
      (tag.charCodeAt(3) & 0xff)) >>>
    0
  );
}

function hbUntag(tag: number): string {
  return String.fromCharCode(
    (tag >>> 24) & 0xff,
    (tag >>> 16) & 0xff,
    (tag >>> 8) & 0xff,
    tag & 0xff,
  );
}
