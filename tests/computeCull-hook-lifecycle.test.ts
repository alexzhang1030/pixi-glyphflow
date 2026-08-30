import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { WebGPURenderer } from "pixi.js";

import { ComputeCullPass } from "../src/render/ComputeCullPass";
import { installWebGpuGlobals } from "./fixtures/webgpuGlobals";

type Draw = WebGPURenderer["encoder"]["draw"];

let restoreGpuGlobals: () => void = () => undefined;

beforeAll(() => {
  restoreGpuGlobals = installWebGpuGlobals({
    GPUShaderStage: Object.freeze({ COMPUTE: 4 }),
    GPUBufferUsage: Object.freeze({
      STORAGE: 0x0080,
      COPY_SRC: 0x0004,
      COPY_DST: 0x0008,
      VERTEX: 0x0020,
      UNIFORM: 0x0040,
    }),
  });
});

afterAll(() => {
  restoreGpuGlobals();
});

describe("ComputeCullPass encoder draw hook lifecycle", () => {
  test("rolls back an inherited non-writable draw and supports retry", () => {
    const calls: string[] = [];
    const original: Draw = () => calls.push("original");
    const prototype = Object.create(null) as object;
    Object.defineProperty(prototype, "draw", {
      configurable: true,
      enumerable: true,
      value: original,
      writable: false,
    });
    const encoder = Object.create(prototype) as WebGPURenderer["encoder"];
    const renderer = createHookRenderer(encoder);
    const pass = new ComputeCullPass(renderer);

    expect(pass.initialize()).toBe(false);
    expect(pass.failureReason).toContain("draw hook is not writable");
    expect(Object.hasOwn(encoder, "draw")).toBe(false);
    expect(encoder.draw).toBe(original);

    const retryDescriptor = {
      configurable: true,
      enumerable: true,
      value: original,
      writable: true,
    } satisfies PropertyDescriptor;
    Object.defineProperty(prototype, "draw", retryDescriptor);

    expect(pass.initialize()).toBe(true);
    expect(encoder.draw).not.toBe(original);
    encoder.draw({} as never);
    expect(calls).toEqual(["original"]);

    pass.destroy();
    expect(Object.hasOwn(encoder, "draw")).toBe(false);
    expect(Object.getOwnPropertyDescriptor(prototype, "draw")).toEqual(retryDescriptor);
    expect(encoder.draw).toBe(original);
  });

  test("rolls back a mutate-then-throw setter and retries on the same pass", () => {
    const calls: string[] = [];
    const writes: Draw[] = [];
    const original: Draw = () => calls.push("original");
    let current = original;
    let rejectWrite = true;
    const encoder = {} as WebGPURenderer["encoder"];
    Object.defineProperty(encoder, "draw", {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value: Draw) => {
        writes.push(value);
        current = value;
        if (rejectWrite) throw new Error("injected draw setter failure");
      },
    });
    const originalDescriptor = Object.getOwnPropertyDescriptor(encoder, "draw");
    const pass = new ComputeCullPass(createHookRenderer(encoder));

    expect(pass.initialize()).toBe(false);
    expect(pass.failureReason).toContain("injected draw setter failure");
    expect(encoder.draw).toBe(original);
    expect(Object.getOwnPropertyDescriptor(encoder, "draw")).toEqual(originalDescriptor);

    rejectWrite = false;
    expect(pass.initialize()).toBe(true);
    encoder.draw({} as never);
    expect(calls).toEqual(["original"]);

    pass.destroy();
    expect(encoder.draw).toBe(original);
    expect(Object.getOwnPropertyDescriptor(encoder, "draw")).toEqual(originalDescriptor);
    expect(writes).toHaveLength(4);
  });

  test("migrates the indirect draw hook when the renderer encoder identity changes", () => {
    const first = createIndirectDrawFixture("first");
    const second = createIndirectDrawFixture("second");
    const rendererState = createHookRenderer(first.encoder);
    const pass = new ComputeCullPass(rendererState);
    expect(pass.initialize()).toBe(true);
    expect(pass.ensureCapacity(1, 8)).toBe(true);
    const geometry = {
      attributes: { aProtoIndex: { buffer: {} } },
    };
    const options = {
      geometry,
      shader: { gpuProgram: {} },
      state: {},
      topology: "triangle-list",
    } as never;
    pass.trackGeometry(geometry as never);
    const staleFirstHook = first.encoder.draw;

    first.encoder.draw(options);
    expect(first.calls).toEqual(["first:indirect"]);

    (rendererState as unknown as { encoder: WebGPURenderer["encoder"] }).encoder = second.encoder;
    expect(pass.initialize()).toBe(true);
    expect(first.encoder.draw).toBe(first.original);
    second.encoder.draw(options);
    expect(second.calls).toEqual(["second:indirect"]);

    staleFirstHook.call(first.encoder, options);
    expect(first.calls).toEqual(["first:indirect", "first:original"]);
    pass.destroy();
    expect(second.encoder.draw).toBe(second.original);
  });

  test("classifies a temporarily immutable replacement hook and recovers on the same device", () => {
    const first = createIndirectDrawFixture("first-transient");
    const second = createIndirectDrawFixture("second-transient");
    Object.defineProperty(second.encoder, "draw", {
      configurable: true,
      enumerable: true,
      value: second.original,
      writable: false,
    });
    const renderer = createHookRenderer(first.encoder);
    const pass = new ComputeCullPass(renderer);
    expect(pass.initialize()).toBe(true);
    expect(pass.ensureCapacity(1, 8)).toBe(true);
    expect(pass.uploadRecords(new ArrayBuffer(32), 1, "all")).toBe(true);
    const firstHook = first.encoder.draw;

    (renderer as unknown as { encoder: WebGPURenderer["encoder"] }).encoder = second.encoder;
    expect(() => pass.initialize()).not.toThrow();
    expect(pass.ready).toBe(false);
    expect(pass.initializationFailureKind).toBe("hook-transient");
    expect(pass.requiresFullSync).toBe(true);
    expect(pass.synced).toBe(false);
    expect(first.encoder.draw).toBe(first.original);
    firstHook.call(first.encoder, {} as never);
    expect(first.calls).toEqual(["first-transient:original"]);

    Object.defineProperty(second.encoder, "draw", {
      configurable: true,
      enumerable: true,
      value: second.original,
      writable: true,
    });
    expect(pass.initialize()).toBe(true);
    expect(pass.initializationFailureKind).toBeUndefined();
    expect(second.encoder.draw).not.toBe(second.original);
    pass.destroy();
    expect(second.encoder.draw).toBe(second.original);
  });

  for (const placement of ["own", "prototype"] as const) {
    for (const destroyOrder of ["first-owner-first", "last-owner-first"] as const) {
      test(`restores ${placement} placement after shared owners teardown ${destroyOrder}`, () => {
        const fixture = createDrawPlacementFixture(placement);
        const renderer = createHookRenderer(fixture.encoder);
        const first = new ComputeCullPass(renderer);
        const second = new ComputeCullPass(renderer);
        expect(first.initialize()).toBe(true);
        const sharedHook = fixture.encoder.draw;
        expect(second.initialize()).toBe(true);
        expect(fixture.encoder.draw).toBe(sharedHook);

        const firstDestroyed = destroyOrder === "first-owner-first" ? first : second;
        const lastDestroyed = firstDestroyed === first ? second : first;
        firstDestroyed.destroy();
        expect(fixture.encoder.draw).toBe(sharedHook);
        lastDestroyed.destroy();

        expectDrawPlacement(fixture);
      });
    }

    for (const destroyOrder of ["foreign-first", "compute-first"] as const) {
      test(`preserves a later foreign wrapper with ${placement} placement and ${destroyOrder} teardown`, () => {
        const fixture = createDrawPlacementFixture(placement);
        const renderer = createHookRenderer(fixture.encoder);
        const pass = new ComputeCullPass(renderer);
        expect(pass.initialize()).toBe(true);
        const computeHook = fixture.encoder.draw;
        const foreign = installForeignDrawWrapper(fixture.encoder, fixture.calls);

        if (destroyOrder === "foreign-first") {
          foreign.destroy();
          pass.destroy();
        } else {
          pass.destroy();
          expect(fixture.encoder.draw).toBe(foreign.wrapper);
          fixture.encoder.draw({} as never);
          computeHook.call(fixture.encoder, {} as never);
          expect(fixture.calls).toEqual(["foreign", "original", "original"]);
          foreign.destroy();
        }

        expectDrawPlacement(fixture);
        fixture.encoder.draw({} as never);
        expect(fixture.calls.at(-1)).toBe("original");
      });
    }
  }
});

interface DrawPlacementFixture {
  readonly encoder: WebGPURenderer["encoder"];
  readonly prototype: object;
  readonly calls: string[];
  readonly original: Draw;
  readonly ownDescriptor: PropertyDescriptor | undefined;
  readonly prototypeDescriptor: PropertyDescriptor | undefined;
}

interface IndirectDrawFixture {
  readonly encoder: WebGPURenderer["encoder"];
  readonly calls: string[];
  readonly original: Draw;
}

function createIndirectDrawFixture(name: string): IndirectDrawFixture {
  const calls: string[] = [];
  const original: Draw = () => calls.push(`${name}:original`);
  const encoder = {
    draw: original,
    renderPassEncoder: {
      setVertexBuffer() {},
      drawIndexedIndirect() {
        calls.push(`${name}:indirect`);
      },
    },
    setPipelineFromGeometryProgramAndState() {},
    setGeometry() {},
    _setShaderBindGroups() {},
  } as unknown as WebGPURenderer["encoder"];
  return { encoder, calls, original };
}

function createDrawPlacementFixture(placement: "own" | "prototype"): DrawPlacementFixture {
  const calls: string[] = [];
  const original: Draw = () => calls.push("original");
  const prototype = Object.create(null) as object;
  const encoder = Object.create(prototype) as WebGPURenderer["encoder"];
  const descriptor: PropertyDescriptor = {
    configurable: true,
    enumerable: true,
    value: original,
    writable: true,
  };
  Object.defineProperty(placement === "own" ? encoder : prototype, "draw", descriptor);
  return {
    encoder,
    prototype,
    calls,
    original,
    ownDescriptor: Object.getOwnPropertyDescriptor(encoder, "draw"),
    prototypeDescriptor: Object.getOwnPropertyDescriptor(prototype, "draw"),
  };
}

function installForeignDrawWrapper(
  encoder: WebGPURenderer["encoder"],
  calls: string[],
): Readonly<{ wrapper: Draw; destroy(): void }> {
  const previous = encoder.draw;
  const previousOwnDescriptor = Object.getOwnPropertyDescriptor(encoder, "draw");
  const wrapper: Draw = function (this: WebGPURenderer["encoder"], options): void {
    calls.push("foreign");
    previous.call(this, options);
  };
  if (!Reflect.set(encoder, "draw", wrapper) || encoder.draw !== wrapper) {
    throw new Error("foreign draw wrapper installation failed");
  }
  return {
    wrapper,
    destroy() {
      if (encoder.draw !== wrapper) return;
      if (previousOwnDescriptor === undefined) {
        Reflect.deleteProperty(encoder, "draw");
        Reflect.set(encoder, "draw", previous);
        Reflect.deleteProperty(encoder, "draw");
        return;
      }
      Object.defineProperty(encoder, "draw", previousOwnDescriptor);
      Reflect.set(encoder, "draw", previous);
      if ("value" in previousOwnDescriptor) {
        Object.defineProperty(encoder, "draw", previousOwnDescriptor);
      }
    },
  };
}

function expectDrawPlacement(fixture: DrawPlacementFixture): void {
  expect(Object.getOwnPropertyDescriptor(fixture.encoder, "draw")).toEqual(fixture.ownDescriptor);
  expect(Object.getOwnPropertyDescriptor(fixture.prototype, "draw")).toEqual(
    fixture.prototypeDescriptor,
  );
  expect(fixture.encoder.draw).toBe(fixture.original);
}

function createHookRenderer(encoder: WebGPURenderer["encoder"]): WebGPURenderer {
  const handles = new WeakMap<object, object>();
  return {
    gpu: {
      device: {
        limits: {
          maxStorageBufferBindingSize: 134_217_728,
          maxBufferSize: 268_435_456,
          maxStorageBuffersPerShaderStage: 8,
          maxComputeInvocationsPerWorkgroup: 256,
          maxComputeWorkgroupSizeX: 256,
          maxComputeWorkgroupsPerDimension: 65_535,
        },
        createShaderModule: () => ({}),
        createBindGroupLayout: () => ({}),
        createPipelineLayout: () => ({}),
        createComputePipeline: () => ({}),
        createBuffer: ({ label }: { label?: string }) => ({
          label,
          destroy() {},
        }),
        queue: { writeBuffer() {} },
      },
    },
    buffer: {
      updateBuffer(buffer: object) {
        if (!handles.has(buffer)) handles.set(buffer, { indirect: buffer });
      },
      getGPUBuffer(buffer: object) {
        return handles.get(buffer) ?? { indirect: buffer };
      },
    },
    pipeline: {
      getBufferNamesToBind: () => ({ 0: "aProtoIndex" }),
    },
    encoder,
  } as unknown as WebGPURenderer;
}
