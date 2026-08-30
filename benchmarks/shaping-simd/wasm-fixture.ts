import type { ShapingBenchmarkCandidate } from "../../src/shaping/simd";

export interface ShapingWasmFixtureOptions {
  readonly corpus: Uint32Array;
  readonly simd: boolean;
}

export interface ShapingWasmFixture extends ShapingBenchmarkCandidate {
  readonly kind: "scalar" | "simd";
  output(): Readonly<Uint32Array>;
}

interface FixtureExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly run: (pointer: number, length: number) => void;
}

export function createShapingWasmFixture(
  options: Readonly<ShapingWasmFixtureOptions>,
): ShapingWasmFixture {
  if (options.corpus.length === 0 || options.corpus.length % 4 !== 0) {
    throw new RangeError("corpus must contain a positive multiple of four code points");
  }
  const requiredBytes = options.corpus.byteLength;
  const memoryPages = Math.ceil(requiredBytes / 65_536);
  const module = new WebAssembly.Module(buildFixtureModule(options.simd, memoryPages));
  const instance = new WebAssembly.Instance(module);
  const exports = instance.exports as FixtureExports;
  const output = new Uint32Array(exports.memory.buffer, 0, options.corpus.length);
  output.set(options.corpus);

  return {
    kind: options.simd ? "simd" : "scalar",
    run() {
      exports.run(0, output.length);
    },
    hash() {
      return fnv1a(new Uint8Array(output.buffer, output.byteOffset, output.byteLength));
    },
    output() {
      return output;
    },
  };
}

function buildFixtureModule(simd: boolean, memoryPages: number): Uint8Array<ArrayBuffer> {
  const typeSection = section(1, [
    ...unsignedLeb(1),
    0x60,
    ...unsignedLeb(2),
    0x7f,
    0x7f,
    ...unsignedLeb(0),
  ]);
  const functionSection = section(3, [...unsignedLeb(1), ...unsignedLeb(0)]);
  const memorySection = section(5, [...unsignedLeb(1), 0x00, ...unsignedLeb(memoryPages)]);
  const exportSection = section(7, [
    ...unsignedLeb(2),
    ...utf8Name("memory"),
    0x02,
    ...unsignedLeb(0),
    ...utf8Name("run"),
    0x00,
    ...unsignedLeb(0),
  ]);
  const instructions = simd ? simdInstructions() : scalarInstructions();
  const body = [...unsignedLeb(1), ...unsignedLeb(1), 0x7f, ...instructions, 0x0b];
  const codeSection = section(10, [...unsignedLeb(1), ...unsignedLeb(body.length), ...body]);

  const bytes = [
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...typeSection,
    ...functionSection,
    ...memorySection,
    ...exportSection,
    ...codeSection,
  ];
  const module = new Uint8Array(bytes.length);
  module.set(bytes);
  return module;
}

function scalarInstructions(): readonly number[] {
  return [
    0x20, 0x00, 0x20, 0x01, 0x41, 0x02, 0x74, 0x6a, 0x21, 0x02, 0x02, 0x40, 0x03, 0x40, 0x20, 0x00,
    0x20, 0x02, 0x4f, 0x0d, 0x01, 0x20, 0x00, 0x20, 0x00, 0x28, 0x02, 0x00, 0x41, 0x1f, 0x6a, 0x36,
    0x02, 0x00, 0x20, 0x00, 0x41, 0x04, 0x6a, 0x21, 0x00, 0x0c, 0x00, 0x0b, 0x0b,
  ];
}

function simdInstructions(): readonly number[] {
  return [
    0x20, 0x00, 0x20, 0x01, 0x41, 0x02, 0x74, 0x6a, 0x21, 0x02, 0x02, 0x40, 0x03, 0x40, 0x20, 0x00,
    0x20, 0x02, 0x4f, 0x0d, 0x01, 0x20, 0x00, 0x20, 0x00, 0xfd, 0x00, 0x04, 0x00, 0x41, 0x1f, 0xfd,
    0x11, 0xfd, 0xae, 0x01, 0xfd, 0x0b, 0x04, 0x00, 0x20, 0x00, 0x41, 0x10, 0x6a, 0x21, 0x00, 0x0c,
    0x00, 0x0b, 0x0b,
  ];
}

function section(id: number, payload: readonly number[]): readonly number[] {
  return [id, ...unsignedLeb(payload.length), ...payload];
}

function utf8Name(value: string): readonly number[] {
  const bytes = new TextEncoder().encode(value);
  return [...unsignedLeb(bytes.length), ...bytes];
}

function unsignedLeb(value: number): readonly number[] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("LEB128 values must be non-negative safe integers");
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return bytes;
}

function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c_9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x0100_0193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
