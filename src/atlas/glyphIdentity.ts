import type { TextStyleFontWeight } from "pixi.js";

import { encodeCacheKey } from "../cache/cacheKey";
import type { GlyphCacheKey, GlyphMode } from "./types";

const FAMILY_BITS = 12;
const GLYPH_BITS = 16;
const SIZE_BITS = 10;
const WEIGHT_BITS = 4;
const MODE_BITS = 2;
const REVISION_BITS = 8;

const FAMILY_MASK = (1 << FAMILY_BITS) - 1;
const GLYPH_MASK = (1 << GLYPH_BITS) - 1;
const SIZE_MASK = (1 << SIZE_BITS) - 1;
const WEIGHT_MASK = (1 << WEIGHT_BITS) - 1;
const MODE_MASK = (1 << MODE_BITS) - 1;
const REVISION_MASK = (1 << REVISION_BITS) - 1;

const GLYPH_SHIFT = FAMILY_BITS;
const SIZE_SHIFT = GLYPH_SHIFT + GLYPH_BITS;
const WEIGHT_SHIFT = SIZE_SHIFT + SIZE_BITS;
const MODE_SHIFT = WEIGHT_SHIFT + WEIGHT_BITS;
const REVISION_SHIFT = MODE_SHIFT + MODE_BITS;

const GLYPH_PLACE = 2 ** GLYPH_SHIFT;
const SIZE_PLACE = 2 ** SIZE_SHIFT;
const WEIGHT_PLACE = 2 ** WEIGHT_SHIFT;
const MODE_PLACE = 2 ** MODE_SHIFT;
const REVISION_PLACE = 2 ** REVISION_SHIFT;

const MAX_FAMILY_ID = FAMILY_MASK;
const MAX_GLYPH_ID = GLYPH_MASK;
const MAX_SIZE = SIZE_MASK;
const MAX_REVISION = REVISION_MASK;

const MODE_CODES = {
  msdf: 0,
  sdf: 1,
  alpha: 2,
  color: 3,
} as const satisfies Record<GlyphMode, number>;

const MODE_FROM_CODE = ["msdf", "sdf", "alpha", "color"] as const;

const familyIds = new Map<string, number>();
let nextFamilyId = 1;

export interface GlyphIdentityInput {
  readonly fontFamily: string;
  readonly fontFamilies?: readonly string[];
  readonly fontRevision: number;
  readonly glyphId: number;
  readonly glyphText: string;
  /** Canonical OpenType variation-axis identity from the positioned run. */
  readonly variationKey?: string;
  readonly fontSize: number;
  readonly fontWeight?: TextStyleFontWeight;
  readonly mode: GlyphMode;
}

export interface ResolvedGlyphIdentity {
  readonly key: GlyphCacheKey;
  readonly fontSize: number;
  readonly fontWeight: TextStyleFontWeight;
}

export interface UnpackedGlyphIdentity {
  readonly familyId: number;
  readonly glyphId: number;
  readonly fontSize: number;
  readonly fontWeight: number;
  readonly mode: GlyphMode;
  readonly fontRevision: number;
}

/**
 * Intern a CSS family stack to a 12-bit id. Returns `undefined` when the table is full so the
 * caller can fall back to a diagnostic string key.
 */
export function internGlyphFamily(
  fontFamily: string,
  fontFamilies?: readonly string[],
): number | undefined {
  const token = encodeCacheKey([fontFamily, encodeCacheKey(fontFamilies ?? [])]);
  const existing = familyIds.get(token);
  if (existing !== undefined) return existing;
  if (nextFamilyId > MAX_FAMILY_ID) return undefined;
  const id = nextFamilyId;
  nextFamilyId += 1;
  familyIds.set(token, id);
  return id;
}

/**
 * Pack the live-path atlas key as a 52-bit integer: family, glyph id, size bucket, weight class,
 * mode, and font revision. A font-local glyph id supplies the outline identity on this path.
 */
export function resolveGlyphIdentity(input: GlyphIdentityInput): ResolvedGlyphIdentity {
  const packed = packGlyphIdentity(input);
  if (packed !== undefined) return packed;
  const fontWeight = input.fontWeight ?? "normal";
  return {
    key: encodeCacheKey([
      input.fontFamily,
      encodeCacheKey(input.fontFamilies ?? []),
      String(input.fontRevision),
      String(input.glyphId),
      input.glyphText,
      input.variationKey ?? "",
      String(input.fontSize),
      String(fontWeight),
      input.mode,
    ]),
    fontSize: input.fontSize,
    fontWeight,
  };
}

export function packGlyphIdentity(input: GlyphIdentityInput): ResolvedGlyphIdentity | undefined {
  if ((input.variationKey ?? "").length > 0) return undefined;
  const familyId = internGlyphFamily(input.fontFamily, input.fontFamilies);
  const glyphId = identityCode(input.glyphId, input.glyphText);
  const fontSize = sizeBucket(input.fontSize);
  const weightClass = weightClassCode(input.fontWeight);
  const mode = MODE_CODES[input.mode];
  if (
    familyId === undefined ||
    glyphId === undefined ||
    fontSize === undefined ||
    weightClass === undefined ||
    mode === undefined ||
    !Number.isSafeInteger(input.fontRevision) ||
    input.fontRevision < 0 ||
    input.fontRevision > MAX_REVISION
  ) {
    return undefined;
  }

  const key =
    familyId +
    glyphId * GLYPH_PLACE +
    fontSize * SIZE_PLACE +
    weightClass * WEIGHT_PLACE +
    mode * MODE_PLACE +
    input.fontRevision * REVISION_PLACE;

  return {
    key,
    fontSize,
    fontWeight: input.fontWeight ?? "normal",
  };
}

export function unpackGlyphIdentity(key: number): UnpackedGlyphIdentity {
  if (!Number.isSafeInteger(key) || key < 0) {
    throw new TypeError("Packed glyph identity must be a non-negative safe integer");
  }
  const mode = MODE_FROM_CODE[field(key, MODE_PLACE, MODE_MASK)];
  if (mode === undefined) {
    throw new RangeError("Packed glyph identity contains an unknown mode");
  }
  return {
    familyId: field(key, 1, FAMILY_MASK),
    glyphId: field(key, GLYPH_PLACE, GLYPH_MASK),
    fontSize: field(key, SIZE_PLACE, SIZE_MASK),
    fontWeight: field(key, WEIGHT_PLACE, WEIGHT_MASK) * 100,
    mode,
    fontRevision: field(key, REVISION_PLACE, REVISION_MASK),
  };
}

function field(key: number, place: number, mask: number): number {
  return Math.floor(key / place) & mask;
}

function identityCode(glyphId: number, glyphText: string): number | undefined {
  if (!Number.isSafeInteger(glyphId) || glyphId < 0) return undefined;
  if (glyphId > 0) return glyphId <= MAX_GLYPH_ID ? glyphId : undefined;
  if (glyphText.length === 0) return undefined;
  const codePoint = glyphText.codePointAt(0);
  if (codePoint === undefined || codePoint > MAX_GLYPH_ID) return undefined;
  return glyphText.length === 1 ? codePoint : undefined;
}

function sizeBucket(fontSize: number): number | undefined {
  if (!Number.isFinite(fontSize) || fontSize <= 0) return undefined;
  const size = Math.round(fontSize);
  return size >= 1 && size <= MAX_SIZE ? size : undefined;
}

function weightClassCode(weight: TextStyleFontWeight | undefined): number | undefined {
  if (weight === undefined || weight === "normal") return 4;
  if (weight === "bold") return 7;
  const numeric = typeof weight === "number" ? weight : Number.parseInt(weight, 10);
  if (!Number.isInteger(numeric) || numeric < 100 || numeric > 900 || numeric % 100 !== 0) {
    return undefined;
  }
  return numeric / 100;
}
