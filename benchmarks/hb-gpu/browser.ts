import {
  HB_GPU_PACKED_PROJECTED_BYTES_CEILING,
  HB_GPU_PACKED_RENDER_HEIGHT,
  HB_GPU_PACKED_RENDER_WIDTH,
  assemblePackedDrawWgsl,
  concatPackedGlyphs,
  parseHbGpuPackedArtifact,
  selectMultiscriptGlyphs,
  type HbGpuPackedArtifact,
  type HbGpuPackedAtlas,
  type HbGpuPackedBackend,
  type HbGpuPackedGlyph,
} from "./packed-runtime";

interface HbGpuPackedBrowserState {
  done: boolean;
  error?: string;
  result?: HbGpuPackedBrowserResult;
}

interface HbGpuPackedBrowserResult {
  artifact: {
    harfbuzzVersion: string;
    corpusCount: number;
    glyphCount: number;
    packedBlobBytes: number;
    projectedPackedBytes: number;
  };
  scene: readonly {
    corpusId: string;
    glyphId: number;
    blobBytes: number;
  }[];
  capability: {
    status: "available" | "skipped";
    reason?: string;
    adapterInfo?: string;
    maxStorageBufferBindingSize?: number;
    maxBufferSize?: number;
    maxTextureDimension2D?: number;
    timestampQuery?: boolean;
  };
  packed?: HbGpuBrowserPathResult;
  rgba16sint?: HbGpuBrowserPathResult;
  decision: {
    status: "go" | "pause";
    reasons: string[];
    next: string;
  };
}

interface HbGpuBrowserPathResult {
  status: "go" | "pause" | "skipped";
  reason?: string;
  validationErrors: number;
  compilationMessages: readonly string[];
  shaderSourceBytes: number;
  uploadedBytes: number;
  projectedBytes: number;
  pixelHash: string;
  repeatedPixelHash: string;
  maskHash: string;
  repeatedMaskHash: string;
  visiblePixels: number;
  corpusVisiblePixels: number[];
  cpuTimingMs: Record<string, number>;
  gpuTimingNs?: number;
  gpuTimingDraws?: number;
  gpuTimingNsSamples?: number[];
  gpuTimingPerDrawP95Ns?: number;
  textureWidth?: number;
  actualTextureHeight?: number;
  projectedTextureHeight?: number;
}

interface RenderCapture {
  readonly pixels: Uint8Array;
  readonly submitMs: number;
  readonly completionMs: number;
  readonly gpuTimingNs?: number;
}

declare global {
  interface Window {
    __hbGpuPackedBrowser?: HbGpuPackedBrowserState;
  }
}

window.__hbGpuPackedBrowser = { done: false };

void run().catch((error: unknown) => {
  window.__hbGpuPackedBrowser = {
    done: true,
    error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
  };
});

async function run(): Promise<void> {
  const artifactFetchStart = performance.now();
  const response = await fetch("./results/hb-gpu-draw-native-14.4.0.json");
  if (!response.ok)
    throw new Error(`Native artifact request failed with ${String(response.status)}`);
  const artifact = parseHbGpuPackedArtifact(await response.json());
  const artifactFetchMs = performance.now() - artifactFetchStart;
  const decodeStart = performance.now();
  const atlas = concatPackedGlyphs(artifact.glyphs);
  const selectedGlyphs = selectMultiscriptGlyphs(atlas, artifact.corpusIds);
  const packedDecodeMs = performance.now() - decodeStart;
  const scene = selectedGlyphs.map((glyph) => ({
    corpusId: glyph.corpusId,
    glyphId: glyph.glyphId,
    blobBytes: glyph.blobBytes,
  }));
  const artifactResult = {
    harfbuzzVersion: artifact.harfbuzzVersion,
    corpusCount: artifact.corpusIds.length,
    glyphCount: artifact.glyphs.length,
    packedBlobBytes: artifact.packedBlobBytes,
    projectedPackedBytes: artifact.atlasPressureProjectedPackedBytes,
  };

  if (new URL(window.location.href).searchParams.get("forceWebGpuSkip") === "1") {
    finish({
      artifact: artifactResult,
      scene,
      capability: {
        status: "skipped",
        reason: "WebGPU capability skip forced by benchmark query",
      },
      decision: {
        status: "pause",
        reasons: ["webgpu-unavailable"],
        next: "retain-shipping-renderer",
      },
    });
    return;
  }

  const gpu = navigator.gpu;
  if (gpu === undefined) {
    finish({
      artifact: artifactResult,
      scene,
      capability: { status: "skipped", reason: "WebGPU navigator.gpu is unavailable" },
      decision: {
        status: "pause",
        reasons: ["webgpu-unavailable"],
        next: "retain-shipping-renderer",
      },
    });
    return;
  }

  const adapterStart = performance.now();
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  const adapterRequestMs = performance.now() - adapterStart;
  if (adapter === null) {
    finish({
      artifact: artifactResult,
      scene,
      capability: { status: "skipped", reason: "WebGPU adapter request returned null" },
      decision: {
        status: "pause",
        reasons: ["webgpu-unavailable"],
        next: "retain-shipping-renderer",
      },
    });
    return;
  }

  const alignedAtlasBytes = align(Math.max(8, atlas.bytes.byteLength), 8);
  const storageRequest = Math.min(
    adapter.limits.maxStorageBufferBindingSize,
    Math.max(alignedAtlasBytes, artifact.atlasPressureProjectedPackedBytes),
  );
  const bufferRequest = Math.min(
    adapter.limits.maxBufferSize,
    Math.max(alignedAtlasBytes, artifact.atlasPressureProjectedPackedBytes),
  );
  const timestampQuery = adapter.features.has("timestamp-query");
  const requiredFeatures: GPUFeatureName[] = timestampQuery ? ["timestamp-query"] : [];
  const deviceStart = performance.now();
  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxStorageBufferBindingSize: storageRequest,
      maxBufferSize: bufferRequest,
    },
  });
  const deviceRequestMs = performance.now() - deviceStart;
  const uncapturedErrors: string[] = [];
  device.addEventListener("uncapturederror", (event) => {
    uncapturedErrors.push(event.error.message);
  });

  const commonTiming = { artifactFetchMs, packedDecodeMs, adapterRequestMs, deviceRequestMs };
  const packed = await runBackend(
    device,
    artifact,
    atlas,
    selectedGlyphs,
    "storage-buffer",
    timestampQuery,
    commonTiming,
  );
  const rgba16sint = await runBackend(
    device,
    artifact,
    atlas,
    selectedGlyphs,
    "rgba16sint",
    timestampQuery,
    commonTiming,
  );
  await device.queue.onSubmittedWorkDone();
  if (uncapturedErrors.length > 0) {
    throw new Error(`WebGPU uncaptured validation errors: ${uncapturedErrors.join(" | ")}`);
  }

  const reasons: string[] = [];
  if (packed.status !== "go") reasons.push("packed-render-path");
  if (artifact.atlasPressureProjectedPackedBytes > HB_GPU_PACKED_PROJECTED_BYTES_CEILING) {
    reasons.push("packed-storage-ceiling");
  }
  if (artifact.atlasPressureProjectedPackedBytes > adapter.limits.maxStorageBufferBindingSize) {
    reasons.push("adapter-storage-binding-limit");
  }
  const result: HbGpuPackedBrowserResult = {
    artifact: artifactResult,
    scene,
    capability: {
      status: "available",
      adapterInfo: adapterDescription(adapter),
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
      timestampQuery,
    },
    packed,
    rgba16sint,
    decision: {
      status: reasons.length === 0 ? "go" : "pause",
      reasons,
      next: reasons.length === 0 ? "integrate-packed-outline-cache" : "retain-shipping-renderer",
    },
  };
  console.info("hb-gpu-packed-browser", result);
  finish(result);
}

async function runBackend(
  device: GPUDevice,
  artifact: Readonly<HbGpuPackedArtifact>,
  atlas: Readonly<HbGpuPackedAtlas>,
  glyphs: readonly Readonly<HbGpuPackedGlyph & { texelOffset: number }>[],
  backend: HbGpuPackedBackend,
  timestampQuery: boolean,
  commonTiming: Readonly<Record<string, number>>,
): Promise<HbGpuBrowserPathResult> {
  const shaderStart = performance.now();
  const shader = assemblePackedDrawWgsl(artifact.shaderSources, backend);
  const vertexModule = device.createShaderModule({
    label: `hb-gpu-${backend}-vertex`,
    code: shader.vertex,
  });
  const fragmentModule = device.createShaderModule({
    label: `hb-gpu-${backend}-fragment`,
    code: shader.fragment,
  });
  const shaderAssemblyMs = performance.now() - shaderStart;
  const compilationStart = performance.now();
  const [vertexInfo, fragmentInfo] = await Promise.all([
    vertexModule.getCompilationInfo(),
    fragmentModule.getCompilationInfo(),
  ]);
  const shaderCompilationMs = performance.now() - compilationStart;
  const compilationMessages = [...vertexInfo.messages, ...fragmentInfo.messages].map(
    (message) =>
      `${message.type}:${String(message.lineNum)}:${String(message.linePos)}:${message.message}`,
  );
  const compilationErrorCount = [...vertexInfo.messages, ...fragmentInfo.messages].filter(
    (message) => message.type === "error",
  ).length;
  if (compilationErrorCount > 0) {
    return failedPath(
      backend,
      artifact,
      compilationErrorCount,
      compilationMessages,
      `WGSL compilation failed for ${backend}`,
      { ...commonTiming, shaderAssemblyMs, shaderCompilationMs },
    );
  }

  device.pushErrorScope("validation");
  const pipelineStart = performance.now();
  let pipeline: GPURenderPipeline;
  try {
    pipeline = await device.createRenderPipelineAsync({
      label: `hb-gpu-${backend}-pipeline`,
      layout: "auto",
      vertex: { module: vertexModule, entryPoint: "main" },
      fragment: {
        module: fragmentModule,
        entryPoint: "main",
        targets: [{ format: "rgba8unorm" }],
      },
      primitive: { topology: "triangle-list" },
    });
  } catch (error) {
    await device.popErrorScope();
    return failedPath(
      backend,
      artifact,
      1,
      compilationMessages,
      `${backend} pipeline creation failed: ${errorMessage(error)}`,
      { ...commonTiming, shaderAssemblyMs, shaderCompilationMs },
    );
  }
  const pipelineCreateMs = performance.now() - pipelineStart;
  const pipelineValidationError = await device.popErrorScope();
  if (pipelineValidationError !== null) {
    return failedPath(
      backend,
      artifact,
      1,
      compilationMessages,
      `${backend} pipeline validation failed: ${pipelineValidationError.message}`,
      { ...commonTiming, shaderAssemblyMs, shaderCompilationMs, pipelineCreateMs },
    );
  }

  const instanceData = encodeInstances(glyphs);
  const instanceBuffer = device.createBuffer({
    label: `hb-gpu-${backend}-instances`,
    size: instanceData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const uploadStart = performance.now();
  device.queue.writeBuffer(instanceBuffer, 0, instanceData);
  let atlasResources: Readonly<{ bindGroup: GPUBindGroup; destroy: () => void }>;
  try {
    atlasResources = await createAtlasResources(device, pipeline, atlas.bytes, backend);
  } catch (error) {
    instanceBuffer.destroy();
    return failedPath(
      backend,
      artifact,
      1,
      compilationMessages,
      `${backend} atlas capability failed: ${errorMessage(error)}`,
      {
        ...commonTiming,
        shaderAssemblyMs,
        shaderCompilationMs,
        pipelineCreateMs,
        uploadMs: performance.now() - uploadStart,
      },
      true,
    );
  }
  const uploadMs = performance.now() - uploadStart;
  const instanceBindGroup = device.createBindGroup({
    label: `hb-gpu-${backend}-instances-bind-group`,
    layout: pipeline.getBindGroupLayout(1),
    entries: [{ binding: 0, resource: { buffer: instanceBuffer } }],
  });
  const outputTexture = device.createTexture({
    label: `hb-gpu-${backend}-output`,
    size: [HB_GPU_PACKED_RENDER_WIDTH, HB_GPU_PACKED_RENDER_HEIGHT],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  try {
    const captures: RenderCapture[] = [];
    const captureCount = timestampQuery ? GPU_TIMING_SAMPLE_COUNT : 2;
    for (let sample = 0; sample < captureCount; sample += 1) {
      captures.push(
        await renderCapture(
          device,
          pipeline,
          atlasResources.bindGroup,
          instanceBindGroup,
          outputTexture,
          glyphs.length,
          timestampQuery,
        ),
      );
    }
    const first = captures[0];
    const second = captures.at(-1);
    if (first === undefined || second === undefined)
      throw new Error("GPU captures are unavailable");
    const [pixelHash, repeatedPixelHash] = await Promise.all([
      sha256(first.pixels),
      sha256(second.pixels),
    ]);
    const [maskHash, repeatedMaskHash] = await Promise.all([
      sha256(coverageMask(first.pixels)),
      sha256(coverageMask(second.pixels)),
    ]);
    const pixelStats = measurePixels(first.pixels, artifact.corpusIds.length);
    if (backend === "storage-buffer") drawPixels(first.pixels);
    const gpuTimingNsSamples = captures.flatMap((capture) =>
      capture.gpuTimingNs === undefined ? [] : [capture.gpuTimingNs],
    );
    const gpuTimingNs = percentile(gpuTimingNsSamples, 0.5);
    const gpuTimingPerDrawP95Ns = percentile(gpuTimingNsSamples, 0.95) / GPU_TIMING_DRAW_REPEATS;
    const pathReasons: string[] = [];
    if (pixelHash !== repeatedPixelHash || maskHash !== repeatedMaskHash) {
      pathReasons.push("deterministic-pixels");
    }
    if (
      pixelStats.visiblePixels === 0 ||
      pixelStats.corpusVisiblePixels.some((value) => value === 0)
    ) {
      pathReasons.push("multiscript-coverage");
    }
    if (
      timestampQuery &&
      (gpuTimingNsSamples.length !== GPU_TIMING_SAMPLE_COUNT ||
        gpuTimingPerDrawP95Ns > GPU_TIMING_MAX_PER_DRAW_P95_NS)
    ) {
      pathReasons.push("gpu-timing");
    }
    const textureMetrics =
      backend === "rgba16sint"
        ? {
            textureWidth: RGBA16SINT_TEXTURE_WIDTH,
            actualTextureHeight: Math.ceil(atlas.bytes.byteLength / 8 / RGBA16SINT_TEXTURE_WIDTH),
            projectedTextureHeight: Math.ceil(
              artifact.atlasPressureProjectedPackedBytes / 8 / RGBA16SINT_TEXTURE_WIDTH,
            ),
          }
        : undefined;
    if (
      textureMetrics !== undefined &&
      textureMetrics.projectedTextureHeight > device.limits.maxTextureDimension2D
    ) {
      pathReasons.push("projected-texture-height");
    }
    return {
      status: pathReasons.length === 0 ? "go" : "pause",
      ...(pathReasons.length === 0 ? {} : { reason: pathReasons.join(",") }),
      validationErrors: pathReasons.length,
      compilationMessages,
      shaderSourceBytes: new TextEncoder().encode(shader.vertex + shader.fragment).byteLength,
      uploadedBytes: atlas.bytes.byteLength,
      projectedBytes: artifact.atlasPressureProjectedPackedBytes,
      pixelHash,
      repeatedPixelHash,
      maskHash,
      repeatedMaskHash,
      visiblePixels: pixelStats.visiblePixels,
      corpusVisiblePixels: pixelStats.corpusVisiblePixels,
      cpuTimingMs: {
        ...commonTiming,
        shaderAssemblyMs,
        shaderCompilationMs,
        pipelineCreateMs,
        uploadMs,
        firstSubmitMs: first.submitMs,
        firstCompletionMs: first.completionMs,
        repeatedSubmitMs: second.submitMs,
        repeatedCompletionMs: second.completionMs,
      },
      ...(gpuTimingNsSamples.length === 0
        ? {}
        : {
            gpuTimingNs,
            gpuTimingDraws: GPU_TIMING_DRAW_REPEATS,
            gpuTimingNsSamples,
            gpuTimingPerDrawP95Ns,
          }),
      ...textureMetrics,
    };
  } catch (error) {
    return failedPath(
      backend,
      artifact,
      1,
      compilationMessages,
      `${backend} render failed: ${errorMessage(error)}`,
      {
        ...commonTiming,
        shaderAssemblyMs,
        shaderCompilationMs,
        pipelineCreateMs,
        uploadMs,
      },
    );
  } finally {
    outputTexture.destroy();
    instanceBuffer.destroy();
    atlasResources.destroy();
  }
}

async function createAtlasResources(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  packedBytes: Uint8Array,
  backend: HbGpuPackedBackend,
): Promise<Readonly<{ bindGroup: GPUBindGroup; destroy: () => void }>> {
  device.pushErrorScope("validation");
  if (backend === "storage-buffer") {
    const buffer = device.createBuffer({
      label: "hb-gpu-packed-atlas",
      size: align(Math.max(8, packedBytes.byteLength), 8),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, packedBytes);
    const bindGroup = device.createBindGroup({
      label: "hb-gpu-packed-atlas-bind-group",
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer } }],
    });
    const validationError = await device.popErrorScope();
    if (validationError !== null) {
      buffer.destroy();
      throw new Error(validationError.message);
    }
    return Object.freeze({ bindGroup, destroy: () => buffer.destroy() });
  }

  const texelCount = packedBytes.byteLength / 8;
  const width = RGBA16SINT_TEXTURE_WIDTH;
  const height = Math.max(1, Math.ceil(texelCount / width));
  const paddedBytes = new Uint8Array(width * height * 8);
  paddedBytes.set(packedBytes);
  const metadata = new Uint32Array([width, 0, 0, 0, 0, 0, 0, 0]);
  const metadataBuffer = device.createBuffer({
    label: "hb-gpu-rgba16sint-metadata",
    size: metadata.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(metadataBuffer, 0, metadata);
  const texture = device.createTexture({
    label: "hb-gpu-rgba16sint-atlas",
    size: [width, height],
    format: "rgba16sint",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    paddedBytes,
    { bytesPerRow: width * 8, rowsPerImage: height },
    { width, height },
  );
  const bindGroup = device.createBindGroup({
    label: "hb-gpu-rgba16sint-atlas-bind-group",
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: metadataBuffer } },
      { binding: 1, resource: texture.createView() },
    ],
  });
  const validationError = await device.popErrorScope();
  if (validationError !== null) {
    metadataBuffer.destroy();
    texture.destroy();
    throw new Error(validationError.message);
  }
  return Object.freeze({
    bindGroup,
    destroy: () => {
      metadataBuffer.destroy();
      texture.destroy();
    },
  });
}

async function renderCapture(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  atlasBindGroup: GPUBindGroup,
  instanceBindGroup: GPUBindGroup,
  outputTexture: GPUTexture,
  instanceCount: number,
  timestampQuery: boolean,
): Promise<Readonly<RenderCapture>> {
  const bytesPerRow = align(HB_GPU_PACKED_RENDER_WIDTH * 4, 256);
  const readBuffer = device.createBuffer({
    label: "hb-gpu-pixel-readback",
    size: bytesPerRow * HB_GPU_PACKED_RENDER_HEIGHT,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const querySet = timestampQuery
    ? device.createQuerySet({ label: "hb-gpu-timestamps", type: "timestamp", count: 2 })
    : undefined;
  const queryResolveBuffer =
    querySet === undefined
      ? undefined
      : device.createBuffer({
          label: "hb-gpu-timestamp-resolve",
          size: 16,
          usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
        });
  const queryReadBuffer =
    querySet === undefined
      ? undefined
      : device.createBuffer({
          label: "hb-gpu-timestamp-readback",
          size: 16,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
  const encoder = device.createCommandEncoder({ label: "hb-gpu-render" });
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: outputTexture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
    ...(querySet === undefined
      ? {}
      : {
          timestampWrites: {
            querySet,
            beginningOfPassWriteIndex: 0,
            endOfPassWriteIndex: 1,
          },
        }),
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, atlasBindGroup);
  pass.setBindGroup(1, instanceBindGroup);
  for (let draw = 0; draw < (timestampQuery ? GPU_TIMING_DRAW_REPEATS : 1); draw += 1) {
    pass.draw(6, instanceCount);
  }
  pass.end();
  encoder.copyTextureToBuffer(
    { texture: outputTexture },
    { buffer: readBuffer, bytesPerRow, rowsPerImage: HB_GPU_PACKED_RENDER_HEIGHT },
    { width: HB_GPU_PACKED_RENDER_WIDTH, height: HB_GPU_PACKED_RENDER_HEIGHT },
  );
  if (querySet !== undefined && queryResolveBuffer !== undefined && queryReadBuffer !== undefined) {
    encoder.resolveQuerySet(querySet, 0, 2, queryResolveBuffer, 0);
    encoder.copyBufferToBuffer(queryResolveBuffer, 0, queryReadBuffer, 0, 16);
  }
  const commandBuffer = encoder.finish();
  const submitStart = performance.now();
  device.queue.submit([commandBuffer]);
  const submitMs = performance.now() - submitStart;
  const completionStart = performance.now();
  await device.queue.onSubmittedWorkDone();
  const completionMs = performance.now() - completionStart;
  await readBuffer.mapAsync(GPUMapMode.READ);
  const mapped = new Uint8Array(readBuffer.getMappedRange());
  const pixels = compactRows(mapped, bytesPerRow);
  readBuffer.unmap();
  let gpuTimingNs: number | undefined;
  if (queryReadBuffer !== undefined) {
    await queryReadBuffer.mapAsync(GPUMapMode.READ);
    const timestamps = new BigUint64Array(queryReadBuffer.getMappedRange());
    const start = timestamps[0];
    const end = timestamps[1];
    if (start !== undefined && end !== undefined && end >= start) gpuTimingNs = Number(end - start);
    queryReadBuffer.unmap();
  }
  readBuffer.destroy();
  queryResolveBuffer?.destroy();
  queryReadBuffer?.destroy();
  querySet?.destroy();
  return Object.freeze({
    pixels,
    submitMs,
    completionMs,
    ...(gpuTimingNs === undefined ? {} : { gpuTimingNs }),
  });
}

function encodeInstances(
  glyphs: readonly Readonly<HbGpuPackedGlyph & { texelOffset: number }>[],
): Uint8Array {
  const stride = 48;
  const bytes = new Uint8Array(stride * glyphs.length);
  const view = new DataView(bytes.buffer);
  const cellWidth = HB_GPU_PACKED_RENDER_WIDTH / glyphs.length;
  for (const [index, glyph] of glyphs.entries()) {
    const offset = index * stride;
    const minX = Math.min(glyph.extents.xBearing, glyph.extents.xBearing + glyph.extents.width);
    const maxX = Math.max(glyph.extents.xBearing, glyph.extents.xBearing + glyph.extents.width);
    const minY = Math.min(glyph.extents.yBearing, glyph.extents.yBearing + glyph.extents.height);
    const maxY = Math.max(glyph.extents.yBearing, glyph.extents.yBearing + glyph.extents.height);
    const scale = Math.min(48 / Math.max(1, maxX - minX), 64 / Math.max(1, maxY - minY));
    const centerX = cellWidth * (index + 0.5);
    const centerY = HB_GPU_PACKED_RENDER_HEIGHT / 2;
    const originX = centerX - ((minX + maxX) / 2) * scale;
    const originY = centerY + ((minY + maxY) / 2) * scale;
    for (const [component, value] of [minX, minY, maxX, maxY].entries()) {
      view.setFloat32(offset + component * 4, value, true);
    }
    for (const [component, value] of [originX, originY, scale, index].entries()) {
      view.setFloat32(offset + 16 + component * 4, value, true);
    }
    view.setUint32(offset + 32, glyph.texelOffset, true);
  }
  return bytes;
}

function compactRows(padded: Uint8Array, bytesPerRow: number): Uint8Array {
  const rowBytes = HB_GPU_PACKED_RENDER_WIDTH * 4;
  const compact = new Uint8Array(rowBytes * HB_GPU_PACKED_RENDER_HEIGHT);
  for (let y = 0; y < HB_GPU_PACKED_RENDER_HEIGHT; y += 1) {
    compact.set(padded.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
  }
  return compact;
}

function measurePixels(
  pixels: Uint8Array,
  corpusCount: number,
): Readonly<{ visiblePixels: number; corpusVisiblePixels: number[] }> {
  const corpusVisiblePixels = Array.from({ length: corpusCount }, () => 0);
  let visiblePixels = 0;
  const cellWidth = HB_GPU_PACKED_RENDER_WIDTH / corpusCount;
  for (let pixel = 0; pixel < pixels.byteLength / 4; pixel += 1) {
    if ((pixels[pixel * 4 + 3] ?? 0) === 0) continue;
    visiblePixels += 1;
    const x = pixel % HB_GPU_PACKED_RENDER_WIDTH;
    const corpus = Math.min(corpusCount - 1, Math.floor(x / cellWidth));
    corpusVisiblePixels[corpus] = (corpusVisiblePixels[corpus] ?? 0) + 1;
  }
  return Object.freeze({ visiblePixels, corpusVisiblePixels });
}

function drawPixels(pixels: Uint8Array): void {
  const canvas = document.querySelector("canvas");
  const context = canvas?.getContext("2d");
  if (canvas === null || canvas === undefined || context === null || context === undefined) return;
  context.putImageData(
    new ImageData(
      new Uint8ClampedArray(pixels),
      HB_GPU_PACKED_RENDER_WIDTH,
      HB_GPU_PACKED_RENDER_HEIGHT,
    ),
    0,
    0,
  );
}

function failedPath(
  backend: HbGpuPackedBackend,
  artifact: Readonly<HbGpuPackedArtifact>,
  validationErrors: number,
  compilationMessages: readonly string[],
  reason: string,
  cpuTimingMs: Record<string, number>,
  capabilityFailure = false,
): HbGpuBrowserPathResult {
  return {
    status: backend === "rgba16sint" && capabilityFailure ? "skipped" : "pause",
    reason,
    validationErrors,
    compilationMessages,
    shaderSourceBytes: 0,
    uploadedBytes: 0,
    projectedBytes: artifact.atlasPressureProjectedPackedBytes,
    pixelHash: "",
    repeatedPixelHash: "",
    maskHash: "",
    repeatedMaskHash: "",
    visiblePixels: 0,
    corpusVisiblePixels: artifact.corpusIds.map(() => 0),
    cpuTimingMs,
  };
}

function coverageMask(pixels: Uint8Array): Uint8Array {
  const mask = new Uint8Array(pixels.byteLength / 4);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    mask[pixel] = (pixels[pixel * 4 + 3] ?? 0) >= 128 ? 1 : 0;
  }
  return mask;
}

function finish(result: HbGpuPackedBrowserResult): void {
  window.__hbGpuPackedBrowser = { done: true, result };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function adapterDescription(adapter: GPUAdapter): string {
  const info = adapter.info;
  return [info.vendor, info.architecture, info.device, info.description]
    .filter((value) => value.length > 0)
    .join(" / ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

const GPU_TIMING_DRAW_REPEATS = 64;
const GPU_TIMING_SAMPLE_COUNT = 20;
const GPU_TIMING_MAX_PER_DRAW_P95_NS = 50_000;
const RGBA16SINT_TEXTURE_WIDTH = 1024;

function percentile(samples: readonly number[], percentileRank: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * percentileRank) - 1);
  return sorted[index] ?? 0;
}

export {};
