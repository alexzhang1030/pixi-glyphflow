const WEB_GPU_GLOBAL_NAMES = [
  "GPUShaderStage",
  "GPUBufferUsage",
  "GPUTextureUsage",
  "GPUMapMode",
] as const;

type WebGpuGlobalName = (typeof WEB_GPU_GLOBAL_NAMES)[number];

export type WebGpuGlobalValues = Partial<
  Readonly<Record<WebGpuGlobalName, Readonly<Record<string, number>>>>
>;

export function installWebGpuGlobals(values: WebGpuGlobalValues): () => void {
  const installed: Array<readonly [WebGpuGlobalName, PropertyDescriptor | undefined]> = [];
  let restored = false;

  const restore = (): void => {
    if (restored) return;

    let firstError: unknown;
    for (let index = installed.length - 1; index >= 0; index -= 1) {
      const [name, descriptor] = installed[index]!;
      try {
        if (descriptor === undefined) {
          if (!Reflect.deleteProperty(globalThis, name)) {
            throw new TypeError(`Failed to delete restored global ${name}`);
          }
        } else {
          Object.defineProperty(globalThis, name, descriptor);
        }
      } catch (error) {
        firstError ??= error;
      }
    }

    if (firstError !== undefined) throw firstError;
    restored = true;
  };

  try {
    for (const name of WEB_GPU_GLOBAL_NAMES) {
      if (!Object.hasOwn(values, name)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
      Object.defineProperty(globalThis, name, {
        configurable: true,
        value: values[name],
      });
      installed.push([name, descriptor]);
    }
  } catch (error) {
    try {
      restore();
    } catch {}
    throw error;
  }

  return restore;
}
