const OPTIONAL_WEBGPU_FEATURES = [
  "texture-compression-bc",
  "texture-compression-astc",
  "texture-compression-etc2",
] as const;

export interface ComputeCullGpu {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
}

export function computeCullDeviceLimits(adapter: {
  readonly limits: {
    readonly maxStorageBufferBindingSize: number;
    readonly maxBufferSize: number;
    readonly maxStorageBuffersInVertexStage?: number;
  };
}): GPUDeviceDescriptor["requiredLimits"] {
  const limits: Record<string, number> = {
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    maxBufferSize: adapter.limits.maxBufferSize,
  };
  const vertexStorage = adapter.limits.maxStorageBuffersInVertexStage ?? 0;
  if (vertexStorage > 0) {
    limits.maxStorageBuffersInVertexStage = vertexStorage;
  }
  return limits;
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
    requiredLimits: computeCullDeviceLimits(adapter),
  });
  return { adapter, device };
}
