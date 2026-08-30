import { describe, expect, test } from "bun:test";

import { hashShapeResult } from "../benchmarks/shaping-simd/hash";
import type { ShapeWorkerResponse } from "../src/worker/protocol";
import {
  SAB_SHAPE_RING_LAYOUT,
  SabShapeOverflowError,
  SabShapeTransport,
  SabShapeTransportDestroyedError,
  detectSabShapeTransportCapability,
} from "../src/worker/SabShapeTransport";

describe("SabShapeTransport", () => {
  test("gates browser use on SharedArrayBuffer and cross-origin isolation", () => {
    expect(
      detectSabShapeTransportCapability({
        SharedArrayBuffer,
        Atomics,
        crossOriginIsolated: true,
      }),
    ).toEqual({
      supported: true,
      sharedArrayBuffer: true,
      atomics: true,
      crossOriginIsolated: true,
      reason: undefined,
    });

    expect(
      detectSabShapeTransportCapability({
        SharedArrayBuffer,
        Atomics,
        crossOriginIsolated: false,
      }),
    ).toEqual({
      supported: false,
      sharedArrayBuffer: true,
      atomics: true,
      crossOriginIsolated: false,
      reason: "cross-origin-isolation",
    });
    expect(
      detectSabShapeTransportCapability({
        SharedArrayBuffer: undefined,
        Atomics,
        crossOriginIsolated: true,
      }).reason,
    ).toBe("shared-array-buffer");
    expect(
      detectSabShapeTransportCapability({
        SharedArrayBuffer,
        Atomics: undefined,
        crossOriginIsolated: true,
      }).reason,
    ).toBe("atomics");
  });

  test("shares one shape result through the fixed ring layout", () => {
    const producer = SabShapeTransport.create({ slotCount: 2, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);
    const result = shapeResult(11, [42, 17]);

    expect(SAB_SHAPE_RING_LAYOUT).toMatchObject({
      version: 2,
      headerBytes: 64,
      slotHeaderBytes: 32,
      recordHeaderBytes: 96,
      alignment: 4,
    });
    expect(producer.tryWrite(result)).toBe(true);
    const lease = consumer.tryRead();
    expect(lease?.result).toMatchObject({
      type: "shape-result",
      requestId: 11,
      labelId: 1011,
      sourceRevision: 3,
      fontRevision: 7,
      run: {
        source: "harfbuzz",
        text: "سلام",
        fontFamily: "Fixture",
        glyphCount: 2,
        direction: "rtl",
        bounds: { x: 0.1, y: -2.2, width: 20.3, height: 16.4 },
      },
    });
    expect([...lease!.result.run.glyphIds]).toEqual([42, 17]);
    expect([...lease!.result.run.clusterEnds!]).toEqual([2, 4]);
    expect(lease!.result.run.variationKey).toBe("wdth=90,wght=650");
    expect(lease!.result.run.glyphIds.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(lease!.result.run.clusterEnds!.buffer).toBeInstanceOf(SharedArrayBuffer);
    lease?.release();
    producer.destroy();
  });

  test("matches the structured-clone result hash", () => {
    const producer = SabShapeTransport.create({ slotCount: 1, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);
    const cloned = structuredClone(shapeResult(14, [8, 13, 21]));
    producer.tryWrite(cloned);
    const lease = consumer.tryRead();

    expect(hashShapeResult(lease!.result)).toBe(hashShapeResult(cloned));
    expect([...lease!.result.run.x]).toEqual([...cloned.run.x]);
    lease?.release();
    producer.destroy();
  });

  test("wraps slots only after the consumer releases each zero-copy lease", () => {
    const producer = SabShapeTransport.create({ slotCount: 2, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);

    expect(producer.tryWrite(shapeResult(1, [1]))).toBe(true);
    expect(producer.tryWrite(shapeResult(2, [2]))).toBe(true);
    expect(producer.tryWrite(shapeResult(3, [3]))).toBe(false);

    const first = consumer.tryRead();
    expect(first?.result.requestId).toBe(1);
    expect(producer.tryWrite(shapeResult(3, [3]))).toBe(false);
    first?.release();
    expect(producer.tryWrite(shapeResult(3, [3]))).toBe(true);

    const second = consumer.tryRead();
    expect(second?.result.requestId).toBe(2);
    second?.release();
    const wrapped = consumer.tryRead();
    expect(wrapped?.result.requestId).toBe(3);
    wrapped?.release();
    expect(consumer.tryRead()).toBeUndefined();
    producer.destroy();
  });

  test("claims every ready slot and reclaims only a contiguous released prefix", () => {
    const producer = SabShapeTransport.create({ slotCount: 2, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);

    expect(producer.tryWrite(shapeResult(1, [11]))).toBe(true);
    expect(producer.tryWrite(shapeResult(2, [22]))).toBe(true);
    const first = consumer.tryRead();
    const second = consumer.tryRead();

    expect(first?.result.requestId).toBe(1);
    expect(second?.result.requestId).toBe(2);
    second?.release();
    expect(producer.tryWrite(shapeResult(3, [33]))).toBe(false);
    expect([...first!.result.run.glyphIds]).toEqual([11]);

    first?.release();
    expect(producer.tryWrite(shapeResult(3, [33]))).toBe(true);
    expect(producer.tryWrite(shapeResult(4, [44]))).toBe(true);
    const third = consumer.tryRead();
    const fourth = consumer.tryRead();
    expect(third?.result.requestId).toBe(3);
    expect(fourth?.result.requestId).toBe(4);
    third?.release();
    fourth?.release();
    producer.destroy();
  });

  test("keeps a later live lease stable while an earlier slot is reused", () => {
    const producer = SabShapeTransport.create({ slotCount: 2, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);
    producer.tryWrite(shapeResult(1, [11]));
    producer.tryWrite(shapeResult(2, [22]));
    const first = consumer.tryRead();
    const second = consumer.tryRead();

    first?.release();
    expect(producer.tryWrite(shapeResult(3, [33]))).toBe(true);
    expect([...second!.result.run.glyphIds]).toEqual([22]);
    const third = consumer.tryRead();
    expect(third?.result.requestId).toBe(3);

    second?.release();
    third?.release();
    producer.destroy();
  });

  test("requires power-of-two slot counts for seamless uint32 sequence wrap", () => {
    expect(() => SabShapeTransport.create({ slotCount: 3, slotPayloadBytes: 512 })).toThrow(
      "slotCount must be a power of two",
    );
  });

  test("keeps ring order when atomic sequence counters cross the signed boundary", () => {
    const producer = SabShapeTransport.create({ slotCount: 2, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);
    const header = new Int32Array(
      producer.buffer,
      0,
      SAB_SHAPE_RING_LAYOUT.headerBytes / Int32Array.BYTES_PER_ELEMENT,
    );
    Atomics.store(header, 5, 0x7fff_fffe);
    Atomics.store(header, 6, 0x7fff_fffe);
    Atomics.store(header, 8, 0x7fff_fffe);

    producer.tryWrite(shapeResult(1, [1]));
    const beforeBoundary = consumer.tryRead();
    expect(beforeBoundary?.result.requestId).toBe(1);
    beforeBoundary?.release();
    producer.tryWrite(shapeResult(2, [2]));
    const afterBoundary = consumer.tryRead();
    expect(afterBoundary?.result.requestId).toBe(2);
    afterBoundary?.release();
    producer.destroy();
  });

  test("claims multiple leases while uint32 sequence counters wrap", () => {
    const producer = SabShapeTransport.create({ slotCount: 2, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);
    const header = new Int32Array(
      producer.buffer,
      0,
      SAB_SHAPE_RING_LAYOUT.headerBytes / Int32Array.BYTES_PER_ELEMENT,
    );
    Atomics.store(header, 5, 0xffff_fffe);
    Atomics.store(header, 6, 0xffff_fffe);
    Atomics.store(header, 8, 0xffff_fffe);

    expect(producer.tryWrite(shapeResult(1, [1]))).toBe(true);
    expect(producer.tryWrite(shapeResult(2, [2]))).toBe(true);
    const beforeWrap = consumer.tryRead();
    const atWrap = consumer.tryRead();
    expect(beforeWrap?.result.requestId).toBe(1);
    expect(atWrap?.result.requestId).toBe(2);
    atWrap?.release();
    expect(producer.tryWrite(shapeResult(3, [3]))).toBe(false);
    beforeWrap?.release();

    expect(producer.tryWrite(shapeResult(3, [3]))).toBe(true);
    expect(producer.tryWrite(shapeResult(4, [4]))).toBe(true);
    const afterWrap = consumer.tryRead();
    const afterWrapNext = consumer.tryRead();
    expect(afterWrap?.result.requestId).toBe(3);
    expect(afterWrapNext?.result.requestId).toBe(4);
    afterWrap?.release();
    afterWrapNext?.release();
    producer.destroy();
  });

  test("reports record overflow and leaves the slot writable", () => {
    const producer = SabShapeTransport.create({ slotCount: 1, slotPayloadBytes: 256 });
    const consumer = SabShapeTransport.attach(producer.buffer);

    expect(() =>
      producer.tryWrite(
        shapeResult(
          1,
          Array.from({ length: 20 }, () => 9),
        ),
      ),
    ).toThrow(SabShapeOverflowError);
    expect(producer.tryWrite(shapeResult(2, [9]))).toBe(true);
    const lease = consumer.tryRead();
    expect(lease?.result.requestId).toBe(2);
    lease?.release();
    producer.destroy();
  });

  test("rejects a record length that crosses its fixed slot", () => {
    const producer = SabShapeTransport.create({ slotCount: 1, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);
    producer.tryWrite(shapeResult(1, [1]));
    const slotHeader = new Int32Array(
      producer.buffer,
      SAB_SHAPE_RING_LAYOUT.headerBytes,
      SAB_SHAPE_RING_LAYOUT.slotHeaderBytes / 4,
    );
    Atomics.store(slotHeader, 2, producer.slotPayloadBytes + 4);

    expect(() => consumer.tryRead()).toThrow("Shared shape record byte length exceeds its slot");
    producer.destroy();
  });

  test("settles asynchronous backpressure after a lease releases", async () => {
    const producer = SabShapeTransport.create({ slotCount: 1, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);
    await producer.write(shapeResult(1, [1]));
    const blocked = producer.write(shapeResult(2, [2]));
    let settled = false;
    void blocked.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const first = await consumer.read();
    first.release();
    await blocked;
    const second = await consumer.read();
    expect(second.result.requestId).toBe(2);
    second.release();
    producer.destroy();
  });

  test("keeps asynchronous backpressure until the oldest live lease releases", async () => {
    const producer = SabShapeTransport.create({ slotCount: 2, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);
    await producer.write(shapeResult(1, [1]));
    await producer.write(shapeResult(2, [2]));
    const first = await consumer.read();
    const second = await consumer.read();
    const blocked = producer.write(shapeResult(3, [3]));
    let settled = false;
    void blocked.then(() => {
      settled = true;
    });

    second.release();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect([...first.result.run.glyphIds]).toEqual([1]);
    first.release();
    await blocked;
    const third = await consumer.read();
    expect(third.result.requestId).toBe(3);
    third.release();
    producer.destroy();
  });

  test("keeps outstanding leased views stable through destroy", () => {
    const producer = SabShapeTransport.create({ slotCount: 2, slotPayloadBytes: 512 });
    const consumer = SabShapeTransport.attach(producer.buffer);
    producer.tryWrite(shapeResult(1, [10]));
    producer.tryWrite(shapeResult(2, [20]));
    const first = consumer.tryRead();
    const second = consumer.tryRead();

    producer.destroy();
    expect([...first!.result.run.glyphIds]).toEqual([10]);
    expect([...second!.result.run.glyphIds]).toEqual([20]);
    first?.release();
    second?.release();
    first?.release();
    second?.release();
  });

  test("destroy wakes pending readers and writers", async () => {
    const readProducer = SabShapeTransport.create({ slotCount: 1, slotPayloadBytes: 512 });
    const readConsumer = SabShapeTransport.attach(readProducer.buffer);
    const pendingRead = readConsumer.read();
    readProducer.destroy();
    await expect(pendingRead).rejects.toBeInstanceOf(SabShapeTransportDestroyedError);

    const writeProducer = SabShapeTransport.create({ slotCount: 1, slotPayloadBytes: 512 });
    const writeConsumer = SabShapeTransport.attach(writeProducer.buffer);
    await writeProducer.write(shapeResult(3, [3]));
    const pendingWrite = writeProducer.write(shapeResult(4, [4]));
    writeConsumer.destroy();
    await expect(pendingWrite).rejects.toBeInstanceOf(SabShapeTransportDestroyedError);
  });
});

function shapeResult(
  requestId: number,
  glyphIds: readonly number[],
): Extract<ShapeWorkerResponse, { readonly type: "shape-result" }> {
  const glyphCount = glyphIds.length;

  return {
    type: "shape-result",
    requestId,
    labelId: requestId + 1_000,
    sourceRevision: 3,
    fontRevision: 7,
    run: {
      source: "harfbuzz",
      text: "سلام",
      fontFamily: "Fixture",
      fontRevision: 7,
      glyphCount,
      direction: "rtl",
      glyphIds: Uint32Array.from(glyphIds),
      clusters: Uint32Array.from({ length: glyphCount }, (_, index) => index * 2),
      clusterEnds: Uint32Array.from({ length: glyphCount }, (_, index) => index * 2 + 2),
      variationKey: "wdth=90,wght=650",
      x: Float32Array.from({ length: glyphCount }, (_, index) => index * 10 + 0.5),
      y: new Float32Array(glyphCount),
      xAdvance: new Float32Array(glyphCount).fill(10),
      yAdvance: new Float32Array(glyphCount),
      lineIndices: new Uint32Array(glyphCount),
      glyphKeys: glyphIds.map((glyphId) => `Fixture:${String(glyphId)}`),
      bounds: { x: 0.1, y: -2.2, width: 20.3, height: 16.4 },
    },
  };
}
