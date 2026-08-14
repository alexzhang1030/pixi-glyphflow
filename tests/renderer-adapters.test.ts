import { describe, expect, test } from "bun:test";

import {
  GlyphInstanceStore,
  WebGLAdapter,
  WebGPUAdapter,
  type DirtyByteRange,
  type WebGLUploadContext,
  type WebGPUBufferLike,
  type WebGPUQueueLike,
} from "../src/advanced";

describe("renderer upload adapters", () => {
  test("uses a full WebGL allocation once and partial sub-data for later dirty ranges", () => {
    const store = new GlyphInstanceStore({ initialCapacity: 2 });
    store.set(1, batch(2, 1));
    const gl = new FakeWebGL();
    const adapter = new WebGLAdapter(gl, {});

    adapter.upload(store.buffer, store.consumeDirty());
    expect(gl.fullUploads).toBe(1);
    expect(gl.partialUploads).toBe(0);
    expect(gl.data).toEqual(new Uint8Array(store.buffer));

    store.set(1, batch(2, 10));
    adapter.upload(store.buffer, store.consumeDirty());
    expect(gl.fullUploads).toBe(1);
    expect(gl.partialUploads).toBe(1);
    expect(gl.data).toEqual(new Uint8Array(store.buffer));

    store.destroy();
  });

  test("splits WebGPU writes across frames under a strict byte budget", () => {
    const source = new ArrayBuffer(64);
    const bytes = new Uint8Array(source);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
    const target = new FakeWebGPUBuffer(64);
    const queue = new FakeWebGPUQueue(target);
    const adapter = new WebGPUAdapter(queue, target, { maxWriteBytes: 32 });
    const ranges: readonly DirtyByteRange[] = [{ offset: 0, length: 64 }];

    const first = adapter.upload(source, ranges);
    expect(first).toEqual({ uploadedBytes: 32, writes: 1, deferred: [{ offset: 32, length: 32 }] });
    const second = adapter.upload(source, first.deferred);
    expect(second).toEqual({ uploadedBytes: 32, writes: 1, deferred: [] });
    expect(target.data).toEqual(bytes);
  });
});

class FakeWebGL implements WebGLUploadContext {
  readonly ARRAY_BUFFER = 34_962;
  readonly DYNAMIC_DRAW = 35_048;
  data = new Uint8Array();
  fullUploads = 0;
  partialUploads = 0;

  bindBuffer(): void {}

  bufferData(_target: number, data: ArrayBufferView): void {
    this.data = new Uint8Array(data.byteLength);
    this.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    this.fullUploads += 1;
  }

  bufferSubData(_target: number, offset: number, data: ArrayBufferView): void {
    this.data.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offset);
    this.partialUploads += 1;
  }
}

class FakeWebGPUBuffer implements WebGPUBufferLike {
  readonly data: Uint8Array;
  constructor(readonly size: number) {
    this.data = new Uint8Array(size);
  }
}

class FakeWebGPUQueue implements WebGPUQueueLike {
  constructor(readonly target: FakeWebGPUBuffer) {}

  writeBuffer(
    buffer: WebGPUBufferLike,
    bufferOffset: number,
    data: ArrayBuffer,
    dataOffset: number,
    size: number,
  ): void {
    expect(buffer).toBe(this.target);
    this.target.data.set(new Uint8Array(data, dataOffset, size), bufferOffset);
  }
}

function batch(count: number, seed: number) {
  const positions = new Float32Array(count * 4).fill(seed);
  const uvs = new Float32Array(count * 4);
  const paletteIndices = new Uint32Array(count).fill(seed);
  const pages = new Uint16Array(count);
  const modes = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    uvs.set([0, 0, 1, 1], index * 4);
  }
  return { positions, uvs, paletteIndices, pages, modes };
}
