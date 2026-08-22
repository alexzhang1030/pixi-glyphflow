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
  // Flat (offset, end) pairs: recording allocates nothing, adjacent writers merge into
  // the tail, and a storm of ascending offsets publishes without the O(n log n) sort.
  #bounds = new Float64Array(128);
  #count = 0;
  #sorted = true;

  record(offset: number, length: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError("Dirty byte offset must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new TypeError("Dirty byte length must be a positive safe integer");
    }
    const end = offset + length;
    if (!Number.isSafeInteger(end)) {
      throw new RangeError("Dirty byte range exceeds safe integer capacity");
    }
    if (this.#count > 0) {
      const tail = (this.#count - 1) * 2;
      const tailOffset = this.#bounds[tail] ?? 0;
      const tailEnd = this.#bounds[tail + 1] ?? 0;
      if (offset >= tailOffset && offset <= tailEnd) {
        if (end > tailEnd) this.#bounds[tail + 1] = end;
        return;
      }
      if (offset < tailOffset) this.#sorted = false;
    }
    if (this.#count * 2 === this.#bounds.length) {
      const next = new Float64Array(this.#bounds.length * 2);
      next.set(this.#bounds);
      this.#bounds = next;
    }
    const base = this.#count * 2;
    this.#bounds[base] = offset;
    this.#bounds[base + 1] = end;
    this.#count += 1;
  }

  publish(options: DirtyPublishOptions = {}): readonly Readonly<DirtyByteRange>[] {
    const count = this.#count;
    if (count === 0) {
      return Object.freeze([]);
    }
    if (!this.#sorted) this.#sortPairs();
    const bounds = this.#bounds;
    const acceptedGap = options.acceptedGap ?? 0;
    const published: DirtyByteRange[] = [];
    let currentOffset = bounds[0] ?? 0;
    let currentEnd = bounds[1] ?? 0;
    for (let index = 1; index < count; index += 1) {
      const nextOffset = bounds[index * 2] ?? 0;
      const nextEnd = bounds[index * 2 + 1] ?? 0;
      if (nextOffset <= currentEnd + acceptedGap) {
        if (nextEnd > currentEnd) currentEnd = nextEnd;
      } else {
        published.push(
          Object.freeze({ offset: currentOffset, length: currentEnd - currentOffset }),
        );
        currentOffset = nextOffset;
        currentEnd = nextEnd;
      }
    }
    published.push(Object.freeze({ offset: currentOffset, length: currentEnd - currentOffset }));
    this.#count = 0;
    this.#sorted = true;

    const collapsed = collapseRanges(published, options.maxRanges);
    return Object.freeze(promoteWholeBuffer(collapsed, options.liveBytes, options.wholeBufferBps));
  }

  clear(): void {
    this.#count = 0;
    this.#sorted = true;
  }

  get pendingRanges(): number {
    return this.#count;
  }

  #sortPairs(): void {
    const pairs: Array<readonly [number, number]> = [];
    for (let index = 0; index < this.#count; index += 1) {
      pairs.push([this.#bounds[index * 2] ?? 0, this.#bounds[index * 2 + 1] ?? 0]);
    }
    pairs.sort((left, right) => left[0] - right[0]);
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[index];
      if (pair === undefined) continue;
      this.#bounds[index * 2] = pair[0];
      this.#bounds[index * 2 + 1] = pair[1];
    }
    this.#sorted = true;
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
