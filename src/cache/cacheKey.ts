const LONG_LENGTH_SENTINEL = "\uffff";

/**
 * Encode an ordered string tuple with unambiguous UTF-16 length prefixes. Common fields spend one
 * code unit on their prefix; exceptionally long fields use a sentinel.
 */
export function encodeCacheKey(parts: readonly string[]): string {
  let key = "";
  for (const part of parts) {
    const length = part.length;
    key +=
      length < 0xffff ? String.fromCharCode(length) : `${LONG_LENGTH_SENTINEL}${String(length)}:`;
    key += part;
  }
  return key;
}
