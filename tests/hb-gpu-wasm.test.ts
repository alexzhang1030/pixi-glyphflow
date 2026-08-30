import { describe, expect, test } from "bun:test";

import {
  HB_GPU_DRAW_ABI_VERSION,
  HB_GPU_DRAW_HARFBUZZ_VERSION,
  HbGpuWasmRuntime,
} from "../src/hb-gpu";

interface NativeArtifact {
  readonly corpora: readonly {
    readonly id: string;
    readonly fontFile: string;
    readonly glyphs: readonly {
      readonly glyphId: number;
      readonly blobHex: string;
      readonly extents: {
        readonly xBearing: number;
        readonly yBearing: number;
        readonly width: number;
        readonly height: number;
      };
    }[];
  }[];
}

describe("HbGpuWasmRuntime", () => {
  test("matches every packed blob and extent in the native 14.4.0 artifact", async () => {
    const runtime = await loadRuntime();
    const artifact = (await Bun.file(
      new URL("../benchmarks/hb-gpu/results/hb-gpu-draw-native-14.4.0.json", import.meta.url),
    ).json()) as NativeArtifact;

    expect(runtime.abiVersion).toBe(HB_GPU_DRAW_ABI_VERSION);
    expect(runtime.harfbuzzVersion).toBe(HB_GPU_DRAW_HARFBUZZ_VERSION);
    expect(artifact.corpora.map((corpus) => corpus.id)).toEqual([
      "cjkv",
      "arabic",
      "devanagari",
      "hebrew",
      "thai",
    ]);

    let comparedGlyphs = 0;
    for (const corpus of artifact.corpora) {
      const fontBytes = new Uint8Array(
        await Bun.file(new URL(`../${corpus.fontFile}`, import.meta.url)).arrayBuffer(),
      );
      const font = runtime.createFont(fontBytes);
      for (const expected of corpus.glyphs) {
        const encoded = runtime.encode(font, expected.glyphId);
        expect(toHex(encoded.packedCurveBlob), `${corpus.id} glyph ${expected.glyphId}`).toBe(
          expected.blobHex,
        );
        expect(encoded.extents).toEqual(expected.extents);
        expect(encoded.upem).toBe(1_000);
        expect(runtime.liveResults).toBe(0);
        comparedGlyphs += 1;
      }
      runtime.destroyFont(font);
      expect(runtime.liveFonts).toBe(0);
    }

    expect(comparedGlyphs).toBeGreaterThanOrEqual(100);
    runtime.destroy();
  });

  test("rejects invalid font bytes without retaining a font resource", async () => {
    const runtime = await loadRuntime();

    expect(() => runtime.createFont(new Uint8Array([1, 2, 3]))).toThrow(
      "font face is invalid or empty",
    );
    expect(runtime.liveFonts).toBe(0);
    runtime.destroy();
  });

  test("guards live and recycled native font handles", async () => {
    const runtime = await loadRuntime();
    const fontBytes = new Uint8Array(
      await Bun.file(
        new URL("../site/public/fonts/noto-sans-cjkv-demo.ttf", import.meta.url),
      ).arrayBuffer(),
    );
    const font = runtime.createFont(fontBytes);

    expect(() => runtime.destroy()).toThrow("still owns JavaScript font handles");
    runtime.destroyFont(font);
    expect(() => runtime.encode(font, 130)).toThrow("already been destroyed");
    expect(() => runtime.destroyFont(font)).toThrow("already been destroyed");
    expect(runtime.liveFonts).toBe(0);
    runtime.destroy();
  });

  for (const decodeFailure of [
    {
      name: "result view",
      options: {
        resultPointer: 65_536 - 8,
        writeResult: false,
      },
    },
    {
      name: "packed blob copy",
      options: {
        dataPointer: 65_536 - 4,
        dataLength: 8,
      },
    },
  ] as const) {
    test(`keeps the ${decodeFailure.name} failure first when clear_result traps`, () => {
      const clearFailure = new Error("clear_result trap");
      const fixture = createInjectedRuntime({
        ...decodeFailure.options,
        clearResult: () => {
          throw clearFailure;
        },
      });
      const font = fixture.runtime.createFont(new Uint8Array([1]));

      const thrown = captureThrown(() => fixture.runtime.encode(font, 7));

      expect(thrown).toBeInstanceOf(RangeError);
      expect(thrown).not.toBe(clearFailure);
      expect(fixture.calls.encode).toBe(1);
      expect(fixture.calls.clearResult).toBe(1);
      fixture.runtime.destroyFont(font);
      fixture.runtime.destroy();
    });
  }

  test("retains a font handle for destroy retry and releases it exactly once", () => {
    const destroyFailure = new Error("destroy trap");
    let shouldTrap = true;
    const fixture = createInjectedRuntime({
      destroyFont: () => {
        if (!shouldTrap) return;
        shouldTrap = false;
        throw destroyFailure;
      },
    });
    const font = fixture.runtime.createFont(new Uint8Array([1]));

    expect(captureThrown(() => fixture.runtime.destroyFont(font))).toBe(destroyFailure);
    expect(fixture.calls.destroyFont).toBe(1);
    expect(() => fixture.runtime.destroy()).toThrow("still owns JavaScript font handles");
    expect(() => fixture.runtime.encode(font, 7)).not.toThrow();

    fixture.runtime.destroyFont(font);
    expect(fixture.calls.destroyFont).toBe(2);
    expect(() => fixture.runtime.destroyFont(font)).toThrow("already been destroyed");
    expect(fixture.calls.destroyFont).toBe(2);
    fixture.runtime.destroy();
  });
});

interface InjectedRuntimeOptions {
  readonly resultPointer?: number;
  readonly dataPointer?: number;
  readonly dataLength?: number;
  readonly writeResult?: boolean;
  readonly clearResult?: () => void;
  readonly destroyFont?: () => void;
}

function createInjectedRuntime(options: InjectedRuntimeOptions = {}): {
  readonly runtime: HbGpuWasmRuntime;
  readonly calls: {
    encode: number;
    clearResult: number;
    destroyFont: number;
  };
} {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const resultPointer = options.resultPointer ?? 64;
  const dataPointer = options.dataPointer ?? 512;
  const dataLength = options.dataLength ?? 0;
  const calls = {
    encode: 0,
    clearResult: 0,
    destroyFont: 0,
  };
  let allocations = 0;
  let liveFonts = 0;
  let liveResults = 0;
  const exports: WebAssembly.Exports = {
    memory,
    malloc: () => {
      allocations += 1;

      return allocations === 1 ? resultPointer : 256;
    },
    free: () => undefined,
    _initialize: () => undefined,
    hb_gpu_encoder_abi_version: () => HB_GPU_DRAW_ABI_VERSION,
    hb_gpu_encoder_harfbuzz_version: () => 0,
    hb_gpu_encoder_result_size: () => 28,
    hb_gpu_encoder_last_error: () => 0,
    hb_gpu_encoder_live_fonts: () => liveFonts,
    hb_gpu_encoder_live_results: () => liveResults,
    hb_gpu_encoder_create: () => {
      liveFonts += 1;

      return 1;
    },
    hb_gpu_encoder_destroy: () => {
      calls.destroyFont += 1;
      options.destroyFont?.();
      liveResults = 0;
      liveFonts -= 1;
    },
    hb_gpu_encoder_clear_result: () => {
      calls.clearResult += 1;
      options.clearResult?.();
      liveResults = 0;
    },
    hb_gpu_encoder_encode: () => {
      calls.encode += 1;
      liveResults = 1;
      if (options.writeResult === false) return 0;
      const result = new DataView(memory.buffer, resultPointer, 28);
      result.setUint32(0, dataPointer, true);
      result.setUint32(4, dataLength, true);
      result.setUint32(24, 1_000, true);

      return 0;
    },
  };

  return {
    runtime: new HbGpuWasmRuntime({ exports } as WebAssembly.Instance),
    calls,
  };
}

function captureThrown(callback: () => void): unknown {
  try {
    callback();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("Expected callback to throw");
}

async function loadRuntime(): Promise<HbGpuWasmRuntime> {
  const bytes = await Bun.file(
    new URL("../src/hb-gpu/wasm/hb-gpu-encoder.wasm", import.meta.url),
  ).arrayBuffer();

  return HbGpuWasmRuntime.instantiate(bytes);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
