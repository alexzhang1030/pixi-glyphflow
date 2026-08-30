import type { HbGpuDrawEncodeResult } from "./types";

const RESULT_BYTES = 28;
const RESULT_DATA_OFFSET = 0;
const RESULT_LENGTH_OFFSET = 4;
const RESULT_X_BEARING_OFFSET = 8;
const RESULT_Y_BEARING_OFFSET = 12;
const RESULT_WIDTH_OFFSET = 16;
const RESULT_HEIGHT_OFFSET = 20;
const RESULT_UPEM_OFFSET = 24;

interface HbGpuWasmExports extends WebAssembly.Exports {
  readonly memory: WebAssembly.Memory;
  readonly malloc: (bytes: number) => number;
  readonly free: (pointer: number) => void;
  readonly _initialize: () => void;
  readonly hb_gpu_encoder_abi_version: () => number;
  readonly hb_gpu_encoder_harfbuzz_version: () => number;
  readonly hb_gpu_encoder_result_size: () => number;
  readonly hb_gpu_encoder_last_error: () => number;
  readonly hb_gpu_encoder_live_fonts: () => number;
  readonly hb_gpu_encoder_live_results: () => number;
  readonly hb_gpu_encoder_create: (
    fontData: number,
    fontLength: number,
    faceIndex: number,
  ) => number;
  readonly hb_gpu_encoder_destroy: (font: number) => void;
  readonly hb_gpu_encoder_clear_result: (font: number) => void;
  readonly hb_gpu_encoder_encode: (font: number, glyphId: number, result: number) => number;
}

export type HbGpuWasmFontHandle = number;

export class HbGpuWasmRuntime {
  readonly #exports: HbGpuWasmExports;
  readonly #resultPointer: number;
  readonly #fontHandles = new Set<HbGpuWasmFontHandle>();
  #destroyed = false;

  constructor(instance: WebAssembly.Instance) {
    this.#exports = assertExports(instance.exports);
    this.#exports._initialize();
    const resultBytes = this.#exports.hb_gpu_encoder_result_size();
    if (resultBytes !== RESULT_BYTES) {
      throw new Error(
        `Hb GPU encoder result ABI mismatch: expected ${String(RESULT_BYTES)} bytes, received ${String(resultBytes)}`,
      );
    }
    this.#resultPointer = this.#exports.malloc(RESULT_BYTES) >>> 0;
    if (this.#resultPointer === 0) throw new Error("Hb GPU encoder result allocation failed");
  }

  static async load(url: string | URL): Promise<HbGpuWasmRuntime> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `Hb GPU encoder Wasm fetch failed: ${String(response.status)} ${response.statusText}`,
      );
    }
    const imports = createImports();
    let instantiated: WebAssembly.WebAssemblyInstantiatedSource;
    if (typeof WebAssembly.instantiateStreaming === "function") {
      try {
        instantiated = await WebAssembly.instantiateStreaming(response.clone(), imports.values);
      } catch {
        instantiated = await WebAssembly.instantiate(await response.arrayBuffer(), imports.values);
      }
    } else {
      instantiated = await WebAssembly.instantiate(await response.arrayBuffer(), imports.values);
    }
    const exportedMemory = instantiated.instance.exports.memory;
    imports.attach(exportedMemory instanceof WebAssembly.Memory ? exportedMemory : undefined);

    return new HbGpuWasmRuntime(instantiated.instance);
  }

  static async instantiate(bytes: BufferSource): Promise<HbGpuWasmRuntime> {
    const imports = createImports();
    const module = await WebAssembly.compile(bytes);
    const instance = await WebAssembly.instantiate(module, imports.values);
    const exportedMemory = instance.exports.memory;
    imports.attach(exportedMemory instanceof WebAssembly.Memory ? exportedMemory : undefined);

    return new HbGpuWasmRuntime(instance);
  }

  get abiVersion(): number {
    this.#assertActive();

    return this.#exports.hb_gpu_encoder_abi_version() >>> 0;
  }

  get harfbuzzVersion(): string {
    this.#assertActive();

    return this.#readString(this.#exports.hb_gpu_encoder_harfbuzz_version() >>> 0);
  }

  get liveFonts(): number {
    this.#assertActive();

    return this.#exports.hb_gpu_encoder_live_fonts() >>> 0;
  }

  get liveResults(): number {
    this.#assertActive();

    return this.#exports.hb_gpu_encoder_live_results() >>> 0;
  }

  createFont(fontBytes: Uint8Array, faceIndex = 0): HbGpuWasmFontHandle {
    this.#assertActive();
    if (fontBytes.byteLength === 0) throw new TypeError("fontBytes must contain a font");
    if (!Number.isSafeInteger(faceIndex) || faceIndex < 0 || faceIndex > 0xffff_ffff) {
      throw new TypeError("faceIndex must be a uint32");
    }
    const fontPointer = this.#exports.malloc(fontBytes.byteLength) >>> 0;
    if (fontPointer === 0) throw new Error("Hb GPU font upload allocation failed");
    try {
      new Uint8Array(this.#exports.memory.buffer, fontPointer, fontBytes.byteLength).set(fontBytes);
      const handle =
        this.#exports.hb_gpu_encoder_create(fontPointer, fontBytes.byteLength, faceIndex) >>> 0;
      if (handle === 0) throw new Error(`Hb GPU font creation failed: ${this.#lastError()}`);
      this.#fontHandles.add(handle);

      return handle;
    } finally {
      this.#exports.free(fontPointer);
    }
  }

  encode(font: HbGpuWasmFontHandle, glyphId: number): Readonly<HbGpuDrawEncodeResult> {
    this.#assertActive();
    this.#assertFontHandle(font);
    if (!Number.isSafeInteger(glyphId) || glyphId < 0 || glyphId > 0xffff_ffff) {
      throw new TypeError("glyphId must be a uint32");
    }
    let encoded: Readonly<HbGpuDrawEncodeResult> | undefined;
    let firstFailure: { readonly error: unknown } | undefined;
    try {
      const status = this.#exports.hb_gpu_encoder_encode(font, glyphId, this.#resultPointer);
      if (status !== 0) {
        throw new Error(
          `Hb GPU glyph encode failed with status ${String(status)}: ${this.#lastError()}`,
        );
      }
      const result = new DataView(this.#exports.memory.buffer, this.#resultPointer, RESULT_BYTES);
      const dataPointer = result.getUint32(RESULT_DATA_OFFSET, true);
      const dataLength = result.getUint32(RESULT_LENGTH_OFFSET, true);
      if (dataLength % 8 !== 0) {
        throw new Error("Hb GPU encoder returned a partial RGBA16I texel");
      }
      const packedCurveBlob = new Uint8Array(dataLength);
      packedCurveBlob.set(new Uint8Array(this.#exports.memory.buffer, dataPointer, dataLength));

      encoded = Object.freeze({
        packedCurveBlob,
        extents: Object.freeze({
          xBearing: result.getInt32(RESULT_X_BEARING_OFFSET, true),
          yBearing: result.getInt32(RESULT_Y_BEARING_OFFSET, true),
          width: result.getInt32(RESULT_WIDTH_OFFSET, true),
          height: result.getInt32(RESULT_HEIGHT_OFFSET, true),
        }),
        upem: result.getUint32(RESULT_UPEM_OFFSET, true),
      });
    } catch (error: unknown) {
      firstFailure = { error };
    }
    try {
      this.#exports.hb_gpu_encoder_clear_result(font);
    } catch (error: unknown) {
      firstFailure ??= { error };
    }
    if (firstFailure !== undefined) throw firstFailure.error;
    if (encoded === undefined) throw new Error("Hb GPU encoder omitted its encoded result");

    return encoded;
  }

  destroyFont(font: HbGpuWasmFontHandle): void {
    this.#assertActive();
    this.#assertFontHandle(font);
    this.#exports.hb_gpu_encoder_destroy(font);
    this.#fontHandles.delete(font);
  }

  destroy(): void {
    if (this.#destroyed) return;
    if (this.#fontHandles.size !== 0) {
      throw new Error("Hb GPU Wasm runtime still owns JavaScript font handles");
    }
    if (this.#exports.hb_gpu_encoder_live_fonts() !== 0) {
      throw new Error("Hb GPU Wasm runtime still owns font handles");
    }
    if (this.#exports.hb_gpu_encoder_live_results() !== 0) {
      throw new Error("Hb GPU Wasm runtime still owns encoded blobs");
    }
    this.#exports.free(this.#resultPointer);
    this.#destroyed = true;
  }

  #lastError(): string {
    const message = this.#readString(this.#exports.hb_gpu_encoder_last_error() >>> 0);

    return message.length === 0 ? "unknown encoder error" : message;
  }

  #readString(pointer: number): string {
    if (pointer === 0) return "";
    const bytes = new Uint8Array(this.#exports.memory.buffer);
    let end = pointer;
    while (end < bytes.byteLength && bytes[end] !== 0) end += 1;
    if (end === bytes.byteLength) throw new Error("Hb GPU encoder returned an unterminated string");

    return new TextDecoder().decode(bytes.subarray(pointer, end));
  }

  #assertActive(): void {
    if (this.#destroyed) throw new Error("HbGpuWasmRuntime has been destroyed");
  }

  #assertFontHandle(font: HbGpuWasmFontHandle): void {
    if (!Number.isSafeInteger(font) || font <= 0 || font > 0xffff_ffff) {
      throw new TypeError("font handle must be a non-zero uint32");
    }
    if (!this.#fontHandles.has(font)) {
      throw new RangeError("font handle is absent or has already been destroyed");
    }
  }
}

function assertExports(exports: WebAssembly.Exports): HbGpuWasmExports {
  const requiredFunctions = [
    "malloc",
    "free",
    "_initialize",
    "hb_gpu_encoder_abi_version",
    "hb_gpu_encoder_harfbuzz_version",
    "hb_gpu_encoder_result_size",
    "hb_gpu_encoder_last_error",
    "hb_gpu_encoder_live_fonts",
    "hb_gpu_encoder_live_results",
    "hb_gpu_encoder_create",
    "hb_gpu_encoder_destroy",
    "hb_gpu_encoder_clear_result",
    "hb_gpu_encoder_encode",
  ] as const;
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("Hb GPU Wasm module omits its linear memory export");
  }
  for (const name of requiredFunctions) {
    if (typeof exports[name] !== "function") {
      throw new Error(`Hb GPU Wasm module omits export ${name}`);
    }
  }

  return exports as HbGpuWasmExports;
}

function createImports(): {
  readonly values: WebAssembly.Imports;
  readonly attach: (memory: WebAssembly.Memory | undefined) => void;
} {
  let memory: WebAssembly.Memory | undefined;
  const attach = (value: WebAssembly.Memory | undefined): void => {
    if (value instanceof WebAssembly.Memory) memory = value;
  };

  return {
    attach,
    values: {
      env: {
        emscripten_notify_memory_growth: (): void => undefined,
      },
      wasi_snapshot_preview1: {
        fd_write: (_fd: number, iov: number, count: number, written: number): number => {
          const current = memory;
          if (current === undefined) return 8;
          const view = new DataView(current.buffer);
          let bytes = 0;
          for (let index = 0; index < count; index += 1) {
            bytes += view.getUint32(iov + index * 8 + 4, true);
          }
          view.setUint32(written, bytes, true);

          return 0;
        },
        fd_close: (): number => 0,
        environ_sizes_get: (countPointer: number, sizePointer: number): number => {
          const current = memory;
          if (current === undefined) return 8;
          const view = new DataView(current.buffer);
          view.setUint32(countPointer, 0, true);
          view.setUint32(sizePointer, 0, true);

          return 0;
        },
        environ_get: (): number => 0,
        fd_seek: (_fd: number, _offset: bigint, _whence: number, newOffset: number): number => {
          const current = memory;
          if (current === undefined) return 8;
          new DataView(current.buffer).setBigUint64(newOffset, 0n, true);

          return 0;
        },
      },
    },
  };
}
