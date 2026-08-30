import type { ShapeResultResponse } from "../../src/worker/SabShapeTransport";

const encoder = new TextEncoder();

export function hashShapeResult(result: Readonly<ShapeResultResponse>): string {
  let hash = 0x811c_9dc5;
  hash = hashString(hash, result.type);
  hash = hashNumber(hash, result.requestId);
  hash = hashNumber(hash, result.labelId);
  hash = hashNumber(hash, result.sourceRevision);
  hash = hashNumber(hash, result.fontRevision);
  hash = hashString(hash, result.run.source);
  hash = hashString(hash, result.run.text);
  hash = hashString(hash, result.run.fontFamily);
  hash = hashString(hash, result.run.variationKey ?? "");
  hash = hashNumber(hash, result.run.fontRevision);
  hash = hashNumber(hash, result.run.glyphCount);
  hash = hashString(hash, result.run.direction);
  hash = hashView(hash, result.run.glyphIds);
  hash = hashView(hash, result.run.clusters);
  if (result.run.clusterEnds !== undefined) hash = hashView(hash, result.run.clusterEnds);
  hash = hashView(hash, result.run.x);
  hash = hashView(hash, result.run.y);
  hash = hashView(hash, result.run.xAdvance);
  hash = hashView(hash, result.run.yAdvance);
  hash = hashView(hash, result.run.lineIndices);
  for (const glyphKey of result.run.glyphKeys ?? []) hash = hashString(hash, glyphKey);
  hash = hashNumber(hash, result.run.bounds.x);
  hash = hashNumber(hash, result.run.bounds.y);
  hash = hashNumber(hash, result.run.bounds.width);
  hash = hashNumber(hash, result.run.bounds.height);

  return hash.toString(16).padStart(8, "0");
}

function hashView(hash: number, view: Uint32Array | Float32Array): number {
  return hashBytes(hash, new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
}

function hashNumber(hash: number, value: number): number {
  const buffer = new ArrayBuffer(Float64Array.BYTES_PER_ELEMENT);
  new DataView(buffer).setFloat64(0, value, true);
  return hashBytes(hash, new Uint8Array(buffer));
}

function hashString(hash: number, value: string): number {
  return hashBytes(hash, encoder.encode(value));
}

function hashBytes(initial: number, bytes: Uint8Array): number {
  let hash = initial;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash;
}
