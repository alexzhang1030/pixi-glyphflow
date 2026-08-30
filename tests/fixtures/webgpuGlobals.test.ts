import { expect, test } from "bun:test";

import { installWebGpuGlobals } from "./webgpuGlobals";

test("restores the exact WebGPU global descriptor after a case throws", () => {
  const name = "GPUTextureUsage";
  const original = Object.getOwnPropertyDescriptor(globalThis, name);
  const accessorValue = Object.freeze({ STORAGE_BINDING: 91 });
  const accessor = {
    configurable: true,
    enumerable: true,
    get: () => accessorValue,
  } satisfies PropertyDescriptor;
  Object.defineProperty(globalThis, name, accessor);

  try {
    const failure = new Error("injected test failure");
    expect(() => {
      const restore = installWebGpuGlobals({
        GPUTextureUsage: Object.freeze({ STORAGE_BINDING: 1 }),
      });
      try {
        throw failure;
      } finally {
        restore();
      }
    }).toThrow(failure);
    expect(Object.getOwnPropertyDescriptor(globalThis, name)).toEqual(accessor);
  } finally {
    if (original === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, original);
  }
});

test("rolls back earlier globals when installation fails", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "GPUShaderStage");
  const failure = new Error("injected descriptor failure");
  const values = {
    GPUShaderStage: Object.freeze({ COMPUTE: 4 }),
    get GPUBufferUsage(): Readonly<Record<string, number>> {
      throw failure;
    },
  };

  expect(() => installWebGpuGlobals(values)).toThrow(failure);
  expect(Object.getOwnPropertyDescriptor(globalThis, "GPUShaderStage")).toEqual(original);
});
