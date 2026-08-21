import { computeCullRequiredLimits } from "./computeCull";

const OPTIONAL_WEBGPU_FEATURES = [
  "texture-compression-bc",
  "texture-compression-astc",
  "texture-compression-etc2",
] as const;

export interface ComputeCullGpu {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
}

export interface RequestComputeCullGpuOptions {
  readonly powerPreference?: GPUPowerPreference;
  readonly forceFallbackAdapter?: boolean;
}

/**
 * Request a WebGPU device whose storage-buffer binding limit matches the adapter. PixiJS
 * `requestDevice()` keeps the 128 MiB core default, which is too small for a million-label instance
 * buffer.
 */
export async function requestComputeCullGpu(
  options: RequestComputeCullGpuOptions = {},
): Promise<ComputeCullGpu | undefined> {
  const gpu = globalThis.navigator?.gpu;
  if (gpu === undefined) return undefined;
  const adapterOptions: GPURequestAdapterOptions = {};
  if (options.powerPreference !== undefined) {
    adapterOptions.powerPreference = options.powerPreference;
  }
  if (options.forceFallbackAdapter === true) {
    adapterOptions.forceFallbackAdapter = true;
  }
  const adapter = await gpu.requestAdapter(adapterOptions);
  if (adapter === null) return undefined;
  const requiredFeatures: GPUFeatureName[] = [];
  for (const feature of OPTIONAL_WEBGPU_FEATURES) {
    if (adapter.features.has(feature)) requiredFeatures.push(feature);
  }
  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: computeCullRequiredLimits(adapter.limits),
  });
  return { adapter, device };
}
