import type { DirtyByteRange, UploadBatchResult } from "./types";

export interface RendererAdapter {
  upload(source: ArrayBuffer, ranges: readonly DirtyByteRange[]): Readonly<UploadBatchResult>;
}

export function validateUploadRange(range: DirtyByteRange, byteLength: number): void {
  if (
    !Number.isSafeInteger(range.offset) ||
    !Number.isSafeInteger(range.length) ||
    range.offset < 0 ||
    range.length <= 0 ||
    range.offset + range.length > byteLength
  ) {
    throw new RangeError("Dirty upload range falls outside the source buffer");
  }
}
