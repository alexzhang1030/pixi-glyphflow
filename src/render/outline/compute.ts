import { cleanupBestEffort } from "../cleanup";
import { OUTLINE_COMPUTE_WGSL } from "./outlineCompute.wgsl";
import { resolveRasterGeometry } from "./reference";
import type {
  OutlineColor,
  OutlineColorAtlas,
  OutlineColorAtlasEntry,
  OutlineComputeCapability,
  OutlineComputeRasterizer,
  OutlineComputeRasterResult,
  OutlineComputeRasterRequest,
} from "./types";

const REQUIRED_STORAGE_BUFFERS = 3;
const WORKGROUP_WIDTH = 8;
const WORKGROUP_HEIGHT = 8;
const GLYPH_META_BYTES = 96;

interface PlannedRequest {
  readonly request: Readonly<OutlineComputeRasterRequest>;
  readonly entry: Readonly<OutlineColorAtlasEntry>;
  readonly color: OutlineColor;
}

interface RasterPlan {
  readonly width: number;
  readonly height: number;
  readonly maxEntryWidth: number;
  readonly maxEntryHeight: number;
  readonly requests: readonly Readonly<PlannedRequest>[];
}

export function inspectOutlineComputeCapability(
  device: GPUDevice | undefined,
): Readonly<OutlineComputeCapability> {
  if (device === undefined) {
    return Object.freeze({ status: "unsupported", reason: "webgpu-unavailable" });
  }
  const limits = device.limits;
  if (
    limits.maxStorageBuffersPerShaderStage < REQUIRED_STORAGE_BUFFERS ||
    limits.maxComputeInvocationsPerWorkgroup < WORKGROUP_WIDTH * WORKGROUP_HEIGHT ||
    limits.maxComputeWorkgroupSizeX < WORKGROUP_WIDTH ||
    limits.maxComputeWorkgroupSizeY < WORKGROUP_HEIGHT ||
    limits.maxComputeWorkgroupsPerDimension < 1 ||
    Number(limits.maxStorageBufferBindingSize) < GLYPH_META_BYTES ||
    limits.maxTextureDimension2D < 1
  ) {
    return Object.freeze({ status: "unsupported", reason: "device-limits" });
  }
  return Object.freeze({
    status: "supported",
    maxTextureDimension2D: limits.maxTextureDimension2D,
    maxStorageBufferBindingSize: Number(limits.maxStorageBufferBindingSize),
    maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension,
  });
}

export function createOutlineComputeRasterizer(
  device: GPUDevice | undefined,
): OutlineComputeRasterizer {
  const capability = inspectOutlineComputeCapability(device);
  if (capability.status === "unsupported") return new UnsupportedRasterizer(capability);
  if (device === undefined) throw new TypeError("a supported outline rasterizer requires a device");
  return new WebGpuOutlineRasterizer(device, capability);
}

class UnsupportedRasterizer implements OutlineComputeRasterizer {
  readonly capability: Readonly<Extract<OutlineComputeCapability, { status: "unsupported" }>>;

  constructor(capability: Readonly<Extract<OutlineComputeCapability, { status: "unsupported" }>>) {
    this.capability = capability;
  }

  async rasterize(
    _requests: readonly Readonly<OutlineComputeRasterRequest>[],
  ): Promise<Readonly<OutlineComputeRasterResult>> {
    return Object.freeze({ status: "unsupported", capability: this.capability });
  }

  destroy(): void {}
}

class WebGpuOutlineRasterizer implements OutlineComputeRasterizer {
  readonly capability: Readonly<Extract<OutlineComputeCapability, { status: "supported" }>>;
  private readonly device: GPUDevice;
  private pipelinePromise: Promise<GPUComputePipeline> | undefined;
  private lifecycleEpoch = 0;
  private destroyed = false;

  constructor(
    device: GPUDevice,
    capability: Readonly<Extract<OutlineComputeCapability, { status: "supported" }>>,
  ) {
    this.device = device;
    this.capability = capability;
  }

  async rasterize(
    requests: readonly Readonly<OutlineComputeRasterRequest>[],
  ): Promise<Readonly<OutlineComputeRasterResult>> {
    if (this.destroyed) {
      return destroyedFailure();
    }
    const lifecycleEpoch = this.lifecycleEpoch;
    if (requests.length === 0) {
      return Object.freeze({ status: "empty", entries: Object.freeze([] as const) });
    }
    if (requests.length > this.capability.maxComputeWorkgroupsPerDimension) {
      return unsupportedResult("device-limits");
    }

    const plan = planRaster(requests, this.capability.maxTextureDimension2D);
    if (plan === undefined) return unsupportedResult("atlas-too-large");
    if (
      Math.ceil(plan.maxEntryWidth / WORKGROUP_WIDTH) >
        this.capability.maxComputeWorkgroupsPerDimension ||
      Math.ceil(plan.maxEntryHeight / WORKGROUP_HEIGHT) >
        this.capability.maxComputeWorkgroupsPerDimension
    ) {
      return unsupportedResult("device-limits");
    }
    if (!storageFits(plan, this.capability.maxStorageBufferBindingSize)) {
      return unsupportedResult("device-limits");
    }

    let pipeline: GPUComputePipeline;
    try {
      pipeline = await this.getPipeline();
    } catch (error: unknown) {
      if (!this.isCurrent(lifecycleEpoch)) return destroyedFailure();
      return failure("shader-compilation", error);
    }
    if (!this.isCurrent(lifecycleEpoch)) return destroyedFailure();

    const storage = buildStorage(plan);
    if (
      storage.metadata.byteLength > this.capability.maxStorageBufferBindingSize ||
      storage.curves.byteLength > this.capability.maxStorageBufferBindingSize ||
      storage.spatial.byteLength > this.capability.maxStorageBufferBindingSize
    ) {
      return unsupportedResult("device-limits");
    }

    const buffers: GPUBuffer[] = [];
    let texture: GPUTexture | undefined;
    let errorScopeOpen = false;
    let validation: Promise<GPUError | null> | undefined;
    let completion: "ready" | "device-error" | "destroyed" = "device-error";
    let primaryError: unknown;
    try {
      this.device.pushErrorScope("validation");
      errorScopeOpen = true;
      const metadataBuffer = uploadStorage(this.device, storage.metadata, "outline glyph metadata");
      buffers.push(metadataBuffer);
      const curveBuffer = uploadStorage(this.device, storage.curves, "outline quadratic curves");
      buffers.push(curveBuffer);
      const spatialBuffer = uploadStorage(this.device, storage.spatial, "outline spatial lookup");
      buffers.push(spatialBuffer);
      texture = this.device.createTexture({
        label: "pixi-glyphflow outline color atlas",
        size: { width: plan.width, height: plan.height },
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      });
      const bindGroup = this.device.createBindGroup({
        label: "pixi-glyphflow outline compute bindings",
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: metadataBuffer } },
          { binding: 1, resource: { buffer: curveBuffer } },
          { binding: 2, resource: { buffer: spatialBuffer } },
          { binding: 3, resource: texture.createView() },
        ],
      });
      const encoder = this.device.createCommandEncoder({
        label: "pixi-glyphflow outline compute encoder",
      });
      const pass = encoder.beginComputePass({ label: "pixi-glyphflow outline compute pass" });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(
        Math.ceil(plan.maxEntryWidth / WORKGROUP_WIDTH),
        Math.ceil(plan.maxEntryHeight / WORKGROUP_HEIGHT),
        plan.requests.length,
      );
      pass.end();
      this.device.queue.submit([encoder.finish()]);
      errorScopeOpen = false;
      validation = this.device.popErrorScope();
      await this.device.queue.onSubmittedWorkDone();
      const poppedValidation = validation;
      validation = undefined;
      const validationError = await poppedValidation;
      if (!this.isCurrent(lifecycleEpoch)) completion = "destroyed";
      else if (validationError !== null) {
        completion = "device-error";
        primaryError = validationError;
      } else completion = "ready";
    } catch (error: unknown) {
      if (errorScopeOpen) {
        errorScopeOpen = false;
        try {
          await this.device.popErrorScope();
        } catch {
          // Preserve the primary failure while balancing the validation scope when possible.
        }
      }
      if (validation !== undefined) {
        const pendingValidation = validation;
        validation = undefined;
        try {
          await pendingValidation;
        } catch {
          // The device operation remains the primary failure.
        }
      }
      if (!this.isCurrent(lifecycleEpoch)) completion = "destroyed";
      else {
        completion = "device-error";
        primaryError = error;
      }
    }

    const ownedTexture = texture;
    texture = undefined;
    const ownedBuffers = buffers.splice(0);
    const bufferCleanupFailure = cleanupBestEffort(
      ownedBuffers.map((buffer) => () => buffer.destroy()),
    );
    if (
      completion === "ready" &&
      bufferCleanupFailure === undefined &&
      ownedTexture !== undefined
    ) {
      return Object.freeze({
        status: "ready",
        atlas: new GpuOutlineColorAtlas(
          ownedTexture,
          plan.width,
          plan.height,
          plan.requests.map((request) => request.entry),
        ),
      });
    }

    const textureCleanupFailure = cleanupBestEffort([
      () => {
        ownedTexture?.destroy();
      },
    ]);
    if (completion === "destroyed") return destroyedFailure();
    return failure(
      "device-error",
      primaryError ??
        bufferCleanupFailure?.error ??
        textureCleanupFailure?.error ??
        new Error("outline compute completed without an atlas texture"),
    );
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.lifecycleEpoch += 1;
    this.pipelinePromise = undefined;
  }

  private getPipeline(): Promise<GPUComputePipeline> {
    this.pipelinePromise ??= compilePipeline(this.device);
    return this.pipelinePromise;
  }

  private isCurrent(lifecycleEpoch: number): boolean {
    return !this.destroyed && this.lifecycleEpoch === lifecycleEpoch;
  }
}

class GpuOutlineColorAtlas implements OutlineColorAtlas {
  readonly texture: GPUTexture;
  readonly format = "rgba8unorm" as const;
  readonly width: number;
  readonly height: number;
  readonly entries: readonly Readonly<OutlineColorAtlasEntry>[];
  private destroyed = false;

  constructor(
    texture: GPUTexture,
    width: number,
    height: number,
    entries: readonly Readonly<OutlineColorAtlasEntry>[],
  ) {
    this.texture = texture;
    this.width = width;
    this.height = height;
    this.entries = Object.freeze(entries);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.texture.destroy();
  }
}

async function compilePipeline(device: GPUDevice): Promise<GPUComputePipeline> {
  const module = device.createShaderModule({
    label: "pixi-glyphflow outline compute shader",
    code: OUTLINE_COMPUTE_WGSL,
  });
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter((message) => message.type === "error");
  if (errors.length > 0) {
    throw new Error(errors.map((message) => message.message).join("\n"));
  }
  return device.createComputePipelineAsync({
    label: "pixi-glyphflow outline compute pipeline",
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
}

function planRaster(
  requests: readonly Readonly<OutlineComputeRasterRequest>[],
  maxTextureDimension2D: number,
): Readonly<RasterPlan> | undefined {
  const geometries = requests.map((request) => resolveRasterGeometry(request.glyph, request));
  if (
    geometries.some(
      (geometry) =>
        geometry.width > maxTextureDimension2D || geometry.height > maxTextureDimension2D,
    )
  ) {
    return undefined;
  }

  const planned: PlannedRequest[] = [];
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let usedWidth = 0;
  let maxEntryWidth = 0;
  let maxEntryHeight = 0;
  requests.forEach((request, requestIndex) => {
    const geometry = geometries[requestIndex];
    if (geometry === undefined) throw new TypeError("outline raster geometry is unavailable");
    if (x > 0 && x + geometry.width > maxTextureDimension2D) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    if (y + geometry.height > maxTextureDimension2D) return;
    const entry = Object.freeze({
      requestIndex,
      x,
      y,
      width: geometry.width,
      height: geometry.height,
      contentWidth: geometry.width - geometry.padding * 2,
      contentHeight: geometry.height - geometry.padding * 2,
      padding: geometry.padding,
      scale: geometry.scale,
      quad: request.glyph.quad,
    });
    planned.push(Object.freeze({ request, entry, color: geometry.color }));
    x += geometry.width;
    rowHeight = Math.max(rowHeight, geometry.height);
    usedWidth = Math.max(usedWidth, x);
    maxEntryWidth = Math.max(maxEntryWidth, geometry.width);
    maxEntryHeight = Math.max(maxEntryHeight, geometry.height);
  });
  if (planned.length !== requests.length) return undefined;
  return Object.freeze({
    width: usedWidth,
    height: y + rowHeight,
    maxEntryWidth,
    maxEntryHeight,
    requests: Object.freeze(planned),
  });
}

interface BuiltStorage {
  readonly metadata: Uint8Array;
  readonly curves: Float32Array;
  readonly spatial: Int32Array;
}

function buildStorage(plan: Readonly<RasterPlan>): Readonly<BuiltStorage> {
  const curveWords = plan.requests.reduce(
    (total, planned) => total + planned.request.glyph.curveStorage.length,
    0,
  );
  const spatialWords = plan.requests.reduce(
    (total, planned) => total + planned.request.glyph.spatialLookup.length,
    0,
  );
  const metadata = new Uint8Array(plan.requests.length * GLYPH_META_BYTES);
  const metadataView = new DataView(metadata.buffer);
  const curves = new Float32Array(curveWords);
  const spatial = new Int32Array(spatialWords);
  let curveWordOffset = 0;
  let spatialWordOffset = 0;
  plan.requests.forEach((planned, requestIndex) => {
    const glyph = planned.request.glyph;
    curves.set(glyph.curveStorage, curveWordOffset);
    spatial.set(glyph.spatialLookup, spatialWordOffset);
    const entry = planned.entry;
    const base = requestIndex * GLYPH_META_BYTES;
    writeU32x4(metadataView, base, entry.x, entry.y, entry.width, entry.height);
    writeU32x4(
      metadataView,
      base + 16,
      entry.padding,
      entry.contentWidth,
      entry.contentHeight,
      requestIndex,
    );
    writeU32x4(
      metadataView,
      base + 32,
      spatialWordOffset,
      glyph.horizontalBandCount,
      glyph.verticalBandCount,
      curveWordOffset / 8,
    );
    writeF32x4(
      metadataView,
      base + 48,
      glyph.quad.minX,
      glyph.quad.minY,
      glyph.quad.maxX,
      glyph.quad.maxY,
    );
    writeF32x4(metadataView, base + 64, entry.scale, 0, 0, 0);
    writeF32x4(
      metadataView,
      base + 80,
      planned.color[0],
      planned.color[1],
      planned.color[2],
      planned.color[3],
    );
    curveWordOffset += glyph.curveStorage.length;
    spatialWordOffset += glyph.spatialLookup.length;
  });
  return Object.freeze({ metadata, curves, spatial });
}

function storageFits(plan: Readonly<RasterPlan>, maxBindingBytes: number): boolean {
  if (plan.requests.length > Math.floor(maxBindingBytes / GLYPH_META_BYTES)) return false;
  const maxWords = Math.floor(maxBindingBytes / Uint32Array.BYTES_PER_ELEMENT);
  let curveWords = 0;
  let spatialWords = 0;
  for (const planned of plan.requests) {
    const glyph = planned.request.glyph;
    if (
      glyph.curveStorage.length > maxWords - curveWords ||
      glyph.spatialLookup.length > maxWords - spatialWords
    ) {
      return false;
    }
    curveWords += glyph.curveStorage.length;
    spatialWords += glyph.spatialLookup.length;
  }
  return true;
}

function uploadStorage(
  device: GPUDevice,
  data: Uint8Array | Float32Array | Int32Array,
  label: string,
): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: Math.max(4, alignTo(data.byteLength, 4)),
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  try {
    new Uint8Array(buffer.getMappedRange()).set(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
    buffer.unmap();
    return buffer;
  } catch (error: unknown) {
    cleanupBestEffort([() => buffer.destroy()]);
    throw error;
  }
}

function writeU32x4(
  view: DataView,
  offset: number,
  first: number,
  second: number,
  third: number,
  fourth: number,
): void {
  view.setUint32(offset, first, true);
  view.setUint32(offset + 4, second, true);
  view.setUint32(offset + 8, third, true);
  view.setUint32(offset + 12, fourth, true);
}

function writeF32x4(
  view: DataView,
  offset: number,
  first: number,
  second: number,
  third: number,
  fourth: number,
): void {
  view.setFloat32(offset, first, true);
  view.setFloat32(offset + 4, second, true);
  view.setFloat32(offset + 8, third, true);
  view.setFloat32(offset + 12, fourth, true);
}

function alignTo(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function unsupportedResult(
  reason: "device-limits" | "atlas-too-large",
): Readonly<OutlineComputeRasterResult> {
  return Object.freeze({
    status: "unsupported",
    capability: Object.freeze({ status: "unsupported", reason }),
  });
}

function failure(
  reason: "shader-compilation" | "device-error",
  error: unknown,
): Readonly<OutlineComputeRasterResult> {
  return Object.freeze({
    status: "failed",
    reason,
    message: error instanceof Error ? error.message : String(error),
  });
}

function destroyedFailure(): Readonly<OutlineComputeRasterResult> {
  return Object.freeze({
    status: "failed",
    reason: "destroyed",
    message: "outline compute rasterizer has been destroyed",
  });
}
