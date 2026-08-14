import type { DirtyByteRange } from "./types";

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

  publish(): readonly Readonly<DirtyByteRange>[] {
    if (this.#ranges.length === 0) {
      return Object.freeze([]);
    }
    this.#ranges.sort((left, right) => left.offset - right.offset);
    const published: DirtyByteRange[] = [];
    let current = this.#ranges[0];
    if (current === undefined) {
      return Object.freeze([]);
    }
    for (let index = 1; index < this.#ranges.length; index += 1) {
      const next = this.#ranges[index];
      if (next === undefined) continue;
      const currentEnd: number = current.offset + current.length;
      if (next.offset <= currentEnd) {
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

    return Object.freeze(published);
  }

  clear(): void {
    this.#ranges.length = 0;
  }

  get pendingRanges(): number {
    return this.#ranges.length;
  }
}
