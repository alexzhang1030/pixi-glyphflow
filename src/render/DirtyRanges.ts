import type { DirtyByteRange } from "./types";

export interface DirtyPublishOptions {
  /** Merge two ranges when the hole between them is at most this many bytes. */
  readonly acceptedGap?: number;
  /** Collapse to first-to-last when more ranges remain after coalescing. */
  readonly maxRanges?: number;
  /** Used region of the destination buffer, in bytes. */
  readonly liveBytes?: number;
  /** Promote to `0..liveBytes` when dirty bytes reach this many basis points of live bytes. */
  readonly wholeBufferBps?: number;
}

/** Merge dirty ranges when the hole between them is at most this many bytes. From pmndrs/glyph. */
export const DIRTY_ACCEPTED_GAP = 256;
/** Collapse to first-to-last when more ranges remain after coalescing. From pmndrs/glyph. */
export const DIRTY_MAX_RANGES = 8;
/** Promote to the live span when dirty bytes are at least 75% of live bytes. From pmndrs/glyph. */
export const DIRTY_WHOLE_BUFFER_BPS = 7_500;

export class DirtyRanges {
  readonly #ranges: DirtyByteRange[] = [];

  record(offset: number, length: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError("Dirty byte offset must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new TypeError("Dirty byte length must be a positive safe integer");
    }
    if (!Number.isSafeInteger(offset + length)) {
      throw new RangeError("Dirty byte range exceeds safe integer capacity");
    }
    this.#ranges.push({ offset, length });
  }

  publish(options: DirtyPublishOptions = {}): readonly Readonly<DirtyByteRange>[] {
    if (this.#ranges.length === 0) {
      return Object.freeze([]);
    }
    this.#ranges.sort((left, right) => left.offset - right.offset);
    const acceptedGap = options.acceptedGap ?? 0;
    const published: DirtyByteRange[] = [];
    let current = this.#ranges[0];
    if (current === undefined) {
      return Object.freeze([]);
    }
    for (let index = 1; index < this.#ranges.length; index += 1) {
      const next = this.#ranges[index];
      if (next === undefined) continue;
      const currentEnd: number = current.offset + current.length;
      if (next.offset <= currentEnd + acceptedGap) {
        current = {
          offset: current.offset,
          length: Math.max(currentEnd, next.offset + next.length) - current.offset,
        };
      } else {
        published.push(Object.freeze(current));
        current = next;
      }
    }
    published.push(Object.freeze(current));
    this.#ranges.length = 0;

    const collapsed = collapseRanges(published, options.maxRanges);
    return Object.freeze(promoteWholeBuffer(collapsed, options.liveBytes, options.wholeBufferBps));
  }

  clear(): void {
    this.#ranges.length = 0;
  }

  get pendingRanges(): number {
    return this.#ranges.length;
  }
}

function collapseRanges(ranges: DirtyByteRange[], maxRanges: number | undefined): DirtyByteRange[] {
  if (maxRanges === undefined || ranges.length <= maxRanges) {
    return ranges;
  }
  const first = ranges[0];
  const last = ranges[ranges.length - 1];
  if (first === undefined || last === undefined) {
    return ranges;
  }
  return [
    Object.freeze({
      offset: first.offset,
      length: last.offset + last.length - first.offset,
    }),
  ];
}

function promoteWholeBuffer(
  ranges: DirtyByteRange[],
  liveBytes: number | undefined,
  wholeBufferBps: number | undefined,
): DirtyByteRange[] {
  if (
    liveBytes === undefined ||
    liveBytes <= 0 ||
    wholeBufferBps === undefined ||
    wholeBufferBps <= 0 ||
    ranges.length === 0
  ) {
    return ranges;
  }
  let partial = 0;
  for (const range of ranges) {
    partial += range.length;
  }
  if (partial * 10_000 < liveBytes * wholeBufferBps) {
    return ranges;
  }
  return [Object.freeze({ offset: 0, length: liveBytes })];
}
