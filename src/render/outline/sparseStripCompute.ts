import { cleanupBestEffort } from "../cleanup";
import { normalizeOutlineColor } from "./helpers";
import { SPARSE_STRIP_COMPUTE_WGSL } from "./sparseStrip.wgsl";
import {
  SPARSE_STRIP_LAYOUT,
  validateSparseStripGlyph,
  type SparseStripGlyph,
} from "./sparseStrips";
import type {
  OutlineColor,
  OutlineColorAtlas,
  OutlineColorAtlasEntry,
  OutlineComputeCapability,
  OutlineComputeRasterResult,
  OutlineQuadMetadata,
} from "./types";

const REQUIRED_STORAGE_BUFFERS = 4;
const REQUIRED_UNIFORM_BUFFERS = 1;
const DISPATCH_UNIFORM_BYTES = 16;
const MAX_U32 = 0xffff_ffff;
const F32_BITS = new DataView(new ArrayBuffer(Float32Array.BYTES_PER_ELEMENT));

const sparseStripComputeLayout = {
  glyphWords: 32,
  workgroupWidth: 8,
  workgroupHeight: 8,
  metadata: {
    atlasX: 12,
    atlasY: 13,
    rowOffset: 14,
    recordWordOffset: 15,
    coverageByteOffset: 16,
    requestIndex: 17,
    colorR: 18,
    colorG: 19,
    colorB: 20,
    colorA: 21,
    padding: 22,
    contentWidth: 23,
    contentHeight: 24,
    scale: 25,
    quadMinX: 26,
    quadMinY: 27,
    quadMaxX: 28,
    quadMaxY: 29,
  },
} as const;

export type SparseStripComputeLayout = typeof sparseStripComputeLayout;

Object.freeze(sparseStripComputeLayout.metadata);
export const SPARSE_STRIP_COMPUTE_LAYOUT: SparseStripComputeLayout =
  Object.freeze(sparseStripComputeLayout);

const GLYPH_WORDS = SPARSE_STRIP_COMPUTE_LAYOUT.glyphWords;
const WORKGROUP_WIDTH = SPARSE_STRIP_COMPUTE_LAYOUT.workgroupWidth;
const WORKGROUP_HEIGHT = SPARSE_STRIP_COMPUTE_LAYOUT.workgroupHeight;
const GLYPH_BYTES = GLYPH_WORDS * Uint32Array.BYTES_PER_ELEMENT;

const {
  atlasX: META_ATLAS_X,
  atlasY: META_ATLAS_Y,
  rowOffset: META_ROW_OFFSET,
  recordWordOffset: META_RECORD_WORD_OFFSET,
  coverageByteOffset: META_COVERAGE_BYTE_OFFSET,
  requestIndex: META_REQUEST_INDEX,
  colorR: META_COLOR_R,
  colorG: META_COLOR_G,
  colorB: META_COLOR_B,
  colorA: META_COLOR_A,
  padding: META_PADDING,
  contentWidth: META_CONTENT_WIDTH,
  contentHeight: META_CONTENT_HEIGHT,
  scale: META_SCALE,
  quadMinX: META_QUAD_MIN_X,
  quadMinY: META_QUAD_MIN_Y,
  quadMaxX: META_QUAD_MAX_X,
  quadMaxY: META_QUAD_MAX_Y,
} = SPARSE_STRIP_COMPUTE_LAYOUT.metadata;

const META_RESERVED_0 = 30;
const META_RESERVED_1 = 31;

export interface SparseStripAtlasPlacement {
  readonly x: number;
  readonly y: number;
  readonly padding: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly scale: number;
  readonly quad: Readonly<OutlineQuadMetadata>;
}

export interface SparseStripComputeRequest {
  readonly glyph: Readonly<SparseStripGlyph>;
  readonly color: OutlineColor;
  readonly placement: Readonly<SparseStripAtlasPlacement>;
}

export interface SparseStripComputeBatch {
  readonly width: number;
  readonly height: number;
  readonly requests: readonly Readonly<SparseStripComputeRequest>[];
}

export interface PackedSparseStripComputeBatch {
  readonly width: number;
  readonly height: number;
  readonly maxEntryWidth: number;
  readonly maxEntryHeight: number;
  /** Original v1 header occupies words 0..11; adapter metadata occupies words 12..31. */
  readonly glyphs: Uint32Array;
  /** Per-glyph, tile-row prefix indices into that glyph's strip records. */
  readonly rows: Uint32Array;
  /** Concatenated four-word v1 strip records. */
  readonly strips: Uint32Array;
  /** Concatenated little-endian coverage bytes packed four per u32. */
  readonly coverage: Uint32Array;
  readonly coverageByteLength: number;
  readonly dispatches: readonly Readonly<SparseStripComputeDispatch>[];
  readonly stats: Readonly<SparseStripComputePackingStats>;
  readonly entries: readonly Readonly<OutlineColorAtlasEntry>[];
}

export interface SparseStripComputeDispatch {
  readonly glyphBase: number;
  readonly glyphCount: number;
  readonly workgroupsX: number;
  readonly workgroupsY: number;
  readonly invocationCount: number;
  readonly effectivePixelCount: number;
}

export interface SparseStripComputePackingStats {
  readonly overlapValidationOperations: number;
  readonly dispatchInvocationCount: number;
  readonly effectivePixelCount: number;
}

export interface SparseStripComputePackingCounts {
  readonly requestCount: number;
  readonly rowWordCount: number;
  readonly stripWordCount: number;
  readonly coverageByteLength: number;
}

export interface SparseStripComputePackingPreflight extends SparseStripComputePackingCounts {
  readonly glyphWordCount: number;
  readonly coverageWordCount: number;
  readonly glyphByteLength: number;
  readonly rowByteLength: number;
  readonly stripByteLength: number;
  readonly coverageBufferByteLength: number;
}

export interface SparseStripComputeRasterizer {
  readonly capability: Readonly<OutlineComputeCapability>;
  rasterize(
    batch: Readonly<SparseStripComputeBatch>,
  ): Promise<Readonly<OutlineComputeRasterResult>>;
  destroy(): void;
}

interface PlannedRequest {
  readonly requestIndex: number;
  readonly glyph: Readonly<SparseStripGlyph>;
  readonly entry: Readonly<OutlineColorAtlasEntry>;
  readonly color: OutlineColor;
}

interface PlannedDispatchGroup {
  readonly workgroupsX: number;
  readonly workgroupsY: number;
  readonly requests: readonly Readonly<PlannedRequest>[];
}

interface SparseStripComputePlan {
  readonly width: number;
  readonly height: number;
  readonly maxEntryWidth: number;
  readonly maxEntryHeight: number;
  readonly requests: readonly Readonly<PlannedRequest>[];
  readonly packing: Readonly<SparseStripComputePackingPreflight>;
  readonly dispatchGroups: readonly Readonly<PlannedDispatchGroup>[];
  readonly overlapValidationOperations: number;
}

export function inspectSparseStripComputeCapability(
  device: GPUDevice | undefined,
): Readonly<OutlineComputeCapability> {
  if (device === undefined) {
    return Object.freeze({ status: "unsupported", reason: "webgpu-unavailable" });
  }
  const limits = device.limits;
  const maxStorageBufferBindingSize = Number(limits.maxStorageBufferBindingSize);
  const maxUniformBufferBindingSize = Number(limits.maxUniformBufferBindingSize);
  const maxBufferSize = Number(limits.maxBufferSize);
  if (
    limits.maxStorageBuffersPerShaderStage < REQUIRED_STORAGE_BUFFERS ||
    limits.maxUniformBuffersPerShaderStage < REQUIRED_UNIFORM_BUFFERS ||
    limits.maxComputeInvocationsPerWorkgroup < WORKGROUP_WIDTH * WORKGROUP_HEIGHT ||
    limits.maxComputeWorkgroupSizeX < WORKGROUP_WIDTH ||
    limits.maxComputeWorkgroupSizeY < WORKGROUP_HEIGHT ||
    limits.maxComputeWorkgroupsPerDimension < 1 ||
    !Number.isSafeInteger(maxStorageBufferBindingSize) ||
    maxStorageBufferBindingSize < GLYPH_BYTES ||
    !Number.isSafeInteger(maxUniformBufferBindingSize) ||
    maxUniformBufferBindingSize < DISPATCH_UNIFORM_BYTES ||
    !Number.isSafeInteger(maxBufferSize) ||
    maxBufferSize < GLYPH_BYTES ||
    !Number.isSafeInteger(limits.minUniformBufferOffsetAlignment) ||
    limits.minUniformBufferOffsetAlignment < 1 ||
    !Number.isSafeInteger(limits.maxTextureDimension2D) ||
    limits.maxTextureDimension2D < 1
  ) {
    return Object.freeze({ status: "unsupported", reason: "device-limits" });
  }
  return Object.freeze({
    status: "supported",
    maxTextureDimension2D: limits.maxTextureDimension2D,
    maxStorageBufferBindingSize,
    maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension,
  });
}

export function createSparseStripComputeRasterizer(
  device: GPUDevice | undefined,
): SparseStripComputeRasterizer {
  const capability = inspectSparseStripComputeCapability(device);
  if (capability.status === "unsupported") return new UnsupportedRasterizer(capability);
  if (device === undefined)
    throw new TypeError("a supported sparse strip rasterizer requires a device");
  return new WebGpuSparseStripRasterizer(device, capability);
}

/** Build the exact storage payload consumed by `SPARSE_STRIP_COMPUTE_WGSL`. */
export function packSparseStripComputeBatch(
  batch: Readonly<SparseStripComputeBatch>,
): Readonly<PackedSparseStripComputeBatch> {
  return packPlan(planBatch(batch));
}

/** Validate every count used by u32 metadata and typed-array allocation. */
export function preflightSparseStripComputePacking(
  counts: Readonly<SparseStripComputePackingCounts>,
): Readonly<SparseStripComputePackingPreflight> {
  assertUint32("request count", counts.requestCount);
  assertUint32("row word count", counts.rowWordCount);
  assertUint32("strip word count", counts.stripWordCount);
  assertUint32("coverage byte length", counts.coverageByteLength);
  const glyphWordCount = checkedUint32Multiply(
    "glyph word count",
    counts.requestCount,
    GLYPH_WORDS,
  );
  const coverageBufferByteLength = checkedUint32Align(
    "coverage buffer byte length",
    counts.coverageByteLength,
    Uint32Array.BYTES_PER_ELEMENT,
  );
  const coverageWordCount = coverageBufferByteLength / Uint32Array.BYTES_PER_ELEMENT;
  return Object.freeze({
    ...counts,
    glyphWordCount,
    coverageWordCount,
    glyphByteLength: checkedSafeMultiply(
      "glyph byte length",
      glyphWordCount,
      Uint32Array.BYTES_PER_ELEMENT,
    ),
    rowByteLength: checkedSafeMultiply(
      "row byte length",
      counts.rowWordCount,
      Uint32Array.BYTES_PER_ELEMENT,
    ),
    stripByteLength: checkedSafeMultiply(
      "strip byte length",
      counts.stripWordCount,
      Uint32Array.BYTES_PER_ELEMENT,
    ),
    coverageBufferByteLength,
  });
}

class UnsupportedRasterizer implements SparseStripComputeRasterizer {
  readonly capability: Readonly<Extract<OutlineComputeCapability, { status: "unsupported" }>>;

  constructor(capability: Readonly<Extract<OutlineComputeCapability, { status: "unsupported" }>>) {
    this.capability = capability;
  }

  async rasterize(
    _batch: Readonly<SparseStripComputeBatch>,
  ): Promise<Readonly<OutlineComputeRasterResult>> {
    return Object.freeze({ status: "unsupported", capability: this.capability });
  }

  destroy(): void {}
}

class WebGpuSparseStripRasterizer implements SparseStripComputeRasterizer {
  readonly capability: Readonly<Extract<OutlineComputeCapability, { status: "supported" }>>;
  private readonly device: GPUDevice;
  private readonly maxBufferSize: number;
  private readonly uniformOffsetAlignment: number;
  private pipelinePromise: Promise<GPUComputePipeline> | undefined;
  private lifecycleEpoch = 0;
  private destroyed = false;

  constructor(
    device: GPUDevice,
    capability: Readonly<Extract<OutlineComputeCapability, { status: "supported" }>>,
  ) {
    this.device = device;
    this.capability = capability;
    this.maxBufferSize = Number(device.limits.maxBufferSize);
    this.uniformOffsetAlignment = device.limits.minUniformBufferOffsetAlignment;
  }

  async rasterize(
    batch: Readonly<SparseStripComputeBatch>,
  ): Promise<Readonly<OutlineComputeRasterResult>> {
    if (this.destroyed) return destroyedFailure();
    assertBatchObject(batch);
    const lifecycleEpoch = this.lifecycleEpoch;
    if (batch.requests.length === 0) {
      return Object.freeze({ status: "empty", entries: Object.freeze([] as const) });
    }
    const plan = planBatch(batch);
    if (
      plan.width > this.capability.maxTextureDimension2D ||
      plan.height > this.capability.maxTextureDimension2D
    ) {
      return unsupportedResult("atlas-too-large");
    }
    if (
      plan.dispatchGroups.some(
        (dispatch) =>
          dispatch.workgroupsX > this.capability.maxComputeWorkgroupsPerDimension ||
          dispatch.workgroupsY > this.capability.maxComputeWorkgroupsPerDimension ||
          dispatch.requests.length > this.capability.maxComputeWorkgroupsPerDimension,
      ) ||
      !storageFits(plan.packing, this.capability.maxStorageBufferBindingSize, this.maxBufferSize)
    ) {
      return unsupportedResult("device-limits");
    }

    const dispatchUniformLayout = preflightDispatchUniforms(
      plan.dispatchGroups.length,
      this.uniformOffsetAlignment,
      this.maxBufferSize,
    );
    if (dispatchUniformLayout === undefined) return unsupportedResult("device-limits");
    const storage = packPlan(plan);
    const dispatchUniforms = packDispatchUniforms(storage.dispatches, dispatchUniformLayout);

    let pipeline: GPUComputePipeline;
    try {
      pipeline = await this.getPipeline();
    } catch (error: unknown) {
      if (!this.isCurrent(lifecycleEpoch)) return destroyedFailure();
      return failure("shader-compilation", error);
    }
    if (!this.isCurrent(lifecycleEpoch)) return destroyedFailure();

    const buffers: GPUBuffer[] = [];
    let texture: GPUTexture | undefined;
    let errorScopeOpen = false;
    let validation: Promise<GPUError | null> | undefined;
    let completion: "ready" | "device-error" | "destroyed" = "device-error";
    let primaryError: unknown;
    try {
      this.device.pushErrorScope("validation");
      errorScopeOpen = true;
      const glyphBuffer = uploadStorage(this.device, storage.glyphs, "sparse strip glyph headers");
      buffers.push(glyphBuffer);
      const rowBuffer = uploadStorage(this.device, storage.rows, "sparse strip row index");
      buffers.push(rowBuffer);
      const stripBuffer = uploadStorage(this.device, storage.strips, "sparse strip records");
      buffers.push(stripBuffer);
      const coverageBuffer = uploadStorage(
        this.device,
        storage.coverage,
        "sparse strip boundary coverage",
      );
      buffers.push(coverageBuffer);
      const dispatchBuffer = uploadBuffer(
        this.device,
        dispatchUniforms.bytes,
        "sparse strip dispatch metadata",
        GPUBufferUsage.UNIFORM,
      );
      buffers.push(dispatchBuffer);
      texture = this.device.createTexture({
        label: "pixi-glyphflow sparse strip color atlas",
        size: { width: plan.width, height: plan.height },
        format: "rgba8unorm",
        usage:
          GPUTextureUsage.STORAGE_BINDING |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      });
      const textureView = texture.createView();
      const bindGroups = storage.dispatches.map((_, dispatchIndex) =>
        this.device.createBindGroup({
          label: `pixi-glyphflow sparse strip compute bindings ${String(dispatchIndex)}`,
          layout: pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: glyphBuffer } },
            { binding: 1, resource: { buffer: rowBuffer } },
            { binding: 2, resource: { buffer: stripBuffer } },
            { binding: 3, resource: { buffer: coverageBuffer } },
            { binding: 4, resource: textureView },
            {
              binding: 5,
              resource: {
                buffer: dispatchBuffer,
                offset: checkedUint32Multiply(
                  "dispatch uniform binding offset",
                  dispatchIndex,
                  dispatchUniforms.stride,
                ),
                size: DISPATCH_UNIFORM_BYTES,
              },
            },
          ],
        }),
      );
      const encoder = this.device.createCommandEncoder({
        label: "pixi-glyphflow sparse strip compute encoder",
      });
      const pass = encoder.beginComputePass({
        label: "pixi-glyphflow sparse strip compute pass",
      });
      pass.setPipeline(pipeline);
      storage.dispatches.forEach((dispatch, dispatchIndex) => {
        const bindGroup = bindGroups[dispatchIndex];
        if (bindGroup === undefined)
          throw new Error("sparse strip dispatch binding is unavailable");
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(dispatch.workgroupsX, dispatch.workgroupsY, dispatch.glyphCount);
      });
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
          // Balance the scope while the primary device failure remains authoritative.
        }
      }
      if (validation !== undefined) {
        const pendingValidation = validation;
        validation = undefined;
        try {
          await pendingValidation;
        } catch {
          // Preserve the queue or device operation as the primary failure.
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
        atlas: new SparseStripColorAtlas(ownedTexture, plan.width, plan.height, storage.entries),
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
        new Error("sparse strip compute completed without an atlas texture"),
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

class SparseStripColorAtlas implements OutlineColorAtlas {
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
    this.entries = entries;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.texture.destroy();
  }
}

async function compilePipeline(device: GPUDevice): Promise<GPUComputePipeline> {
  const module = device.createShaderModule({
    label: "pixi-glyphflow sparse strip compute shader",
    code: SPARSE_STRIP_COMPUTE_WGSL,
  });
  const compilation = await module.getCompilationInfo();
  const errors = compilation.messages.filter((message) => message.type === "error");
  if (errors.length > 0) throw new Error(errors.map((message) => message.message).join("\n"));
  return device.createComputePipelineAsync({
    label: "pixi-glyphflow sparse strip compute pipeline",
    layout: "auto",
    compute: { module, entryPoint: "main" },
  });
}

function planBatch(batch: Readonly<SparseStripComputeBatch>): Readonly<SparseStripComputePlan> {
  assertBatchObject(batch);
  assertPositiveUint32("atlas width", batch.width);
  assertPositiveUint32("atlas height", batch.height);
  if (batch.requests.length === 0) throw new TypeError("sparse strip batch must contain a request");
  assertUint32("request count", batch.requests.length);

  const planned: PlannedRequest[] = [];
  let maxEntryWidth = 0;
  let maxEntryHeight = 0;
  batch.requests.forEach((request, requestIndex) => {
    assertRequest(request, requestIndex, batch.width, batch.height);
    const color = normalizeOutlineColor(
      request.color,
      "sparse strip color must contain four finite channels",
    );
    const placement = request.placement;
    const glyph = request.glyph;
    const quad = copyQuad(placement.quad);
    const entry: Readonly<OutlineColorAtlasEntry> = Object.freeze({
      requestIndex,
      x: placement.x,
      y: placement.y,
      width: glyph.width,
      height: glyph.height,
      contentWidth: placement.contentWidth,
      contentHeight: placement.contentHeight,
      padding: placement.padding,
      scale: placement.scale,
      quad,
    });
    planned.push(Object.freeze({ requestIndex, glyph, entry, color }));
    maxEntryWidth = Math.max(maxEntryWidth, glyph.width);
    maxEntryHeight = Math.max(maxEntryHeight, glyph.height);
  });
  const overlapValidationOperations = assertDisjointPlacements(
    planned.map((request) => request.entry),
  );
  const packing = preflightPlanPacking(planned);
  const dispatchGroups = groupDispatches(planned);
  return Object.freeze({
    width: batch.width,
    height: batch.height,
    maxEntryWidth,
    maxEntryHeight,
    requests: Object.freeze(planned),
    packing,
    dispatchGroups,
    overlapValidationOperations,
  });
}

function preflightPlanPacking(
  requests: readonly Readonly<PlannedRequest>[],
): Readonly<SparseStripComputePackingPreflight> {
  let rowWordCount = 0;
  let stripWordCount = 0;
  let coverageByteLength = 0;
  for (const request of requests) {
    rowWordCount = checkedUint32Add(
      "row word count",
      rowWordCount,
      checkedUint32Add("glyph row span", request.glyph.tileRows, 1),
    );
    stripWordCount = checkedUint32Add(
      "strip word count",
      stripWordCount,
      request.glyph.strips.length,
    );
    coverageByteLength = checkedUint32Add(
      "coverage byte length",
      coverageByteLength,
      request.glyph.coverage.byteLength,
    );
  }
  return preflightSparseStripComputePacking({
    requestCount: requests.length,
    rowWordCount,
    stripWordCount,
    coverageByteLength,
  });
}

function groupDispatches(
  requests: readonly Readonly<PlannedRequest>[],
): readonly Readonly<PlannedDispatchGroup>[] {
  const groups = new Map<string, PlannedRequest[]>();
  const dimensions = new Map<string, readonly [number, number]>();
  for (const request of requests) {
    const workgroupsX = Math.ceil(request.glyph.width / WORKGROUP_WIDTH);
    const workgroupsY = Math.ceil(request.glyph.height / WORKGROUP_HEIGHT);
    const key = `${String(workgroupsX)}:${String(workgroupsY)}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = [];
      groups.set(key, group);
      dimensions.set(key, Object.freeze([workgroupsX, workgroupsY] as const));
    }
    group.push(request);
  }
  return Object.freeze(
    [...groups].map(([key, requestsInGroup]) => {
      const dimension = dimensions.get(key);
      if (dimension === undefined) throw new Error("sparse strip dispatch dimensions are missing");
      return Object.freeze({
        workgroupsX: dimension[0],
        workgroupsY: dimension[1],
        requests: Object.freeze(requestsInGroup),
      });
    }),
  );
}

interface PackedDispatchUniforms {
  readonly bytes: Uint8Array;
  readonly stride: number;
}

interface DispatchUniformLayout {
  readonly byteLength: number;
  readonly stride: number;
}

function preflightDispatchUniforms(
  dispatchCount: number,
  alignment: number,
  maxBufferSize: number,
): Readonly<DispatchUniformLayout> | undefined {
  assertUint32("dispatch count", dispatchCount);
  assertPositiveSafeInteger("uniform offset alignment", alignment);
  const stride = checkedUint32Align("dispatch uniform stride", DISPATCH_UNIFORM_BYTES, alignment);
  if (
    !Number.isSafeInteger(maxBufferSize) ||
    maxBufferSize < DISPATCH_UNIFORM_BYTES ||
    dispatchCount > Math.floor(Math.min(MAX_U32, maxBufferSize) / stride)
  ) {
    return undefined;
  }
  return Object.freeze({
    byteLength: checkedUint32Multiply("dispatch uniform allocation", stride, dispatchCount),
    stride,
  });
}

function packDispatchUniforms(
  dispatches: readonly Readonly<SparseStripComputeDispatch>[],
  layout: Readonly<DispatchUniformLayout>,
): Readonly<PackedDispatchUniforms> {
  const bytes = new Uint8Array(layout.byteLength);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  dispatches.forEach((dispatch, dispatchIndex) => {
    const offset = checkedUint32Multiply("dispatch uniform offset", dispatchIndex, layout.stride);
    view.setUint32(offset, dispatch.glyphBase, true);
    view.setUint32(offset + 4, dispatch.glyphCount, true);
  });
  return Object.freeze({ bytes, stride: layout.stride });
}

interface PlacementSweepEvent {
  readonly x: number;
  readonly yStart: number;
  readonly yEnd: number;
  readonly delta: -1 | 1;
  readonly requestIndex: number;
}

function assertDisjointPlacements(entries: readonly Readonly<OutlineColorAtlasEntry>[]): number {
  let operations = 0;
  const yCoordinates: number[] = [];
  for (const entry of entries) {
    yCoordinates.push(entry.y, checkedSafeAdd("placement bottom", entry.y, entry.height));
    operations += 2;
  }
  yCoordinates.sort((first, second) => {
    operations += 1;
    return first - second;
  });
  const uniqueY: number[] = [];
  for (const coordinate of yCoordinates) {
    operations += 1;
    if (coordinate !== uniqueY[uniqueY.length - 1]) uniqueY.push(coordinate);
  }
  const coordinateIndex = new Map<number, number>();
  uniqueY.forEach((coordinate, index) => coordinateIndex.set(coordinate, index));

  const events: PlacementSweepEvent[] = [];
  for (const entry of entries) {
    const yStart = coordinateIndex.get(entry.y);
    const yEnd = coordinateIndex.get(checkedSafeAdd("placement bottom", entry.y, entry.height));
    if (yStart === undefined || yEnd === undefined || yStart >= yEnd) {
      throw new Error("sparse strip placement sweep coordinates are invalid");
    }
    const right = checkedSafeAdd("placement right", entry.x, entry.width);
    events.push(
      Object.freeze({ x: entry.x, yStart, yEnd, delta: 1, requestIndex: entry.requestIndex }),
      Object.freeze({ x: right, yStart, yEnd, delta: -1, requestIndex: entry.requestIndex }),
    );
    operations += 2;
  }
  events.sort((first, second) => {
    operations += 1;
    return (
      first.x - second.x || first.delta - second.delta || first.requestIndex - second.requestIndex
    );
  });

  const tree = new RangeAddMaxTree(uniqueY.length - 1);
  for (const event of events) {
    if (event.delta === 1 && tree.maximum(event.yStart, event.yEnd) > 0) {
      throw new TypeError("sparse strip atlas placements must be disjoint");
    }
    tree.add(event.yStart, event.yEnd, event.delta);
  }
  return checkedSafeAdd("overlap validation operations", operations, tree.operations);
}

class RangeAddMaxTree {
  private readonly segmentCount: number;
  private readonly maximums: Int32Array;
  private readonly lazy: Int32Array;
  private operationCount = 0;

  constructor(segmentCount: number) {
    assertPositiveSafeInteger("placement sweep segment count", segmentCount);
    const treeLength = checkedUint32Multiply("placement sweep tree allocation", segmentCount, 4);
    this.segmentCount = segmentCount;
    this.maximums = new Int32Array(treeLength);
    this.lazy = new Int32Array(treeLength);
  }

  get operations(): number {
    return this.operationCount;
  }

  maximum(queryStart: number, queryEnd: number): number {
    return this.query(1, 0, this.segmentCount, queryStart, queryEnd);
  }

  add(queryStart: number, queryEnd: number, delta: -1 | 1): void {
    this.update(1, 0, this.segmentCount, queryStart, queryEnd, delta);
  }

  private query(
    node: number,
    start: number,
    end: number,
    queryStart: number,
    queryEnd: number,
  ): number {
    this.operationCount += 1;
    if (queryStart <= start && end <= queryEnd) return this.maximums[node] ?? 0;
    const middle = Math.floor((start + end) / 2);
    let maximum = 0;
    if (queryStart < middle) {
      maximum = this.query(node * 2, start, middle, queryStart, queryEnd);
    }
    if (queryEnd > middle) {
      maximum = Math.max(maximum, this.query(node * 2 + 1, middle, end, queryStart, queryEnd));
    }
    return (this.lazy[node] ?? 0) + maximum;
  }

  private update(
    node: number,
    start: number,
    end: number,
    queryStart: number,
    queryEnd: number,
    delta: -1 | 1,
  ): void {
    this.operationCount += 1;
    if (queryStart <= start && end <= queryEnd) {
      this.maximums[node] = (this.maximums[node] ?? 0) + delta;
      this.lazy[node] = (this.lazy[node] ?? 0) + delta;
      return;
    }
    const middle = Math.floor((start + end) / 2);
    if (queryStart < middle) this.update(node * 2, start, middle, queryStart, queryEnd, delta);
    if (queryEnd > middle) this.update(node * 2 + 1, middle, end, queryStart, queryEnd, delta);
    this.maximums[node] =
      (this.lazy[node] ?? 0) +
      Math.max(this.maximums[node * 2] ?? 0, this.maximums[node * 2 + 1] ?? 0);
  }
}

function packPlan(plan: Readonly<SparseStripComputePlan>): Readonly<PackedSparseStripComputeBatch> {
  const glyphs = new Uint32Array(plan.packing.glyphWordCount);
  const rows = new Uint32Array(plan.packing.rowWordCount);
  const strips = new Uint32Array(plan.packing.stripWordCount);
  const coverage = new Uint32Array(plan.packing.coverageWordCount);
  const dispatches: SparseStripComputeDispatch[] = [];
  let rowWordOffset = 0;
  let stripWordOffset = 0;
  let coverageByteOffset = 0;
  let packedGlyphIndex = 0;
  let dispatchInvocationCount = 0;
  let effectivePixelCount = 0;

  plan.dispatchGroups.forEach((group) => {
    const glyphBase = packedGlyphIndex;
    let groupEffectivePixelCount = 0;
    group.requests.forEach((planned) => {
      const glyph = planned.glyph;
      const base = checkedUint32Multiply("glyph metadata offset", packedGlyphIndex, GLYPH_WORDS);
      glyphs.set(glyph.header, base);
      glyphs[base + META_ATLAS_X] = planned.entry.x;
      glyphs[base + META_ATLAS_Y] = planned.entry.y;
      glyphs[base + META_ROW_OFFSET] = rowWordOffset;
      glyphs[base + META_RECORD_WORD_OFFSET] = stripWordOffset;
      glyphs[base + META_COVERAGE_BYTE_OFFSET] = coverageByteOffset;
      glyphs[base + META_REQUEST_INDEX] = planned.requestIndex;
      glyphs[base + META_COLOR_R] = f32ToU32(planned.color[0]);
      glyphs[base + META_COLOR_G] = f32ToU32(planned.color[1]);
      glyphs[base + META_COLOR_B] = f32ToU32(planned.color[2]);
      glyphs[base + META_COLOR_A] = f32ToU32(planned.color[3]);
      glyphs[base + META_PADDING] = planned.entry.padding;
      glyphs[base + META_CONTENT_WIDTH] = planned.entry.contentWidth;
      glyphs[base + META_CONTENT_HEIGHT] = planned.entry.contentHeight;
      glyphs[base + META_SCALE] = f32ToU32(planned.entry.scale);
      glyphs[base + META_QUAD_MIN_X] = f32ToU32(planned.entry.quad.minX);
      glyphs[base + META_QUAD_MIN_Y] = f32ToU32(planned.entry.quad.minY);
      glyphs[base + META_QUAD_MAX_X] = f32ToU32(planned.entry.quad.maxX);
      glyphs[base + META_QUAD_MAX_Y] = f32ToU32(planned.entry.quad.maxY);
      glyphs[base + META_RESERVED_0] = 0;
      glyphs[base + META_RESERVED_1] = 0;

      const recordCount = glyph.strips.length / SPARSE_STRIP_LAYOUT.recordWords;
      let recordIndex = 0;
      for (let tileY = 0; tileY < glyph.tileRows; tileY += 1) {
        rows[rowWordOffset + tileY] = recordIndex;
        while (recordIndex < recordCount) {
          const recordTileY =
            glyph.strips[
              recordIndex * SPARSE_STRIP_LAYOUT.recordWords + SPARSE_STRIP_LAYOUT.record.tileY
            ];
          if (recordTileY !== tileY) break;
          recordIndex += 1;
        }
      }
      rows[rowWordOffset + glyph.tileRows] = recordIndex;
      strips.set(glyph.strips, stripWordOffset);
      copyCoverageWords(coverage, coverageByteOffset, glyph.coverage);
      rowWordOffset = checkedUint32Add(
        "row word offset",
        rowWordOffset,
        checkedUint32Add("glyph row span", glyph.tileRows, 1),
      );
      stripWordOffset = checkedUint32Add("strip word offset", stripWordOffset, glyph.strips.length);
      coverageByteOffset = checkedUint32Add(
        "coverage byte offset",
        coverageByteOffset,
        glyph.coverage.byteLength,
      );
      packedGlyphIndex = checkedUint32Add("packed glyph index", packedGlyphIndex, 1);
      groupEffectivePixelCount = checkedSafeAdd(
        "dispatch effective pixel count",
        groupEffectivePixelCount,
        checkedSafeMultiply("glyph pixel count", glyph.width, glyph.height),
      );
    });
    const invocationCount = checkedSafeMultiply(
      "dispatch invocation count",
      checkedSafeMultiply(
        "dispatch workgroup area",
        checkedSafeMultiply("dispatch padded width", group.workgroupsX, WORKGROUP_WIDTH),
        checkedSafeMultiply("dispatch padded height", group.workgroupsY, WORKGROUP_HEIGHT),
      ),
      group.requests.length,
    );
    dispatches.push(
      Object.freeze({
        glyphBase,
        glyphCount: group.requests.length,
        workgroupsX: group.workgroupsX,
        workgroupsY: group.workgroupsY,
        invocationCount,
        effectivePixelCount: groupEffectivePixelCount,
      }),
    );
    dispatchInvocationCount = checkedSafeAdd(
      "total dispatch invocation count",
      dispatchInvocationCount,
      invocationCount,
    );
    effectivePixelCount = checkedSafeAdd(
      "total effective pixel count",
      effectivePixelCount,
      groupEffectivePixelCount,
    );
  });
  if (
    packedGlyphIndex !== plan.requests.length ||
    rowWordOffset !== plan.packing.rowWordCount ||
    stripWordOffset !== plan.packing.stripWordCount ||
    coverageByteOffset !== plan.packing.coverageByteLength
  ) {
    throw new Error("sparse strip packed snapshot diverged from its validated allocation plan");
  }

  return Object.freeze({
    width: plan.width,
    height: plan.height,
    maxEntryWidth: plan.maxEntryWidth,
    maxEntryHeight: plan.maxEntryHeight,
    glyphs,
    rows,
    strips,
    coverage,
    coverageByteLength: plan.packing.coverageByteLength,
    dispatches: Object.freeze(dispatches),
    stats: Object.freeze({
      overlapValidationOperations: plan.overlapValidationOperations,
      dispatchInvocationCount,
      effectivePixelCount,
    }),
    entries: Object.freeze(plan.requests.map((planned) => planned.entry)),
  });
}

function storageFits(
  packing: Readonly<SparseStripComputePackingPreflight>,
  maxBindingBytes: number,
  maxBufferBytes: number,
): boolean {
  return [
    packing.glyphByteLength,
    packing.rowByteLength,
    packing.stripByteLength,
    packing.coverageBufferByteLength,
  ].every(
    (bytes) =>
      Math.max(Uint32Array.BYTES_PER_ELEMENT, bytes) <= maxBindingBytes &&
      Math.max(Uint32Array.BYTES_PER_ELEMENT, bytes) <= maxBufferBytes,
  );
}

function copyCoverageWords(
  destination: Uint32Array,
  destinationByteOffset: number,
  source: Uint8Array,
): void {
  if (destinationByteOffset % Uint32Array.BYTES_PER_ELEMENT !== 0 || source.byteLength % 4 !== 0) {
    throw new Error("sparse strip coverage copies require whole u32 words");
  }
  const destinationWordOffset = destinationByteOffset / Uint32Array.BYTES_PER_ELEMENT;
  for (let sourceOffset = 0; sourceOffset < source.byteLength; sourceOffset += 4) {
    destination[destinationWordOffset + sourceOffset / 4] =
      ((source[sourceOffset] ?? 0) |
        ((source[sourceOffset + 1] ?? 0) << 8) |
        ((source[sourceOffset + 2] ?? 0) << 16) |
        ((source[sourceOffset + 3] ?? 0) << 24)) >>>
      0;
  }
}

function uploadStorage(device: GPUDevice, data: Uint32Array, label: string): GPUBuffer {
  return uploadBuffer(device, data, label, GPUBufferUsage.STORAGE);
}

function uploadBuffer(
  device: GPUDevice,
  data: Uint32Array | Uint8Array,
  label: string,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buffer = device.createBuffer({
    label,
    size: Math.max(4, data.byteLength),
    usage,
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

function assertBatchObject(batch: Readonly<SparseStripComputeBatch>): void {
  if (typeof batch !== "object" || batch === null || !Array.isArray(batch.requests)) {
    throw new TypeError("sparse strip compute batch must contain a request array");
  }
}

function assertRequest(
  request: Readonly<SparseStripComputeRequest>,
  requestIndex: number,
  atlasWidth: number,
  atlasHeight: number,
): void {
  if (typeof request !== "object" || request === null) {
    throw new TypeError(`sparse strip request ${String(requestIndex)} must be an object`);
  }
  assertUint32("request index", requestIndex);
  validateSparseStripGlyph(request.glyph);
  const placement = request.placement;
  if (typeof placement !== "object" || placement === null) {
    throw new TypeError(`sparse strip request ${String(requestIndex)} requires atlas placement`);
  }
  assertUint32("placement x", placement.x);
  assertUint32("placement y", placement.y);
  assertUint32("placement padding", placement.padding);
  assertPositiveUint32("placement contentWidth", placement.contentWidth);
  assertPositiveUint32("placement contentHeight", placement.contentHeight);
  const horizontalPadding = checkedUint32Multiply(
    "horizontal placement padding",
    placement.padding,
    2,
  );
  const verticalPadding = checkedUint32Multiply("vertical placement padding", placement.padding, 2);
  if (
    checkedUint32Add("padded placement width", placement.contentWidth, horizontalPadding) !==
      request.glyph.width ||
    checkedUint32Add("padded placement height", placement.contentHeight, verticalPadding) !==
      request.glyph.height
  ) {
    throw new TypeError("sparse strip placement content and padding must match glyph dimensions");
  }
  assertPositiveFiniteF32("placement scale", placement.scale);
  assertQuad(placement.quad);
  if (
    checkedUint32Add("placement right", placement.x, request.glyph.width) > atlasWidth ||
    checkedUint32Add("placement bottom", placement.y, request.glyph.height) > atlasHeight
  ) {
    throw new TypeError("sparse strip placement must stay inside the atlas");
  }
}

function assertQuad(quad: Readonly<OutlineQuadMetadata>): void {
  if (typeof quad !== "object" || quad === null) {
    throw new TypeError("sparse strip placement quad must be an object");
  }
  if (
    ![quad.minX, quad.minY, quad.maxX, quad.maxY, quad.width, quad.height].every(Number.isFinite) ||
    quad.width <= 0 ||
    quad.height <= 0
  ) {
    throw new TypeError("sparse strip placement quad must contain finite positive extents");
  }
  assertFiniteF32("quad minX", quad.minX);
  assertFiniteF32("quad minY", quad.minY);
  assertFiniteF32("quad maxX", quad.maxX);
  assertFiniteF32("quad maxY", quad.maxY);
  assertPositiveFiniteF32("quad width", quad.width);
  assertPositiveFiniteF32("quad height", quad.height);
  if (quad.maxX - quad.minX !== quad.width || quad.maxY - quad.minY !== quad.height) {
    throw new TypeError("sparse strip placement quad extents must match its dimensions");
  }
}

function copyQuad(quad: Readonly<OutlineQuadMetadata>): Readonly<OutlineQuadMetadata> {
  return Object.freeze({
    minX: quad.minX,
    minY: quad.minY,
    maxX: quad.maxX,
    maxY: quad.maxY,
    width: quad.width,
    height: quad.height,
  });
}

function f32ToU32(value: number): number {
  F32_BITS.setFloat32(0, value, true);
  return F32_BITS.getUint32(0, true);
}

function assertFiniteF32(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  F32_BITS.setFloat32(0, value, true);
  if (!Number.isFinite(F32_BITS.getFloat32(0, true))) {
    throw new RangeError(`${name} must fit finite f32 metadata`);
  }
}

function assertPositiveFiniteF32(name: string, value: number): void {
  assertFiniteF32(name, value);
  F32_BITS.setFloat32(0, value, true);
  if (value <= 0 || F32_BITS.getFloat32(0, true) <= 0) {
    throw new TypeError(`${name} must remain positive in f32 metadata`);
  }
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function assertUint32(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_U32) {
    throw new RangeError(`${name} must be a u32 integer`);
  }
}

function assertPositiveUint32(name: string, value: number): void {
  assertUint32(name, value);
  if (value === 0) throw new RangeError(`${name} must be a positive u32 integer`);
}

function checkedSafeAdd(name: string, first: number, second: number): number {
  const result = first + second;
  if (
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(second) ||
    !Number.isSafeInteger(result)
  ) {
    throw new RangeError(`${name} exceeds safe integer arithmetic`);
  }
  return result;
}

function checkedSafeMultiply(name: string, first: number, second: number): number {
  const result = first * second;
  if (
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(second) ||
    !Number.isSafeInteger(result)
  ) {
    throw new RangeError(`${name} exceeds safe integer arithmetic`);
  }
  return result;
}

function checkedUint32Add(name: string, first: number, second: number): number {
  assertUint32(name, first);
  assertUint32(name, second);
  const result = checkedSafeAdd(name, first, second);
  if (result > MAX_U32) throw new RangeError(`${name} exceeds u32 storage`);
  return result;
}

function checkedUint32Multiply(name: string, first: number, second: number): number {
  assertUint32(name, first);
  assertUint32(name, second);
  const result = checkedSafeMultiply(name, first, second);
  if (result > MAX_U32) throw new RangeError(`${name} exceeds u32 storage`);
  return result;
}

function checkedUint32Align(name: string, value: number, alignment: number): number {
  assertUint32(name, value);
  assertPositiveSafeInteger(`${name} alignment`, alignment);
  const remainder = value % alignment;
  return remainder === 0 ? value : checkedUint32Add(name, value, alignment - remainder);
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
    message: "sparse strip compute rasterizer has been destroyed",
  });
}
