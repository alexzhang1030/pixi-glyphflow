import type { BrowserGpuAdapterIdentity, BrowserGpuAdapterLimits } from "../schema";
import type { BenchmarkWebGpu } from "./timing";

/** Capture the adapter and device limits that governed a WebGPU benchmark sample. */
export function captureBrowserGpuAdapterIdentity(
  gpu: BenchmarkWebGpu,
): Readonly<BrowserGpuAdapterIdentity> {
  const info = gpu.adapter.info;
  const limits = gpu.device.limits;
  const capturedLimits: BrowserGpuAdapterLimits = {
    maxStorageBufferBindingSize: Number(limits.maxStorageBufferBindingSize),
    maxBufferSize: Number(limits.maxBufferSize),
    maxStorageBuffersPerShaderStage: Number(limits.maxStorageBuffersPerShaderStage),
    maxStorageBuffersInVertexStage: Number(limits.maxStorageBuffersInVertexStage ?? 0),
    maxComputeWorkgroupStorageSize: Number(limits.maxComputeWorkgroupStorageSize),
    maxComputeInvocationsPerWorkgroup: Number(limits.maxComputeInvocationsPerWorkgroup),
    maxComputeWorkgroupSizeX: Number(limits.maxComputeWorkgroupSizeX),
    maxComputeWorkgroupSizeY: Number(limits.maxComputeWorkgroupSizeY),
    maxComputeWorkgroupSizeZ: Number(limits.maxComputeWorkgroupSizeZ),
    maxComputeWorkgroupsPerDimension: Number(limits.maxComputeWorkgroupsPerDimension),
  };

  return Object.freeze({
    vendor: stringValue(info?.vendor),
    architecture: stringValue(info?.architecture),
    device: stringValue(info?.device),
    description: stringValue(info?.description),
    timestampQuery: gpu.device.features.has("timestamp-query"),
    limits: Object.freeze(capturedLimits),
  });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
