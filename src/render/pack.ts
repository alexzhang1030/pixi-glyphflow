import {
  GLYPH_DRAW_STRIDE,
  GLYPH_INSTANCE_STRIDE,
  GLYPH_PROTO_TEXELS_PER_GLYPH,
  GLYPH_PROTO_TEXTURE_WIDTH,
} from "./types";

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

export const UINTS_PER_STORE_INSTANCE = GLYPH_INSTANCE_STRIDE / Uint32Array.BYTES_PER_ELEMENT;
export const UINTS_PER_DRAW_INSTANCE = GLYPH_DRAW_STRIDE / Uint32Array.BYTES_PER_ELEMENT;
export const UINTS_PER_PROTO_GLYPH = GLYPH_PROTO_TEXELS_PER_GLYPH * 4;

/** Pack two f32 values into one uint32 as IEEE-754 binary16 pair. */
export function packHalf2x16(x: number, y: number): number {
  return (f16Bits(x) | (f16Bits(y) << 16)) >>> 0;
}

export function unpackHalf2x16(packed: number): readonly [number, number] {
  return [f16FromBits(packed & 0xffff), f16FromBits((packed >>> 16) & 0xffff)];
}

export function floatFromBits(bits: number): number {
  U32[0] = bits >>> 0;
  return F32[0] ?? 0;
}

export function bitsFromFloat(value: number): number {
  F32[0] = value;
  return U32[0] ?? 0;
}

export function packF16(value: number): number {
  return f16Bits(value);
}

/** Premultiply RGBA8 the way PixiJS does on upload, so raw sub-rect writes match a full-page update. */
export function premultiplyRgba8(
  source: Uint8Array,
  destination: Uint8Array = new Uint8Array(source.length),
): Uint8Array {
  if (source.length % 4 !== 0) {
    throw new TypeError("RGBA8 pixel buffers must have a multiple-of-4 byte length");
  }
  if (destination.length < source.length) {
    throw new RangeError("RGBA8 destination is smaller than the source");
  }
  for (let index = 0; index < source.length; index += 4) {
    const alpha = source[index + 3] ?? 0;
    destination[index] = Math.floor(((source[index] ?? 0) * alpha) / 255);
    destination[index + 1] = Math.floor(((source[index + 1] ?? 0) * alpha) / 255);
    destination[index + 2] = Math.floor(((source[index + 2] ?? 0) * alpha) / 255);
    destination[index + 3] = alpha;
  }
  return destination;
}

export function unpackF16(bits: number): number {
  return f16FromBits(bits & 0xffff);
}

function f16Bits(value: number): number {
  if (!Number.isFinite(value)) {
    return value < 0 ? 0xfc00 : 0x7c00;
  }
  F32[0] = value;
  const bits = U32[0] ?? 0;
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127;
  const fraction = bits & 0x7f_ffff;
  if (exponent > 15) return sign | 0x7c00;
  if (exponent < -14) {
    const denorm = fraction | 0x80_0000;
    const shift = -exponent - 14;
    if (shift > 23) return sign;
    return sign | (denorm >>> (shift + 13));
  }
  return sign | ((exponent + 15) << 10) | (fraction >>> 13);
}

function f16FromBits(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) {
    return sign * (fraction / 1024) * 2 ** -14;
  }
  if (exponent === 31) {
    return fraction === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  }
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/** One `rgba32float` texel. Palette rows are this many bytes wide per column. */
export const FLOAT_TEXEL_BYTES = 16;
/** WebGPU `bytesPerRow` must be a multiple of 256 when a write is taller than one row. */
export const WEBGPU_BYTES_PER_ROW_ALIGNMENT = 256;

export interface PaletteUploadRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly texel: number;
}

/**
 * Split a linear float-texture byte range into GPU rectangles. Contiguous full rows collapse into
 * one write when the row stride is 256-byte aligned, so WebGL and WebGPU share the same rects.
 * Narrow test palettes stay row-by-row.
 */
export function paletteUploadRects(
  offsetBytes: number,
  lengthBytes: number,
  textureWidth: number,
): PaletteUploadRect[] {
  let texel = offsetBytes / FLOAT_TEXEL_BYTES;
  let remaining = lengthBytes / FLOAT_TEXEL_BYTES;
  const rects: PaletteUploadRect[] = [];
  const rowBytes = textureWidth * FLOAT_TEXEL_BYTES;
  const canStackRows = rowBytes % WEBGPU_BYTES_PER_ROW_ALIGNMENT === 0;
  while (remaining > 0) {
    const x = texel % textureWidth;
    const y = Math.floor(texel / textureWidth);
    if (x === 0 && canStackRows && remaining >= textureWidth) {
      const height = Math.floor(remaining / textureWidth);
      const width = textureWidth;
      rects.push({ x, y, width, height, texel });
      texel += width * height;
      remaining -= width * height;
      continue;
    }
    const width = Math.min(remaining, textureWidth - x);
    rects.push({ x, y, width, height: 1, texel });
    texel += width;
    remaining -= width;
  }
  return rects;
}

export interface PrototypeTextureLayout {
  readonly width: number;
  readonly height: number;
}

/** Size a prototype texture so `glyphCount` glyphs fit inside `maxTextureSize`. */
export function prototypeTextureLayout(
  glyphCount: number,
  maxTextureSize = 4096,
  minWidth = GLYPH_PROTO_TEXTURE_WIDTH,
): PrototypeTextureLayout {
  const texels = Math.max(GLYPH_PROTO_TEXELS_PER_GLYPH, glyphCount * GLYPH_PROTO_TEXELS_PER_GLYPH);
  const limit = Math.max(1, maxTextureSize);
  let width = Math.min(limit, Math.max(1, minWidth));
  let height = Math.ceil(texels / width);
  while (height > limit && width < limit) {
    width = Math.min(limit, width * 2);
    height = Math.ceil(texels / width);
  }
  return { width, height: Math.max(1, height) };
}

export function allocatePrototypePixels(width: number, height: number): Float32Array {
  return new Float32Array(width * height * 4);
}

/** Copy store glyphs into RGBA32F proto texels (6 uints + 2 pad per glyph). */
export function writePrototypeGlyphs(
  pixels: Float32Array,
  store: ArrayBuffer,
  startGlyph: number,
  glyphCount: number,
): void {
  const dest = new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.length);
  const src = new Uint32Array(store);
  for (let index = 0; index < glyphCount; index += 1) {
    const glyph = startGlyph + index;
    const dst = glyph * UINTS_PER_PROTO_GLYPH;
    const srcBase = glyph * UINTS_PER_STORE_INSTANCE;
    dest[dst] = src[srcBase] ?? 0;
    dest[dst + 1] = src[srcBase + 1] ?? 0;
    dest[dst + 2] = src[srcBase + 2] ?? 0;
    dest[dst + 3] = src[srcBase + 3] ?? 0;
    dest[dst + 4] = src[srcBase + 4] ?? 0;
    dest[dst + 5] = src[srcBase + 5] ?? 0;
    dest[dst + 6] = 0;
    dest[dst + 7] = 0;
  }
}

/** Map a store byte range onto the padded prototype texel bytes. */
export function prototypeByteRange(
  storeOffset: number,
  storeLength: number,
): { readonly offset: number; readonly length: number } {
  const startGlyph = Math.floor(storeOffset / GLYPH_INSTANCE_STRIDE);
  const endGlyph = Math.ceil((storeOffset + storeLength) / GLYPH_INSTANCE_STRIDE);
  const glyphs = Math.max(0, endGlyph - startGlyph);
  return {
    offset: startGlyph * GLYPH_PROTO_TEXELS_PER_GLYPH * FLOAT_TEXEL_BYTES,
    length: glyphs * GLYPH_PROTO_TEXELS_PER_GLYPH * FLOAT_TEXEL_BYTES,
  };
}

export function writeDrawInstance(
  words: Uint32Array,
  index: number,
  protoIndex: number,
  paletteIndex: number,
): void {
  const base = index * UINTS_PER_DRAW_INSTANCE;
  words[base] = protoIndex >>> 0;
  words[base + 1] = paletteIndex >>> 0;
}
