import { encodeCacheKey } from "../cache/cacheKey";

export interface CanonicalVariations {
  /** Stable public diagnostic form carried by PositionedRun. */
  readonly variationKey: string;
  /** Unambiguous internal identity for caches and retained font resources. */
  readonly cacheKey: string;
}

const EMPTY_VARIATIONS: CanonicalVariations = Object.freeze({
  variationKey: "",
  cacheKey: "",
});

export function canonicalizeVariations(
  variations: Readonly<Record<string, number>> | undefined,
): CanonicalVariations {
  if (variations === undefined) return EMPTY_VARIATIONS;
  if (typeof variations !== "object" || variations === null || Array.isArray(variations)) {
    throw new TypeError("variations must be an axis record");
  }

  const entries = Object.entries(variations).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const diagnosticEntries: string[] = [];
  const encodedEntries: string[] = [];
  for (const [tag, value] of entries) {
    // harfbuzzjs packs four UTF-16 code units into four low-byte tag fields.
    if (tag.length !== 4 || !Number.isFinite(value)) {
      throw new TypeError(`Invalid font variation: ${tag}=${String(value)}`);
    }
    const stringValue = String(value);
    diagnosticEntries.push(`${tag}=${stringValue}`);
    encodedEntries.push(encodeCacheKey([tag, stringValue]));
  }

  return Object.freeze({
    variationKey: diagnosticEntries.join(","),
    cacheKey: encodeCacheKey(encodedEntries),
  });
}
