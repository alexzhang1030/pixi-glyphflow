import { COMPUTE_CULL_WGSL } from "../src/culling/computeCull.wgsl";
import { PALETTE_DENSE_PATCH_WGSL } from "../src/render/palettePatch.wgsl";

const LABEL_COUNT = 1_000_000;
const GRID_WIDTH = 1_000;
const VISIBLE_COLUMNS = 50;
const RECORD_STRIDE = 32;
const DRAW_STRIDE = 8;
const WORKGROUP_SIZE = 256;
const GROUP_COUNT = Math.ceil(LABEL_COUNT / WORKGROUP_SIZE);
const GROUP_BLOCK_COUNT = Math.ceil(GROUP_COUNT / WORKGROUP_SIZE);
const INDIRECT_BYTES = Uint32Array.BYTES_PER_ELEMENT * 5;
const UNIFORM_BYTES = 32;
const WARMUP_SAMPLES = 20;
const TIMED_SAMPLES = 40;

export interface GpuResidentComputeBufferBytes {
  readonly records: number;
  readonly transforms: number;
  readonly counts: number;
  readonly prefix: number;
  readonly groupSums: number;
  readonly groupBlockSums: number;
  readonly instancesOut: number;
  readonly indirect: number;
  readonly uniform: number;
  readonly residentTotal: number;
  readonly timestampReadback: number;
  readonly outputReadback: number;
}

export interface GpuResidentComputeSpikeSuccess {
  readonly supported: true;
  readonly adapter: Readonly<{
    readonly vendor: string;
    readonly architecture: string;
    readonly device: string;
    readonly description: string;
  }>;
  readonly labels: number;
  readonly prototypeCount: number;
  readonly expectedSubmitted: number;
  readonly submitted: number;
  readonly indirect: readonly number[];
  readonly expectedHash: string;
  readonly outputHash: string;
  readonly stableOrder: boolean;
  readonly timestampValid: boolean;
  readonly timestampSamples: readonly number[];
  readonly gpuMsP50: number;
  readonly gpuMsP95: number;
  readonly initialUploadBytes: number;
  readonly steadyStateCullUploadBytes: number;
  readonly fusedMove: Readonly<{
    readonly recordAabbs: readonly number[];
    readonly transformOrigins: readonly number[];
    readonly instanceCounts: readonly number[];
    readonly bitExactMaxX: number;
    readonly bitExactMaxXBits: number;
    readonly bitExactInstanceCount: number;
    readonly cullRecordUploadBytes: 0;
  }>;
  readonly buffers: Readonly<GpuResidentComputeBufferBytes>;
}

export interface GpuResidentComputeSpikeUnsupported {
  readonly supported: false;
  readonly reason: string;
}

export type GpuResidentComputeSpikeResult =
  | Readonly<GpuResidentComputeSpikeSuccess>
  | Readonly<GpuResidentComputeSpikeUnsupported>;

/** Isolated 1M-record / one-shared-prototype compute-cull probe. */
export async function runGpuResidentComputeSpike(): Promise<GpuResidentComputeSpikeResult> {
  const gpu = globalThis.navigator?.gpu;
  if (gpu === undefined) return unsupported("WebGPU is unavailable");
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (adapter === null) return unsupported("A WebGPU adapter is unavailable");
  const limitFailure = validateLimits(adapter.limits);
  if (limitFailure !== undefined) return unsupported(limitFailure);
  if (!adapter.features.has("timestamp-query")) {
    return unsupported("The WebGPU adapter lacks timestamp-query");
  }

  const device = await adapter.requestDevice({ requiredFeatures: ["timestamp-query"] });
  const buffers = computeBufferBytes();
  const resources: Array<{ destroy(): void }> = [];
  try {
    const module = device.createShaderModule({
      label: "pixi-glyphflow-gpu-resident-compute-spike",
      code: COMPUTE_CULL_WGSL,
    });
    const compilation = await module.getCompilationInfo();
    const shaderErrors = compilation.messages.filter((message) => message.type === "error");
    if (shaderErrors.length > 0) {
      throw new Error(shaderErrors.map((message) => message.message).join("\n"));
    }
    const bindGroupLayout = device.createBindGroupLayout({
      label: "pixi-glyphflow-gpu-resident-compute-spike-layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    const pipelines = createPipelines(device, layout, module);
    const records = createRecords(device);
    const counts = createBuffer(device, buffers.counts, GPUBufferUsage.STORAGE, "counts");
    const prefix = createBuffer(device, buffers.prefix, GPUBufferUsage.STORAGE, "prefix");
    const groupSums = createBuffer(device, buffers.groupSums, GPUBufferUsage.STORAGE, "group-sums");
    const groupBlockSums = createBuffer(
      device,
      buffers.groupBlockSums,
      GPUBufferUsage.STORAGE,
      "group-block-sums",
    );
    const instancesOut = createBuffer(
      device,
      buffers.instancesOut,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      "instances-out",
    );
    const indirect = createBuffer(
      device,
      buffers.indirect,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      "indirect",
    );
    const uniform = createUniform(device);
    resources.push(
      records,
      counts,
      prefix,
      groupSums,
      groupBlockSums,
      instancesOut,
      indirect,
      uniform,
    );
    const bindGroup = device.createBindGroup({
      label: "pixi-glyphflow-gpu-resident-compute-spike-bind-group",
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: records } },
        { binding: 2, resource: { buffer: counts } },
        { binding: 3, resource: { buffer: prefix } },
        { binding: 4, resource: { buffer: groupSums } },
        { binding: 5, resource: { buffer: groupBlockSums } },
        { binding: 6, resource: { buffer: instancesOut } },
        { binding: 7, resource: { buffer: records } },
        { binding: 8, resource: { buffer: indirect } },
      ],
    });

    const querySet = device.createQuerySet({ type: "timestamp", count: TIMED_SAMPLES * 2 });
    const timestampResolve = createBuffer(
      device,
      buffers.timestampReadback,
      GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      "timestamp-resolve",
    );
    const timestampReadback = createBuffer(
      device,
      buffers.timestampReadback,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      "timestamp-readback",
    );
    resources.push(querySet, timestampResolve, timestampReadback);

    const warmups: GPUCommandBuffer[] = [];
    for (let index = 0; index < WARMUP_SAMPLES; index += 1) {
      warmups.push(encodeDispatch(device, bindGroup, pipelines));
    }
    device.queue.submit(warmups);
    await device.queue.onSubmittedWorkDone();

    const samples: GPUCommandBuffer[] = [];
    for (let index = 0; index < TIMED_SAMPLES; index += 1) {
      samples.push(encodeDispatch(device, bindGroup, pipelines, querySet, index * 2));
    }
    device.queue.submit(samples);
    const resolveEncoder = device.createCommandEncoder({
      label: "pixi-glyphflow-gpu-resident-compute-spike-resolve",
    });
    resolveEncoder.resolveQuerySet(querySet, 0, TIMED_SAMPLES * 2, timestampResolve, 0);
    resolveEncoder.copyBufferToBuffer(
      timestampResolve,
      0,
      timestampReadback,
      0,
      buffers.timestampReadback,
    );
    device.queue.submit([resolveEncoder.finish()]);
    await timestampReadback.mapAsync(GPUMapMode.READ);
    const timestamps = new BigUint64Array(timestampReadback.getMappedRange()).slice();
    timestampReadback.unmap();
    const timestampSamples = decodeTimestampSamples(timestamps);

    const expectedWords = gpuResidentComputeExpectedOutputWords();
    const outputBytes = expectedWords.byteLength;
    const outputReadback = createBuffer(
      device,
      outputBytes,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      "output-readback",
    );
    const indirectReadback = createBuffer(
      device,
      INDIRECT_BYTES,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      "indirect-readback",
    );
    resources.push(outputReadback, indirectReadback);
    const readEncoder = device.createCommandEncoder({
      label: "pixi-glyphflow-gpu-resident-compute-spike-readback",
    });
    readEncoder.copyBufferToBuffer(instancesOut, 0, outputReadback, 0, outputBytes);
    readEncoder.copyBufferToBuffer(indirect, 0, indirectReadback, 0, INDIRECT_BYTES);
    device.queue.submit([readEncoder.finish()]);
    await Promise.all([
      outputReadback.mapAsync(GPUMapMode.READ),
      indirectReadback.mapAsync(GPUMapMode.READ),
    ]);
    const outputWords = new Uint32Array(outputReadback.getMappedRange()).slice();
    const indirectWords = new Uint32Array(indirectReadback.getMappedRange()).slice();
    outputReadback.unmap();
    indirectReadback.unmap();
    const expectedHash = gpuResidentComputeOutputHash(expectedWords);
    const outputHash = gpuResidentComputeOutputHash(outputWords);
    const submitted = indirectWords[1] ?? 0;
    const fusedMove = await runFusedMoveProbe(device);

    return Object.freeze({
      supported: true,
      adapter: Object.freeze({
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
      }),
      labels: LABEL_COUNT,
      prototypeCount: 1,
      expectedSubmitted: expectedWords.length / 2,
      submitted,
      indirect: Object.freeze(Array.from(indirectWords)),
      expectedHash,
      outputHash,
      stableOrder: outputHash === expectedHash,
      timestampValid: timestampSamples.length === TIMED_SAMPLES,
      timestampSamples: Object.freeze(timestampSamples),
      gpuMsP50: percentile(timestampSamples, 0.5),
      gpuMsP95: percentile(timestampSamples, 0.95),
      initialUploadBytes: buffers.records,
      steadyStateCullUploadBytes: 0,
      fusedMove,
      buffers,
    });
  } finally {
    for (const resource of resources.reverse()) resource.destroy();
    device.destroy();
  }
}

async function runFusedMoveProbe(
  device: GPUDevice,
): Promise<Readonly<GpuResidentComputeSpikeSuccess["fusedMove"]>> {
  const resources: Array<{ destroy(): void }> = [];
  try {
    const module = device.createShaderModule({
      label: "pixi-glyphflow-fused-resident-move-probe",
      code: PALETTE_DENSE_PATCH_WGSL,
    });
    const compilation = await module.getCompilationInfo();
    const shaderErrors = compilation.messages.filter((message) => message.type === "error");
    if (shaderErrors.length > 0) {
      throw new Error(shaderErrors.map((message) => message.message).join("\n"));
    }
    const layout = device.createBindGroupLayout({
      label: "pixi-glyphflow-fused-resident-move-probe-layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      ],
    });
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint: "patch_xy_and_cull_dense" },
    });
    const uniform = createMappedBuffer(
      device,
      16,
      GPUBufferUsage.UNIFORM,
      "fused-move-uniform",
      (range) => new Uint32Array(range).set([0, 3, 3, 3]),
    );
    const commands = createMappedBuffer(
      device,
      24,
      GPUBufferUsage.STORAGE,
      "fused-move-commands",
      (range) => {
        const floats = new Float32Array(range);
        floats[0] = 100;
        floats[1] = 200;
        floats[2] = -30;
        floats[3] = 40;
        floats[4] = 16_777_206;
        floats[5] = 0;
      },
    );
    const transforms = createMappedBuffer(
      device,
      96,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      "fused-move-transforms",
      (range) =>
        new Float32Array(range).set([
          0, 0, 1, 0, 0, 1, 0, 1, 10, 20, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1,
        ]),
    );
    const records = createMappedBuffer(
      device,
      96,
      GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      "fused-move-records",
      (range) => {
        const floats = new Float32Array(range);
        const words = new Uint32Array(range);
        floats.set([-2, -3, 6, 6], 0);
        words[5] = 1;
        words[6] = 0;
        words[7] = 0;
        floats.set([20, 40, 24, 45], 8);
        words[13] = 0;
        words[14] = 1;
        words[15] = 1;
        floats.set([0, 0, 0, 0], 16);
        words[21] = 0;
        words[22] = 2;
        words[23] = 2;
      },
    );
    const localBounds = createMappedBuffer(
      device,
      48,
      GPUBufferUsage.STORAGE,
      "fused-move-local-bounds",
      (range) => new Float32Array(range).set([-2, -3, 8, 9, 10, 20, 4, 5, 2.25, 0, 9, 1]),
    );
    const recordReadback = createBuffer(
      device,
      96,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      "fused-move-record-readback",
    );
    const transformReadback = createBuffer(
      device,
      96,
      GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      "fused-move-transform-readback",
    );
    resources.push(
      uniform,
      commands,
      transforms,
      records,
      localBounds,
      recordReadback,
      transformReadback,
    );
    const bindGroup = device.createBindGroup({
      label: "pixi-glyphflow-fused-resident-move-probe-bind-group",
      layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: commands } },
        { binding: 2, resource: { buffer: transforms } },
        { binding: 3, resource: { buffer: records } },
        { binding: 4, resource: { buffer: localBounds } },
      ],
    });
    const encoder = device.createCommandEncoder({
      label: "pixi-glyphflow-fused-resident-move-probe",
    });
    const pass = encoder.beginComputePass();
    pass.setBindGroup(0, bindGroup);
    pass.setPipeline(pipeline);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(records, 0, recordReadback, 0, 96);
    encoder.copyBufferToBuffer(transforms, 0, transformReadback, 0, 96);
    device.queue.submit([encoder.finish()]);
    await Promise.all([
      recordReadback.mapAsync(GPUMapMode.READ),
      transformReadback.mapAsync(GPUMapMode.READ),
    ]);
    const recordBytes = new Uint8Array(recordReadback.getMappedRange()).slice();
    const transformFloats = new Float32Array(transformReadback.getMappedRange()).slice();
    recordReadback.unmap();
    transformReadback.unmap();
    const recordFloats = new Float32Array(recordBytes.buffer);
    const recordWords = new Uint32Array(recordBytes.buffer);
    return Object.freeze({
      recordAabbs: Object.freeze([
        ...Array.from(recordFloats.subarray(0, 4)),
        ...Array.from(recordFloats.subarray(8, 12)),
      ]),
      transformOrigins: Object.freeze([
        ...Array.from(transformFloats.subarray(0, 2)),
        ...Array.from(transformFloats.subarray(8, 10)),
      ]),
      instanceCounts: Object.freeze([recordWords[5] ?? 0, recordWords[13] ?? 0]),
      bitExactMaxX: recordFloats[18] ?? 0,
      bitExactMaxXBits: recordWords[18] ?? 0,
      bitExactInstanceCount: recordWords[21] ?? 0,
      cullRecordUploadBytes: 0,
    });
  } finally {
    for (const resource of resources.reverse()) resource.destroy();
  }
}

function createMappedBuffer(
  device: GPUDevice,
  size: number,
  usage: GPUBufferUsageFlags,
  suffix: string,
  write: (range: ArrayBuffer) => void,
): GPUBuffer {
  const buffer = device.createBuffer({
    label: `pixi-glyphflow-${suffix}`,
    size,
    usage,
    mappedAtCreation: true,
  });
  write(buffer.getMappedRange());
  buffer.unmap();
  return buffer;
}

interface SpikePipelines {
  readonly mark: GPUComputePipeline;
  readonly scanCounts: GPUComputePipeline;
  readonly scanGroups: GPUComputePipeline;
  readonly scanBlocks: GPUComputePipeline;
  readonly addGroupOffsets: GPUComputePipeline;
  readonly scatter: GPUComputePipeline;
}

function createPipelines(
  device: GPUDevice,
  layout: GPUPipelineLayout,
  module: GPUShaderModule,
): Readonly<SpikePipelines> {
  const create = (entryPoint: string): GPUComputePipeline =>
    device.createComputePipeline({ layout, compute: { module, entryPoint } });
  return Object.freeze({
    mark: create("mark_visible"),
    scanCounts: create("scan_counts"),
    scanGroups: create("scan_group_sums"),
    scanBlocks: create("scan_group_blocks"),
    addGroupOffsets: create("add_group_offsets"),
    scatter: create("scatter"),
  });
}

function encodeDispatch(
  device: GPUDevice,
  bindGroup: GPUBindGroup,
  pipelines: Readonly<SpikePipelines>,
  querySet?: GPUQuerySet,
  timestampIndex = 0,
): GPUCommandBuffer {
  const encoder = device.createCommandEncoder({
    label: "pixi-glyphflow-gpu-resident-compute-spike-dispatch",
  });
  const descriptor: GPUComputePassDescriptor =
    querySet === undefined
      ? {}
      : {
          timestampWrites: {
            querySet,
            beginningOfPassWriteIndex: timestampIndex,
            endOfPassWriteIndex: timestampIndex + 1,
          },
        };
  const pass = encoder.beginComputePass(descriptor);
  pass.setBindGroup(0, bindGroup);
  pass.setPipeline(pipelines.mark);
  pass.dispatchWorkgroups(GROUP_COUNT);
  pass.setPipeline(pipelines.scanCounts);
  pass.dispatchWorkgroups(GROUP_COUNT);
  pass.setPipeline(pipelines.scanGroups);
  pass.dispatchWorkgroups(GROUP_BLOCK_COUNT);
  pass.setPipeline(pipelines.scanBlocks);
  pass.dispatchWorkgroups(1);
  pass.setPipeline(pipelines.addGroupOffsets);
  pass.dispatchWorkgroups(Math.ceil(GROUP_COUNT / WORKGROUP_SIZE));
  pass.setPipeline(pipelines.scatter);
  pass.dispatchWorkgroups(GROUP_COUNT);
  pass.end();
  return encoder.finish();
}

function createRecords(device: GPUDevice): GPUBuffer {
  const byteLength = LABEL_COUNT * RECORD_STRIDE;
  const buffer = device.createBuffer({
    label: "pixi-glyphflow-gpu-resident-compute-spike-records",
    size: byteLength,
    usage: GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  const floats = new Float32Array(buffer.getMappedRange());
  const words = new Uint32Array(floats.buffer, floats.byteOffset, floats.length);
  for (let index = 0; index < LABEL_COUNT; index += 1) {
    const base = index * 8;
    const x = (index % GRID_WIDTH) * 16;
    const y = Math.floor(index / GRID_WIDTH) * 16;
    floats[base] = x;
    floats[base + 1] = y;
    floats[base + 2] = x + 8;
    floats[base + 3] = y + 8;
    words[base + 4] = 0;
    words[base + 5] = 1;
    words[base + 6] = index;
  }
  buffer.unmap();
  return buffer;
}

function createUniform(device: GPUDevice): GPUBuffer {
  const buffer = device.createBuffer({
    label: "pixi-glyphflow-gpu-resident-compute-spike-uniform",
    size: UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM,
    mappedAtCreation: true,
  });
  const floats = new Float32Array(buffer.getMappedRange());
  const words = new Uint32Array(floats.buffer, floats.byteOffset, floats.length);
  floats[0] = 0;
  floats[1] = 0;
  floats[2] = (VISIBLE_COLUMNS - 1) * 16 + 8;
  floats[3] = (LABEL_COUNT / GRID_WIDTH - 1) * 16 + 8;
  floats[4] = 0;
  words[5] = LABEL_COUNT;
  words[6] = 0;
  words[7] = GROUP_COUNT;
  buffer.unmap();
  return buffer;
}

function createBuffer(
  device: GPUDevice,
  size: number,
  usage: GPUBufferUsageFlags,
  suffix: string,
): GPUBuffer {
  return device.createBuffer({
    label: `pixi-glyphflow-gpu-resident-compute-spike-${suffix}`,
    size: Math.max(4, size),
    usage,
  });
}

function computeBufferBytes(): Readonly<GpuResidentComputeBufferBytes> {
  const records = LABEL_COUNT * RECORD_STRIDE;
  const transforms = 0;
  const counts = LABEL_COUNT * Uint32Array.BYTES_PER_ELEMENT;
  const prefix = counts;
  const groupSums = GROUP_COUNT * Uint32Array.BYTES_PER_ELEMENT;
  const groupBlockSums = GROUP_BLOCK_COUNT * Uint32Array.BYTES_PER_ELEMENT;
  const instancesOut = LABEL_COUNT * DRAW_STRIDE;
  const indirect = INDIRECT_BYTES;
  const uniform = UNIFORM_BYTES;
  const timestampReadback = TIMED_SAMPLES * 2 * BigUint64Array.BYTES_PER_ELEMENT;
  const outputReadback = VISIBLE_COLUMNS * (LABEL_COUNT / GRID_WIDTH) * DRAW_STRIDE;
  return Object.freeze({
    records,
    transforms,
    counts,
    prefix,
    groupSums,
    groupBlockSums,
    instancesOut,
    indirect,
    uniform,
    residentTotal:
      records +
      transforms +
      counts +
      prefix +
      groupSums +
      groupBlockSums +
      instancesOut +
      indirect +
      uniform,
    timestampReadback,
    outputReadback,
  });
}

export function gpuResidentComputeExpectedOutputWords(): Uint32Array {
  const words = new Uint32Array(VISIBLE_COLUMNS * (LABEL_COUNT / GRID_WIDTH) * 2);
  let offset = 0;
  for (let row = 0; row < LABEL_COUNT / GRID_WIDTH; row += 1) {
    for (let column = 0; column < VISIBLE_COLUMNS; column += 1) {
      words[offset] = 0;
      words[offset + 1] = row * GRID_WIDTH + column;
      offset += 2;
    }
  }
  return words;
}

function decodeTimestampSamples(timestamps: BigUint64Array): number[] {
  const samples: number[] = [];
  for (let index = 0; index < TIMED_SAMPLES; index += 1) {
    const start = timestamps[index * 2] ?? 0n;
    const end = timestamps[index * 2 + 1] ?? 0n;
    const nanoseconds = end >= start ? Number(end - start) : Number.NaN;
    if (Number.isFinite(nanoseconds) && nanoseconds > 0) samples.push(nanoseconds / 1_000_000);
  }
  return samples;
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index] ?? Number.NaN;
}

export function gpuResidentComputeOutputHash(words: Uint32Array): string {
  let hash = 0x811c9dc5;
  for (const word of words) {
    hash = Math.imul(hash ^ word, 0x01000193) >>> 0;
  }
  return `0x${hash.toString(16).padStart(8, "0")}`;
}

function validateLimits(limits: GPUSupportedLimits): string | undefined {
  const largestStorageBinding = LABEL_COUNT * RECORD_STRIDE;
  if (limits.maxStorageBufferBindingSize < largestStorageBinding) {
    return `maxStorageBufferBindingSize ${String(limits.maxStorageBufferBindingSize)} is below ${String(largestStorageBinding)}`;
  }
  if (limits.maxBufferSize < largestStorageBinding) {
    return `maxBufferSize ${String(limits.maxBufferSize)} is below ${String(largestStorageBinding)}`;
  }
  if (limits.maxStorageBuffersPerShaderStage < 8) {
    return `maxStorageBuffersPerShaderStage ${String(limits.maxStorageBuffersPerShaderStage)} is below 8`;
  }
  if (limits.maxComputeInvocationsPerWorkgroup < WORKGROUP_SIZE) {
    return `maxComputeInvocationsPerWorkgroup ${String(limits.maxComputeInvocationsPerWorkgroup)} is below ${String(WORKGROUP_SIZE)}`;
  }
  if (limits.maxComputeWorkgroupSizeX < WORKGROUP_SIZE) {
    return `maxComputeWorkgroupSizeX ${String(limits.maxComputeWorkgroupSizeX)} is below ${String(WORKGROUP_SIZE)}`;
  }
  if (limits.maxComputeWorkgroupsPerDimension < GROUP_COUNT) {
    return `maxComputeWorkgroupsPerDimension ${String(limits.maxComputeWorkgroupsPerDimension)} is below ${String(GROUP_COUNT)}`;
  }
  return undefined;
}

function unsupported(reason: string): Readonly<GpuResidentComputeSpikeUnsupported> {
  return Object.freeze({ supported: false, reason });
}
