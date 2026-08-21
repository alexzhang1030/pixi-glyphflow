const OPTIONAL_WEBGPU_FEATURES = [
  "texture-compression-bc",
  "texture-compression-astc",
  "texture-compression-etc2",
] as const;

export interface ComputeCullGpu {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
}

export async function requestComputeCullGpu(
  options: GPURequestAdapterOptions = {},
): Promise<ComputeCullGpu | undefined> {
  const gpu = globalThis.navigator?.gpu;
  if (gpu === undefined) return undefined;
  const adapter = await gpu.requestAdapter(options);
  if (adapter === null) return undefined;
  const requiredFeatures: GPUFeatureName[] = [];
  for (const feature of OPTIONAL_WEBGPU_FEATURES) {
    if (adapter.features.has(feature)) requiredFeatures.push(feature);
  }
  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  return { adapter, device };
}
