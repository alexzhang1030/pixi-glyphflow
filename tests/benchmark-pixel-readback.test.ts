import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { hashRenderedPixels } from "../benchmarks/browser/workloads";
import { installWebGpuGlobals } from "./fixtures/webgpuGlobals";

const FAILURE_STAGES = [
  "texture",
  "finishGpu",
  "source",
  "buffer",
  "encoder",
  "copy",
  "encoderFinish",
  "submit",
  "map",
  "range",
] as const;

type FailureStage = (typeof FAILURE_STAGES)[number];

interface PixelReadbackFixture {
  readonly app: never;
  readonly target: never;
  readonly calls: string[];
  readonly cleanup: {
    textureDestroys: number;
    bufferDestroys: number;
    bufferUnmaps: number;
  };
}

let restoreGpuGlobals: () => void = () => undefined;

beforeAll(() => {
  restoreGpuGlobals = installWebGpuGlobals({
    GPUBufferUsage: Object.freeze({ COPY_DST: 1, MAP_READ: 2 }),
    GPUMapMode: Object.freeze({ READ: 1 }),
  });
});

afterAll(() => {
  restoreGpuGlobals();
});

describe("GPU-resident benchmark pixel readback", () => {
  test("preserves the successful pixel hash and releases mapped resources once", async () => {
    const fixture = createPixelReadbackFixture();

    await expect(hashRenderedPixels(fixture.app, fixture.target, 2, 1)).resolves.toEqual({
      hash: 537_156_341,
      nonTransparentPixels: 1,
    });

    expect(fixture.calls).toEqual([
      "texture",
      "finishGpu",
      "source",
      "buffer",
      "encoder",
      "copy",
      "encoderFinish",
      "submit",
      "map",
      "range",
      "unmap",
      "bufferDestroy",
      "textureDestroy",
    ]);
    expect(fixture.cleanup).toEqual({
      textureDestroys: 1,
      bufferDestroys: 1,
      bufferUnmaps: 1,
    });
  });

  for (const stage of FAILURE_STAGES) {
    test(`releases every resource once when ${stage} fails`, async () => {
      const fixture = createPixelReadbackFixture(stage);

      await expect(hashRenderedPixels(fixture.app, fixture.target, 2, 1)).rejects.toThrow(
        `${stage} failed`,
      );

      const textureCreated = stage !== "texture";
      const bufferCreated = textureCreated && !["finishGpu", "source", "buffer"].includes(stage);
      const mapCompleted = bufferCreated && stage === "range";
      expect(fixture.cleanup).toEqual({
        textureDestroys: textureCreated ? 1 : 0,
        bufferDestroys: bufferCreated ? 1 : 0,
        bufferUnmaps: mapCompleted ? 1 : 0,
      });
    });
  }
});

function createPixelReadbackFixture(failureStage?: FailureStage): PixelReadbackFixture {
  const calls: string[] = [];
  const cleanup = {
    textureDestroys: 0,
    bufferDestroys: 0,
    bufferUnmaps: 0,
  };
  const fail = (stage: FailureStage): void => {
    calls.push(stage);
    if (failureStage === stage) throw new Error(`${stage} failed`);
  };
  const pixels = new Uint8Array(256);
  pixels.set([1, 2, 3, 4, 5, 6, 7, 0]);
  const buffer = {
    async mapAsync() {
      fail("map");
    },
    getMappedRange() {
      fail("range");
      return pixels.buffer;
    },
    unmap() {
      calls.push("unmap");
      cleanup.bufferUnmaps += 1;
    },
    destroy() {
      calls.push("bufferDestroy");
      cleanup.bufferDestroys += 1;
    },
  };
  const encoder = {
    copyTextureToBuffer() {
      fail("copy");
    },
    finish() {
      fail("encoderFinish");
      return {};
    },
  };
  const texture = {
    source: {},
    destroy(deep: boolean) {
      expect(deep).toBe(true);
      calls.push("textureDestroy");
      cleanup.textureDestroys += 1;
    },
  };
  const queue = {
    async onSubmittedWorkDone() {
      fail("finishGpu");
    },
    submit() {
      fail("submit");
    },
  };
  const app = {
    renderer: {
      extract: {
        texture() {
          fail("texture");
          return texture;
        },
      },
      texture: {
        getGpuSource() {
          fail("source");
          return {};
        },
      },
      gpu: {
        device: {
          queue,
          createBuffer() {
            fail("buffer");
            return buffer;
          },
          createCommandEncoder() {
            fail("encoder");
            return encoder;
          },
        },
      },
    },
  };

  return { app: app as never, target: {} as never, calls, cleanup };
}
