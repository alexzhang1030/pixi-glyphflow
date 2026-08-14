import { validateUploadRange, type RendererAdapter } from "./RendererAdapter";
import type {
  DirtyByteRange,
  UploadBatchResult,
  WebGPUAdapterOptions,
  WebGPUAdapterStats,
  WebGPUBufferLike,
  WebGPUQueueLike,
} from "./types";

const DEFAULT_MAX_WRITE_BYTES = 4 * 1024 * 1024;

export class WebGPUAdapter implements RendererAdapter {
  readonly #queue: WebGPUQueueLike;
  readonly #buffer: WebGPUBufferLike;
  readonly #maxWriteBytes: number;
  #frames = 0;
  #writes = 0;
  #uploadedBytes = 0;
  #deferredBytes = 0;

  constructor(
    queue: WebGPUQueueLike,
    buffer: WebGPUBufferLike,
    options: WebGPUAdapterOptions = {},
  ) {
    this.#queue = queue;
    this.#buffer = buffer;
    this.#maxWriteBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
    if (
      !Number.isSafeInteger(this.#maxWriteBytes) ||
      this.#maxWriteBytes <= 0 ||
      this.#maxWriteBytes % 4 !== 0
    ) {
      throw new TypeError("maxWriteBytes must be a positive multiple of four");
    }
  }

  upload(source: ArrayBuffer, ranges: readonly DirtyByteRange[]): Readonly<UploadBatchResult> {
    if (source.byteLength > this.#buffer.size) {
      throw new RangeError("WebGPU target buffer is smaller than the source buffer");
    }
    this.#frames += 1;
    let budget = this.#maxWriteBytes;
    let uploadedBytes = 0;
    let writes = 0;
    const deferred: DirtyByteRange[] = [];

    for (let index = 0; index < ranges.length; index += 1) {
      const range = ranges[index];
      if (range === undefined) continue;
      validateUploadRange(range, source.byteLength);
      if (range.offset % 4 !== 0 || range.length % 4 !== 0) {
        throw new TypeError("WebGPU upload ranges must be aligned to four bytes");
      }
      if (budget === 0) {
        deferred.push({ ...range });
        continue;
      }
      const length = Math.min(range.length, budget);
      this.#queue.writeBuffer(this.#buffer, range.offset, source, range.offset, length);
      uploadedBytes += length;
      writes += 1;
      budget -= length;
      if (length < range.length) {
        deferred.push({
          offset: range.offset + length,
          length: range.length - length,
        });
      }
    }

    this.#writes += writes;
    this.#uploadedBytes += uploadedBytes;
    this.#deferredBytes = deferred.reduce((sum, range) => sum + range.length, 0);

    return Object.freeze({
      uploadedBytes,
      writes,
      deferred: Object.freeze(deferred.map((range) => Object.freeze(range))),
    });
  }

  get stats(): Readonly<WebGPUAdapterStats> {
    return Object.freeze({
      frames: this.#frames,
      writes: this.#writes,
      uploadedBytes: this.#uploadedBytes,
      deferredBytes: this.#deferredBytes,
      maxWriteBytes: this.#maxWriteBytes,
    });
  }
}
