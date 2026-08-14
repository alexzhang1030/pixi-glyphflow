import { validateUploadRange, type RendererAdapter } from "./RendererAdapter";
import type {
  DirtyByteRange,
  UploadBatchResult,
  WebGLAdapterStats,
  WebGLUploadContext,
} from "./types";

export class WebGLAdapter implements RendererAdapter {
  readonly #gl: WebGLUploadContext;
  readonly #buffer: unknown;
  #source: ArrayBuffer | undefined;
  #allocatedBytes = 0;
  #fullUploads = 0;
  #partialUploads = 0;
  #uploadedBytes = 0;

  constructor(gl: WebGLUploadContext, buffer: unknown) {
    this.#gl = gl;
    this.#buffer = buffer;
  }

  upload(source: ArrayBuffer, ranges: readonly DirtyByteRange[]): Readonly<UploadBatchResult> {
    this.#gl.bindBuffer(this.#gl.ARRAY_BUFFER, this.#buffer);
    if (this.#source !== source || this.#allocatedBytes !== source.byteLength) {
      this.#gl.bufferData(this.#gl.ARRAY_BUFFER, new Uint8Array(source), this.#gl.DYNAMIC_DRAW);
      this.#source = source;
      this.#allocatedBytes = source.byteLength;
      this.#fullUploads += 1;
      this.#uploadedBytes += source.byteLength;
      return Object.freeze({
        uploadedBytes: source.byteLength,
        writes: 1,
        deferred: Object.freeze([]),
      });
    }

    let uploadedBytes = 0;
    let writes = 0;
    for (const range of ranges) {
      validateUploadRange(range, source.byteLength);
      this.#gl.bufferSubData(
        this.#gl.ARRAY_BUFFER,
        range.offset,
        new Uint8Array(source, range.offset, range.length),
      );
      uploadedBytes += range.length;
      writes += 1;
    }
    this.#partialUploads += writes;
    this.#uploadedBytes += uploadedBytes;

    return Object.freeze({ uploadedBytes, writes, deferred: Object.freeze([]) });
  }

  get stats(): Readonly<WebGLAdapterStats> {
    return Object.freeze({
      allocatedBytes: this.#allocatedBytes,
      fullUploads: this.#fullUploads,
      partialUploads: this.#partialUploads,
      uploadedBytes: this.#uploadedBytes,
    });
  }
}
