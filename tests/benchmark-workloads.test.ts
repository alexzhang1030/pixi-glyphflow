import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

import {
  browserBenchmarkArtifactFileName,
  browserBenchmarkRenderers,
} from "../benchmarks/artifacts";
import { createGpuFrameTimer, finishGpu } from "../benchmarks/browser/timing";
import {
  GPU_SCENE_HETEROGENEOUS_PAINTS,
  GPU_SCENE_HETEROGENEOUS_PROTOTYPES,
  expectedGpuSceneHeterogeneousSelection,
  gpuSceneHeterogeneousPaintIndex,
  gpuSceneHeterogeneousPrototypeIndex,
  prepareGpuResidentCamera,
  prepareGpuSceneCamera,
  sampleGpuResidentScenePhase,
  sampleGpuScenePhase,
} from "../benchmarks/browser/workloads";
import {
  CURRENT_WAVE2_DRAW_REFERENCE_STRIDE_BYTES,
  CURRENT_WAVE2_EFFECTFUL_TRANSFORM_STRIDE_BYTES,
  CURRENT_WAVE2_FILL_TRANSFORM_STRIDE_BYTES,
  CURRENT_WAVE2_LIVE_FRAME_P95_MS,
  CURRENT_WAVE2_LIVE_STORE_BYTES,
  CURRENT_WAVE2_PROTOTYPE_RECORD_STRIDE_BYTES,
  evaluateBrowserBenchmarkArtifactSampleGate,
  evaluateMillionLiveWave2Budget,
} from "../benchmarks/budgets";
import type { GpuSceneResidentRepeatabilityArtifact } from "../benchmarks/gpu-scene-resident-repeatability";
import type { BrowserBenchmarkArtifact, BrowserBenchmarkSample } from "../benchmarks/schema";
import {
  BENCHMARK_WORKLOADS,
  browserBenchmarkRepetitions,
  getBenchmarkWorkload,
  isBenchmarkWorkload,
} from "../benchmarks/workloads";
import { readBenchmarkArtifactBytes } from "../scripts/benchmark-artifact-archive";
import { TextLayer } from "../src";
import { WebGPUFrameTransaction } from "../src/render/WebGPUFrameTransaction";

describe("Wave 0 laboratory workloads", () => {
  test("registers the live-layer full-visibility workload beside the synthetic probe", () => {
    expect(isBenchmarkWorkload("million-full")).toBe(true);
    expect(isBenchmarkWorkload("million-live")).toBe(true);
    expect(getBenchmarkWorkload("million-full").description).toContain("Synthetic");
    expect(getBenchmarkWorkload("million-live")).toMatchObject({
      labelCount: 1_000_000,
      warmupFrames: 10,
      sampleFrames: 120,
      artifactRequired: true,
    });
    expect(getBenchmarkWorkload("million-live").description).toContain("Live TextLayer");
    expect(BENCHMARK_WORKLOADS.some((workload) => workload.id === "million-live")).toBe(true);
  });

  test("enforces current Wave 2 product-path frame and storage semantics", () => {
    const passing = millionLiveWave2Sample();
    const decision = evaluateMillionLiveWave2Budget(passing);

    expect(decision.passed).toBe(true);
    expect(decision.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "steady-state-frame-p95-ms",
          actual: 16,
          limit: CURRENT_WAVE2_LIVE_FRAME_P95_MS,
          passed: true,
        }),
        expect.objectContaining({
          name: "runtime-store-bytes",
          actual: CURRENT_WAVE2_LIVE_STORE_BYTES,
          limit: CURRENT_WAVE2_LIVE_STORE_BYTES,
          passed: true,
        }),
        expect.objectContaining({
          name: "draw-reference-stride-bytes",
          actual: CURRENT_WAVE2_DRAW_REFERENCE_STRIDE_BYTES,
          passed: true,
        }),
        expect.objectContaining({
          name: "prototype-record-stride-bytes",
          actual: CURRENT_WAVE2_PROTOTYPE_RECORD_STRIDE_BYTES,
          passed: true,
        }),
        expect.objectContaining({
          name: "fill-transform-stride-bytes",
          actual: CURRENT_WAVE2_FILL_TRANSFORM_STRIDE_BYTES,
          passed: true,
        }),
        expect.objectContaining({
          name: "effectful-transform-stride-bytes",
          actual: CURRENT_WAVE2_EFFECTFUL_TRANSFORM_STRIDE_BYTES,
          passed: true,
        }),
      ]),
    );

    const synthetic = millionLiveWave2Sample({
      configuration: { workload: "million-full" },
      invariants: { liveCoordinatorMesh: false, syntheticMesh: true },
    });
    const overBudget = millionLiveWave2Sample({
      timings: { frameMs: Array.from({ length: 120 }, () => 16.68) },
      counters: { allocatedStoreBytes: CURRENT_WAVE2_LIVE_STORE_BYTES + 1 },
    });
    const invalidProductOutput = millionLiveWave2Sample({
      invariants: { gpuDrawObserved: false },
    });

    expect(evaluateMillionLiveWave2Budget(synthetic).passed).toBe(false);
    expect(evaluateMillionLiveWave2Budget(overBudget).passed).toBe(false);
    expect(evaluateMillionLiveWave2Budget(invalidProductOutput).passed).toBe(false);
  });

  test("registers GPU Scene v2 as the sustained million-label two-phase gate", () => {
    expect(isBenchmarkWorkload("gpu-scene-v2")).toBe(true);
    expect(getBenchmarkWorkload("gpu-scene-v2")).toMatchObject({
      labelCount: 1_000_000,
      mutationCount: 100_000,
      sampleFrames: 120,
      artifactRequired: true,
    });
    expect(getBenchmarkWorkload("gpu-scene-v2").description).toContain("two-phase");
  });

  test("registers the WebGPU-only resident scene as an independent formal workload", () => {
    expect(isBenchmarkWorkload("gpu-scene-resident")).toBe(true);
    expect(getBenchmarkWorkload("gpu-scene-resident")).toMatchObject({
      labelCount: 1_000_000,
      mutationCount: 100_000,
      warmupFrames: 10,
      sampleFrames: 120,
      artifactRequired: true,
    });
    expect(getBenchmarkWorkload("gpu-scene-resident").description).toContain("WebGPU-resident");
    expect(browserBenchmarkRenderers("gpu-scene-resident")).toEqual(["webgpu"]);
    expect(
      browserBenchmarkArtifactFileName({
        workload: "gpu-scene-resident",
        renderer: "webgpu",
        artifactRole: "candidate",
        packageVersion: "1.2.0",
        exploratory: false,
      }),
    ).toBe("browser-gpu-scene-resident-webgpu-candidate-1.2.0.json");
  });

  test("registers the R1a heterogeneous resident scene as a WebGPU-only formal workload", () => {
    expect(isBenchmarkWorkload("gpu-scene-heterogeneous-64")).toBe(true);
    expect(getBenchmarkWorkload("gpu-scene-heterogeneous-64")).toMatchObject({
      labelCount: 1_000_000,
      mutationCount: 100_000,
      warmupFrames: 10,
      sampleFrames: 120,
      artifactRequired: true,
    });
    expect(getBenchmarkWorkload("gpu-scene-heterogeneous-64").description).toContain(
      "64 prototypes",
    );
    expect(browserBenchmarkRenderers("gpu-scene-heterogeneous-64")).toEqual(["webgpu"]);
    expect(browserBenchmarkRepetitions("gpu-scene-heterogeneous-64")).toBe(2);
    expect(browserBenchmarkRepetitions("gpu-scene-resident")).toBe(1);
    expect(
      browserBenchmarkArtifactFileName({
        workload: "gpu-scene-heterogeneous-64",
        renderer: "webgpu",
        artifactRole: "candidate",
        packageVersion: "1.2.0",
        exploratory: false,
      }),
    ).toBe("browser-gpu-scene-heterogeneous-64-webgpu-candidate-1.2.0.json");
  });

  test("matches formal artifact sample gates to each workload cardinality", () => {
    expect(evaluateBrowserBenchmarkArtifactSampleGate("gpu-scene-heterogeneous-64", 2)).toEqual({
      name: "samples",
      actual: 2,
      limit: 2,
      passed: true,
    });
    expect(evaluateBrowserBenchmarkArtifactSampleGate("gpu-scene-heterogeneous-64", 1)).toEqual({
      name: "samples",
      actual: 1,
      limit: 2,
      passed: false,
    });
    expect(evaluateBrowserBenchmarkArtifactSampleGate("static-hud", 4)).toMatchObject({
      limit: 4,
      passed: true,
    });
    expect(evaluateBrowserBenchmarkArtifactSampleGate("gpu-scene-resident", 1)).toMatchObject({
      limit: 1,
      passed: true,
    });
  });

  test("interleaves every heterogeneous prototype independently across every canonical paint", () => {
    const prototypes = new Set<number>();
    const paints = new Set<number>();
    const pairs = new Set<string>();
    for (let index = 0; index < 512; index += 1) {
      const prototype = gpuSceneHeterogeneousPrototypeIndex(index);
      const paint = gpuSceneHeterogeneousPaintIndex(index);
      prototypes.add(prototype);
      paints.add(paint);
      pairs.add(`${String(prototype)}:${String(paint)}`);
    }

    expect(prototypes.size).toBe(GPU_SCENE_HETEROGENEOUS_PROTOTYPES.length);
    expect(paints.size).toBe(GPU_SCENE_HETEROGENEOUS_PAINTS.length);
    expect(pairs.size).toBe(512);
    expect(
      Array.from({ length: 64 }, (_, index) => gpuSceneHeterogeneousPrototypeIndex(index)),
    ).toEqual(Array.from({ length: 64 }, (_, index) => index));
    expect(
      new Set(Array.from({ length: 64 }, (_, index) => gpuSceneHeterogeneousPaintIndex(index)))
        .size,
    ).toBeGreaterThan(1);
  });

  test("computes heterogeneous submitted count and hash from per-prototype bounds", () => {
    const prototypeBounds = GPU_SCENE_HETEROGENEOUS_PROTOTYPES.map((_, index) =>
      Object.freeze({ x: 0, y: 0, width: index === 1 ? 0.5 : 1, height: 1 }),
    );
    const selection = expectedGpuSceneHeterogeneousSelection({
      labelCount: 4,
      mutationCount: 2,
      moverOffset: 0.75,
      viewport: { x: 0, y: 0, width: 3, height: 3 },
      prototypeBounds,
    });
    let expectedHash = 0x811c_9dc5;
    for (const word of [0, 0, 1, 1]) {
      expectedHash = Math.imul(expectedHash ^ word, 0x0100_0193) >>> 0;
    }

    expect(selection).toEqual({ submittedGlyphs: 2, submittedGlyphsHash: expectedHash });
  });

  test("records GPU Scene v2 camera preparation in mutation and frame timing", async () => {
    const fixture = createGpuPhaseTimingFixture();
    const now = createSequencedNow(100, 104);

    const phase = await sampleGpuScenePhase(
      fixture.app,
      fixture.layer,
      fixture.timer,
      fixture.configuration,
      () => prepareGpuSceneCamera(fixture.viewport, 1, 0, now),
    );

    expect(fixture.viewportEvents).toEqual(["zoomed", "moved"]);
    expect(phase.mutationMs).toEqual([4]);
    expect(phase.frameMs).toEqual([16]);
    expect(phase.frameMetric).toBe("mutation+timer-cpu+queue-completion");
  });

  test("records resident camera preparation in mutation and frame timing", async () => {
    const fixture = createGpuPhaseTimingFixture();
    const now = createSequencedNow(200, 206);

    const phase = await sampleGpuResidentScenePhase(
      fixture.app,
      fixture.layer,
      fixture.timer,
      fixture.configuration,
      () => prepareGpuResidentCamera(fixture.viewport, fixture.configuration, 100, 1, now),
    );

    expect(fixture.viewportEvents).toEqual(["zoomed", "moved"]);
    expect(phase.mutationMs).toEqual([6]);
    expect(phase.frameMs).toEqual([18]);
    expect(phase.frameMetric).toBe("mutation+timer-cpu+queue-completion");
    expect(phase.gpuTimestampMs).toEqual([3]);
    expect(phase.paletteGpuTimestampMs).toEqual([0.5]);
    expect(phase.cullGpuTimestampMs).toEqual([1]);
    expect(phase.sceneRenderGpuTimestampMs).toEqual([1.5]);
  });

  test("keeps historical GPU-resident repeatability evidence linked from the report", async () => {
    const historicalPath = resolve(
      import.meta.dir,
      "../benchmarks/results/browser-gpu-scene-resident-webgpu-repeatability-1.2.0.json",
    );
    const historicalBytes = new Uint8Array(await Bun.file(historicalPath).arrayBuffer());
    const historical = JSON.parse(new TextDecoder().decode(historicalBytes)) as {
      readonly schemaVersion: number;
      readonly summary: {
        readonly postFix: {
          readonly attempts: number;
          readonly passed: number;
          readonly failed: number;
        };
        readonly preFix: { readonly attempts: number };
      };
    };
    const report = await Bun.file(resolve(import.meta.dir, "../benchmarks/PERFORMANCE.md")).text();

    expect(createHash("sha256").update(historicalBytes).digest("hex")).toBe(
      "b74ff555d22fa8b7f39fe0203c81293e3e55a633283a7f5322b3c16c8d9c8aa0",
    );
    expect(historical).toMatchObject({
      schemaVersion: 2,
      summary: {
        postFix: { attempts: 5, passed: 0, failed: 5 },
        preFix: { attempts: 5 },
      },
    });
    expect(report).toContain("## Historical GPU-resident scene repeatability");
    expect(report).toContain("Post-fix outcomes: 0 pass / 5 attempts; 5 budget failures.");
    expect(report).toContain("results/browser-gpu-scene-resident-webgpu-repeatability-1.2.0.json");
    expect(report).toContain("camera 1 / 600 >16.67 ms (0.17%)");
    expect(report).toContain("position 598 / 600 (99.67%)");
    expect(report).toContain("Throughput: PAUSE. Release tail: PAUSE.");
    expect(report).toContain("b74ff555d22fa8b7f39fe0203c81293e3e55a633283a7f5322b3c16c8d9c8aa0");
    expect(report).toContain("d4914d86952b310de210cb517d3a2f12073494c86dc38eb609af1095a61de2eb");
  });

  test("byte-locks the historical indexed 12-byte and resident 16-byte mover evidence", async () => {
    const cases = [
      {
        file: "browser-gpu-scene-heterogeneous-64-webgpu-candidate-legacy-12b-1.2.0.json",
        sha256: "a77d28f0ee7e976e40c1262badf627f5508166bf0ba6b4ea4e0327f3596cc86f",
        expectedBytes: 1_200_016,
        expectedSamples: 240,
      },
      {
        file: "browser-gpu-scene-resident-webgpu-candidate-legacy-16b-1.2.0.json",
        sha256: "6f77cb31bbc6a54df330f1f8475eda658d8b2ff61bafd8c1f614b8f03e06684e",
        expectedBytes: 1_600_016,
        expectedSamples: 120,
      },
    ] as const;

    for (const evidence of cases) {
      const path = resolve(import.meta.dir, "../benchmarks/results", evidence.file);
      const bytes = await readBenchmarkArtifactBytes(path);
      const artifact = JSON.parse(
        new TextDecoder().decode(bytes),
      ) as Readonly<BrowserBenchmarkArtifact>;
      const uploads = artifact.samples.flatMap(
        (sample) => sample.timings.phases?.positionMutation?.transformUploadBytes ?? [],
      );

      expect(createHash("sha256").update(bytes).digest("hex")).toBe(evidence.sha256);
      expect(uploads).toHaveLength(evidence.expectedSamples);
      expect(new Set(uploads)).toEqual(new Set([evidence.expectedBytes]));
    }
  });

  test("reports the current schema 7 resident promotion bundle beside historical evidence", async () => {
    const resultsDir = resolve(import.meta.dir, "../benchmarks/results");
    const promotionPath = resolve(
      resultsDir,
      "browser-gpu-scene-resident-webgpu-promotion-repeatability-1.2.0.json",
    );
    const promotionBytes = new Uint8Array(await Bun.file(promotionPath).arrayBuffer());
    const promotion = JSON.parse(
      new TextDecoder().decode(promotionBytes),
    ) as GpuSceneResidentRepeatabilityArtifact;

    expect(createHash("sha256").update(promotionBytes).digest("hex")).toBe(
      "a3a0eee1525765063d215a142230226a5b0f3bc7f07d52be4990f7b656ccc9db",
    );
    expect(promotion).toMatchObject({
      schemaVersion: 4,
      canonicalCandidate: {
        artifact: "browser-gpu-scene-resident-webgpu-canonical-source-1.2.0.json",
        sha256: "e8149d863b2d75af2e2ac997114597f5ab8ae4a3ca2746cf54c92f7672d69f7c",
      },
      canonicalOutputIdentity: {
        submittedGlyphs: 50_000,
        submittedGlyphsHash: 0x45cf_d045,
        renderedPixelHash: 0xa8ad_90b4,
        nonTransparentPixels: 302_457,
      },
      buildFingerprintSha256: "1cb31044438ee914eb5525b97c751488641312f4271127e32d08fdb0f0b27ef4",
      harnessFingerprintSha256: "2c27dffff28bd1029c6c227471cff106f2bcf120ad6f7395c8c5382d8027244e",
      runtimeFingerprint: {
        sha256: "5179504654b69449d6d2219ef12d1f6f8a12d053c89881702db871c38dd6fec7",
      },
      invariants: {
        truthRepeatabilityReady: true,
        formalPerformanceReady: true,
        sustained600Ready: true,
        promotionReady: true,
      },
      truthRepeatability: { status: "GO", reasons: [] },
      promotion: { status: "GO", reasons: [] },
      sustained600: {
        candidateSha256: "61dd5fb7932fcb10868bb9fa3be13b6e4e71201b010da2b783464c8faedaddf5",
        eligible: true,
        camera: { samples: 600, overBudgetCount: 4 },
        positionMutation: { samples: 600, overBudgetCount: 0 },
        timestamps: {
          readbackSubmissions: 1_220,
          fusedTimestampResolves: 1_220,
          standaloneTimestampSubmissions: 0,
        },
      },
    });

    const report = await Bun.file(resolve(import.meta.dir, "../benchmarks/PERFORMANCE.md")).text();
    expect(report).toContain("## Current GPU-resident promotion");
    expect(report).toContain("Truth repeatability: GO. Formal performance: GO.");
    expect(report).toContain("5 / 5 formal runs passed every performance budget");
    expect(report).toContain("position is 9.80 ms / 11.00 ms / 12.50 ms with 0 / 600 >16.67 ms");
    expect(report).toContain("position 0 / 600 >16.67 ms (0.00%)");
    expect(report).toContain("every run records exact 800,016-byte position uploads");
    expect(report).toContain("Promotion: GO (all gates passed)");
    expect(report).toContain(
      "results/browser-gpu-scene-resident-webgpu-promotion-repeatability-1.2.0.json",
    );
    expect(report).toContain("a3a0eee1525765063d215a142230226a5b0f3bc7f07d52be4990f7b656ccc9db");
  });

  test("keeps GPU Scene v2 renderer and baseline role in artifact identity", () => {
    expect(
      browserBenchmarkArtifactFileName({
        workload: "gpu-scene-v2",
        renderer: "webgpu",
        artifactRole: "baseline",
        packageVersion: "1.2.0",
        exploratory: false,
      }),
    ).toBe("browser-gpu-scene-v2-webgpu-baseline-1.2.0.json");
    expect(
      browserBenchmarkArtifactFileName({
        workload: "gpu-scene-v2",
        renderer: "webgl",
        artifactRole: "candidate",
        packageVersion: "1.2.0",
        exploratory: true,
      }),
    ).toBe("browser-gpu-scene-v2-webgl-candidate-1.2.0-exploratory.json");
  });

  test("registers label collision with renderer-scoped artifacts", () => {
    expect(getBenchmarkWorkload("label-collision")).toMatchObject({
      labelCount: 1_000_000,
      sampleFrames: 120,
      artifactRequired: true,
    });
    expect(
      browserBenchmarkArtifactFileName({
        workload: "label-collision",
        renderer: "webgpu",
        artifactRole: "candidate",
        packageVersion: "1.2.0",
        exploratory: false,
      }),
    ).toBe("browser-label-collision-webgpu-candidate-1.2.0.json");
  });

  test("finishGpu waits for WebGL completion", async () => {
    let finished = 0;
    await finishGpu({
      gl: {
        finish() {
          finished += 1;
        },
      },
    } as never);
    expect(finished).toBe(1);
  });

  test("finishGpu waits for WebGPU submitted work", async () => {
    let finished = 0;
    await finishGpu({
      gpu: {
        device: {
          queue: {
            async onSubmittedWorkDone() {
              finished += 1;
            },
          },
        },
      },
    } as never);
    expect(finished).toBe(1);
  });

  test("reads submitted glyphs through the layer diagnostics bridge", async () => {
    const layer = new TextLayer({ rendering: false });

    expect(await layer.readSubmittedGlyphs()).toBe(0);
    expect(await layer.readSubmittedGlyphsDiagnostic()).toBeUndefined();
    layer.destroy();
  });

  test("measures WebGL GPU time through EXT_disjoint_timer_query_webgl2", async () => {
    const calls: string[] = [];
    const extension = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
    const query = {};
    const timer = createGpuFrameTimer({
      gl: {
        QUERY_RESULT_AVAILABLE: 0x8867,
        QUERY_RESULT: 0x8866,
        getExtension(name: string) {
          calls.push(`extension:${name}`);
          return extension;
        },
        createQuery: () => query,
        beginQuery: () => calls.push("begin"),
        endQuery: () => calls.push("end"),
        finish: () => calls.push("finish"),
        getQueryParameter: (_query: object, parameter: number) =>
          parameter === 0x8867 ? true : 5_000_000,
        getParameter: () => false,
        deleteQuery: () => calls.push("delete"),
      },
    } as never);

    const sample = await timer.measure(() => {
      calls.push("render");
    });

    expect(sample.gpuMs).toBe(5);
    expect(sample.gpuTimestampMs).toBe(5);
    expect(sample.completionWallMs).toBeGreaterThanOrEqual(0);
    expect(timer.capability).toMatchObject({
      renderer: "webgl",
      method: "ext-disjoint-timer-query-webgl2",
      gpuTimeSource: "gpu-timestamp",
      quality: "valid",
      supported: true,
      timerQuery: true,
      readback: true,
    });
    expect(calls).toEqual([
      "extension:EXT_disjoint_timer_query_webgl2",
      "begin",
      "render",
      "end",
      "finish",
      "delete",
    ]);
    timer.destroy();
  });

  test("marks WebGL disjoint samples as completion-wall fallback", async () => {
    const extension = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
    const timer = createGpuFrameTimer({
      gl: {
        QUERY_RESULT_AVAILABLE: 0x8867,
        QUERY_RESULT: 0x8866,
        getExtension: () => extension,
        createQuery: () => ({}),
        beginQuery() {},
        endQuery() {},
        finish() {},
        getQueryParameter: (_query: object, parameter: number) =>
          parameter === 0x8867 ? true : 5_000_000,
        getParameter: () => true,
        deleteQuery() {},
      },
    } as never);

    const sample = await timer.measure(() => {});

    expect(sample.gpuTimestampMs).toBeNull();
    expect(timer.capability).toMatchObject({
      disjoint: true,
      samples: 1,
      validSamples: 0,
      fallbackSamples: 1,
      gpuTimeSource: "completion-wall",
      quality: "fallback",
    });
  });

  test("counts WebGL allocation fallback without resetting query capability", async () => {
    const extension = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
    const timer = createGpuFrameTimer({
      gl: {
        getExtension: () => extension,
        createQuery: () => null,
        finish() {},
      },
    } as never);

    await timer.measure(() => {});
    await timer.measure(() => {});

    expect(timer.capability).toMatchObject({
      method: "ext-disjoint-timer-query-webgl2",
      supported: true,
      timerQuery: true,
      samples: 2,
      fallbackSamples: 2,
      gpuTimeSource: "completion-wall",
      quality: "fallback",
      reason: "WebGL timer query allocation failed",
    });
  });

  test("closes and deletes a WebGL query when rendering rejects", async () => {
    const calls: string[] = [];
    const extension = { TIME_ELAPSED_EXT: 0x88bf, GPU_DISJOINT_EXT: 0x8fbb };
    const timer = createGpuFrameTimer({
      gl: {
        getExtension: () => extension,
        createQuery: () => ({}),
        beginQuery: () => calls.push("begin"),
        endQuery: () => calls.push("end"),
        finish: () => calls.push("finish"),
        deleteQuery: () => calls.push("delete"),
      },
    } as never);

    await expect(
      timer.measure(() => {
        throw new Error("render failed");
      }),
    ).rejects.toThrow("render failed");

    expect(calls).toEqual(["begin", "end", "finish", "delete"]);
    expect(timer.capability.samples).toBe(0);
  });

  test("waits for queue-wide product completion before deferred timestamp mapping", async () => {
    const calls: string[] = [];
    const timestampData = new BigUint64Array([1_000_000n, 5_000_000n]);
    const readBuffer = {
      mapAsync: async () => calls.push("map"),
      getMappedRange: () => timestampData.buffer,
      unmap: () => calls.push("unmap"),
      destroy() {},
    };
    const resolveBuffer = { destroy() {} };
    const queue = {
      submit: (_commands: readonly unknown[]) => calls.push("submit"),
      onSubmittedWorkDone: async () => calls.push("done"),
    };
    const device = {
      features: { has: (feature: string) => feature === "timestamp-query" },
      createQuerySet: () => ({ destroy() {} }),
      createBuffer: (() => {
        let buffers = 0;
        return () => (buffers++ === 0 ? resolveBuffer : readBuffer);
      })(),
      createCommandEncoder: () => {
        calls.push("create-encoder");
        return {
          resolveQuerySet: () => calls.push("resolve"),
          copyBufferToBuffer: () => calls.push("copy"),
          finish: () => {
            calls.push("finish-encoder");
            return {};
          },
        };
      },
      queue,
    };
    const renderTarget: { descriptor: { timestampWrites?: unknown } } = { descriptor: {} };
    const encoder = {
      commandEncoder: null as ReturnType<typeof device.createCommandEncoder> | null,
      renderPassOpen: false,
      beginRenderPass(target: typeof renderTarget) {
        this.renderPassOpen = true;
        calls.push(target.descriptor.timestampWrites === undefined ? "pass" : "timestampWrites");
      },
      finishRenderPass() {
        if (!this.renderPassOpen) return;
        this.renderPassOpen = false;
        calls.push("finish-pass");
      },
      postrender() {
        this.finishRenderPass();
        const commandEncoder = this.commandEncoder;
        if (commandEncoder === null) throw new Error("missing product command encoder");
        queue.submit([commandEncoder.finish()]);
        this.commandEncoder = null;
      },
    };
    const timer = createGpuFrameTimer({ encoder, gpu: { device } } as never);

    const sample = await timer.measure(() => {
      encoder.commandEncoder = device.createCommandEncoder();
      encoder.beginRenderPass(renderTarget);
      encoder.postrender();
    });

    expect(sample.gpuTimestampMs).toBe(4);
    expect(calls).toEqual([
      "create-encoder",
      "timestampWrites",
      "finish-pass",
      "resolve",
      "copy",
      "finish-encoder",
      "submit",
      "done",
      "map",
      "unmap",
    ]);
    expect(timer.capability).toMatchObject({
      samples: 1,
      validSamples: 1,
      fusedTimestampResolves: 1,
      standaloneTimestampSubmissions: 0,
    });
    timer.destroy();
  });

  test("measures WebGPU GPU time through timestamp writes, resolve, and readback", async () => {
    const calls: string[] = [];
    const timestampData = new BigUint64Array([0n, 0n]);
    const readBuffer = {
      mapAsync: async () => calls.push("map"),
      getMappedRange: () => timestampData.buffer,
      unmap: () => calls.push("unmap"),
      destroy: () => calls.push("destroy-read"),
    };
    const resolveBuffer = { destroy: () => calls.push("destroy-resolve") };
    const makeEncoder = () => ({
      resolveQuerySet: () => calls.push("resolve"),
      copyBufferToBuffer: () => calls.push("copy"),
      finish: () => ({}),
    });
    const renderTarget: { descriptor: { timestampWrites?: unknown } } = { descriptor: {} };
    const originalBeginRenderPass = (target: typeof renderTarget) => {
      calls.push(target.descriptor.timestampWrites === undefined ? "pass" : "timestampWrites");
    };
    const queue = {
      submit: (_commands: readonly unknown[]) => calls.push("submit"),
      onSubmittedWorkDone: async () => calls.push("done"),
    };
    const encoder = {
      commandEncoder: null as ReturnType<typeof makeEncoder> | null,
      beginRenderPass: originalBeginRenderPass,
      finishRenderPass: () => calls.push("finish-pass"),
      postrender() {
        this.finishRenderPass();
        const commandEncoder = this.commandEncoder;
        if (commandEncoder === null) throw new Error("missing product command encoder");
        queue.submit([commandEncoder.finish()]);
        this.commandEncoder = null;
      },
    };
    let buffers = 0;
    const timer = createGpuFrameTimer({
      encoder,
      gpu: {
        device: {
          features: { has: (feature: string) => feature === "timestamp-query" },
          createQuerySet: () => ({ destroy: () => calls.push("destroy-query") }),
          createBuffer: () => (buffers++ === 0 ? resolveBuffer : readBuffer),
          createCommandEncoder: makeEncoder,
          queue,
        },
      },
    } as never);

    await expect(
      timer.measure(() => {
        calls.push("render-reject");
        encoder.commandEncoder = makeEncoder();
        encoder.beginRenderPass(renderTarget);
        throw new Error("render failed");
      }),
    ).rejects.toThrow("render failed");
    expect(renderTarget.descriptor.timestampWrites).toBeUndefined();
    expect(timer.capability).toMatchObject({
      samples: 0,
      fusedTimestampResolves: 0,
      standaloneTimestampSubmissions: 0,
    });
    expect(calls).toEqual(["render-reject", "timestampWrites"]);

    const fallback = await timer.measure(() => {
      calls.push("render");
      encoder.commandEncoder = makeEncoder();
      encoder.beginRenderPass(renderTarget);
      encoder.postrender();
    });
    expect(fallback.gpuMs).toBeGreaterThanOrEqual(0);
    expect(fallback.gpuTimestampMs).toBeNull();
    expect(timer.capability).toMatchObject({
      readback: true,
      validSamples: 0,
      fallbackSamples: 1,
      gpuTimeSource: "completion-wall",
      quality: "fallback",
      reason: "WebGPU timestamp readback returned a non-positive delta",
    });

    timestampData[0] = 1_000_000n;
    timestampData[1] = 5_000_000n;
    const sample = await timer.measure(() => {
      calls.push("render");
      encoder.commandEncoder = makeEncoder();
      encoder.beginRenderPass(renderTarget);
      encoder.postrender();
    });

    expect(sample.gpuMs).toBe(4);
    expect(sample.gpuTimestampMs).toBe(4);
    expect(sample.completionWallMs).toBeGreaterThanOrEqual(0);
    expect(timer.capability).toMatchObject({
      renderer: "webgpu",
      method: "timestamp-query",
      supported: true,
      timestampWrites: true,
      resolveQuerySet: true,
      readback: true,
      validSamples: 1,
      fallbackSamples: 1,
      gpuTimeSource: "mixed",
      quality: "mixed",
    });
    expect(calls).toContain("timestampWrites");
    expect(calls).toContain("resolve");
    expect(calls).toContain("map");
    timer.destroy();
    expect(encoder.beginRenderPass).toBe(originalBeginRenderPass);
  });

  test("marks a WebGPU sample without a scene render pass as fallback", async () => {
    const encoder = {
      commandEncoder: null,
      beginRenderPass() {},
      finishRenderPass() {},
      postrender() {},
    };
    const timer = createGpuFrameTimer({
      encoder,
      gpu: {
        device: {
          features: { has: (feature: string) => feature === "timestamp-query" },
          createQuerySet: () => ({ destroy() {} }),
          createBuffer: () => ({ destroy() {} }),
          queue: { onSubmittedWorkDone: async () => {} },
        },
      },
    } as never);

    const sample = await timer.measure(() => {});

    expect(sample.gpuTimestampMs).toBeNull();
    expect(timer.capability).toMatchObject({
      samples: 1,
      validSamples: 0,
      fallbackSamples: 1,
      gpuTimeSource: "completion-wall",
      quality: "fallback",
      readback: false,
      reason: "WebGPU scene render pass was not observed",
    });
    timer.destroy();
  });

  test("restores timestamp hooks after out-of-order multi-timer destruction and reattach", async () => {
    const fixture = createTimestampTimerFixture();
    const originalBeginRenderPass = fixture.encoder.beginRenderPass;
    const originalPostrender = fixture.encoder.postrender;
    const first = createGpuFrameTimer(fixture.renderer);
    const second = createGpuFrameTimer(fixture.renderer);

    first.destroy();
    const sample = await second.measure(fixture.render);
    expect(sample.gpuTimestampMs).toBe(4);
    second.destroy();

    expect(fixture.encoder.beginRenderPass).toBe(originalBeginRenderPass);
    expect(fixture.encoder.postrender).toBe(originalPostrender);

    const reattached = createGpuFrameTimer(fixture.renderer);
    expect((await reattached.measure(fixture.render)).gpuTimestampMs).toBe(4);
    reattached.destroy();
    expect(fixture.encoder.beginRenderPass).toBe(originalBeginRenderPass);
    expect(fixture.encoder.postrender).toBe(originalPostrender);
  });

  test("releases each WebGPU timestamp resource when buffer allocation fails", () => {
    for (const failAt of [1, 2, 3, 4, 5, 6]) {
      let allocation = 0;
      let queryDestroys = 0;
      const bufferDestroys: number[] = [];
      const encoder = {
        commandEncoder: null,
        beginRenderPass() {},
        finishRenderPass() {},
        postrender() {},
      };
      const timer = createGpuFrameTimer({
        encoder,
        gpu: {
          device: {
            features: { has: (feature: string) => feature === "timestamp-query" },
            createQuerySet: () => ({
              destroy() {
                queryDestroys += 1;
              },
            }),
            createBuffer: () => {
              allocation += 1;
              if (allocation === failAt) throw new Error(`buffer ${String(failAt)} failed`);
              const index = bufferDestroys.length;
              bufferDestroys.push(0);
              return {
                destroy() {
                  bufferDestroys[index] = (bufferDestroys[index] ?? 0) + 1;
                },
              };
            },
          },
        },
      } as never);

      expect(timer.capability).toMatchObject({
        method: "completion-wall",
        supported: false,
        reason: `buffer ${String(failAt)} failed`,
      });
      expect(queryDestroys).toBe(Math.ceil(failAt / 2));
      expect(bufferDestroys).toEqual(Array.from({ length: failAt - 1 }, () => 1));
      timer.destroy();
      expect(queryDestroys).toBe(Math.ceil(failAt / 2));
      expect(bufferDestroys).toEqual(Array.from({ length: failAt - 1 }, () => 1));
    }
  });

  test("composes with frame transactions across either install and destroy order", async () => {
    for (const installOrder of ["timer-first", "transaction-first"] as const) {
      for (const destroyOrder of ["timer-first", "transaction-first"] as const) {
        const fixture = createTimestampTimerFixture();
        const originalBeginRenderPass = fixture.encoder.beginRenderPass;
        const originalPostrender = fixture.encoder.postrender;
        let timer: ReturnType<typeof createGpuFrameTimer>;
        let transaction: WebGPUFrameTransaction;
        if (installOrder === "timer-first") {
          timer = createGpuFrameTimer(fixture.renderer);
          transaction = new WebGPUFrameTransaction(fixture.renderer);
        } else {
          transaction = new WebGPUFrameTransaction(fixture.renderer);
          timer = createGpuFrameTimer(fixture.renderer);
        }
        transaction.queue("cull", 0, {
          encode: () => fixture.calls.push("transaction-work"),
        });

        const sample = await timer.measure(fixture.render);

        expect(sample.gpuTimestampMs).toBe(4);
        expect(fixture.calls.filter((call) => call === "submit")).toHaveLength(1);
        expect(transaction.stats).toMatchObject({
          submissions: 1,
          fusedSubmissions: 1,
          standaloneSubmissions: 0,
        });
        if (destroyOrder === "timer-first") {
          timer.destroy();
          transaction.destroy();
        } else {
          transaction.destroy();
          timer.destroy();
        }
        expect(fixture.encoder.beginRenderPass).toBe(originalBeginRenderPass);
        expect(fixture.encoder.postrender).toBe(originalPostrender);
      }
    }
  });
});

function createTimestampTimerFixture(calls: string[] = []) {
  const timestampData = new BigUint64Array([1_000_000n, 5_000_000n]);
  const readBuffer = {
    mapAsync: async () => calls.push("map"),
    getMappedRange: () => timestampData.buffer,
    unmap: () => calls.push("unmap"),
    destroy() {},
  };
  const resolveBuffer = { destroy() {} };
  const queue = {
    submit: (_commands: readonly unknown[]) => calls.push("submit"),
    onSubmittedWorkDone: async () => calls.push("done"),
  };
  const device = {
    features: { has: (feature: string) => feature === "timestamp-query" },
    createQuerySet: () => ({ destroy() {} }),
    createBuffer: (() => {
      let buffers = 0;
      return () => (buffers++ % 2 === 0 ? resolveBuffer : readBuffer);
    })(),
    createCommandEncoder: () => ({
      resolveQuerySet: () => calls.push("resolve"),
      copyBufferToBuffer: () => calls.push("copy"),
      finish: () => ({}),
    }),
    queue,
  };
  const renderTarget: { descriptor: { timestampWrites?: unknown } } = { descriptor: {} };
  const encoderPrototype = {
    renderStart(this: any) {
      this.commandEncoder = device.createCommandEncoder();
    },
    beginRenderPass(this: any, _target: typeof renderTarget) {
      this.renderPassOpen = true;
    },
    finishRenderPass(this: any) {
      this.renderPassOpen = false;
    },
    postrender(this: any) {
      this.finishRenderPass();
      const commandEncoder = this.commandEncoder;
      if (commandEncoder === null) throw new Error("missing product command encoder");
      queue.submit([commandEncoder.finish()]);
      this.commandEncoder = null;
    },
  };
  const encoder = Object.assign(Object.create(encoderPrototype) as typeof encoderPrototype, {
    commandEncoder: null as ReturnType<typeof device.createCommandEncoder> | null,
    renderPassOpen: false,
  });
  const renderer = { encoder, gpu: { device } } as never;
  const render = () => {
    encoder.renderStart();
    encoder.beginRenderPass(renderTarget);
    encoder.postrender();
  };

  return { calls, device, encoder, renderer, render, renderTarget };
}

function createGpuPhaseTimingFixture() {
  const stats = {
    shapedLabels: 0,
    cullingQueries: 0,
    instanceUploadBytes: 0,
    transformUploadBytes: 0,
    atlasUploadBytes: 0,
    cullRecordUploadBytes: 0,
    frameTransactionSubmissions: 0,
    frameTransactionFusedSubmissions: 0,
    frameTransactionStandaloneSubmissions: 0,
    lastUploadMs: 0,
    lastSpatialUpdateMs: 0,
    lastVisibilitySelectionMs: 0,
    lastRenderPreparationMs: 0,
    lastRenderCoordinatorMs: 0,
    lastSurfaceApplyMs: 0,
    offscreenInspectedLabels: 0,
    offscreenMaterializedLabels: 0,
    offscreenAdmissionDeferred: false,
    offscreenAdmissionGeneration: 0,
    offscreenAdmissionCursor: 0,
    offscreenAdmissionCursorResets: 0,
    offscreenAdmissionCycles: 0,
    deferredSpatialLabels: 0,
  };
  const product = Object.freeze({
    token: 1,
    frameMs: 12,
    cpuMs: 5,
    completionWallMs: 7,
    instrumentationWallMs: 0,
  });
  const completed = Object.freeze({
    ...product,
    gpuMs: 3,
    gpuTimestampMs: 3,
    paletteGpuTimestampMs: 0.5,
    cullGpuTimestampMs: 1,
    sceneRenderGpuTimestampMs: 1.5,
    timestampReadbackWallMs: 0,
  });
  const viewportEvents: string[] = [];

  return {
    app: {
      render() {},
    } as never,
    layer: {
      stats,
      async commit() {},
    } as never,
    timer: {
      capability: {},
      async measureProductFrame(render: () => void | Promise<void>) {
        await render();
        return product;
      },
      async drain() {
        return [completed];
      },
    } as never,
    configuration: {
      warmupFrames: 0,
      sampleFrames: 1,
      width: 800,
      height: 600,
    } as never,
    viewport: {
      scale: { set() {} },
      position: { set() {} },
      emit(event: string) {
        viewportEvents.push(event);
      },
    } as never,
    viewportEvents,
  };
}

function createSequencedNow(...samples: readonly number[]): () => number {
  let index = 0;
  return () => samples[index++] ?? samples.at(-1) ?? 0;
}

function millionLiveWave2Sample(
  overrides: Readonly<{
    configuration?: Partial<BrowserBenchmarkSample["configuration"]>;
    timings?: Partial<BrowserBenchmarkSample["timings"]>;
    counters?: Partial<BrowserBenchmarkSample["counters"]>;
    invariants?: Readonly<Record<string, boolean | number | string>>;
  }> = {},
): Readonly<BrowserBenchmarkSample> {
  return Object.freeze({
    schemaVersion: 7,
    kind: "pixi-glyphflow-browser-sample",
    capturedAt: "2026-08-30T00:00:00.000Z",
    userAgent: "HeadlessChrome/151",
    configuration: Object.freeze({
      fixture: "glyphflow",
      workload: "million-live",
      renderer: "webgl",
      labelCount: 1_000_000,
      mutationCount: 1,
      warmupFrames: 10,
      sampleFrames: 120,
      width: 1_280,
      height: 800,
      ...overrides.configuration,
    }),
    timings: Object.freeze({
      setupMs: 1_000,
      frameMs: Object.freeze(Array.from({ length: 120 }, () => 16)),
      cpuMs: Object.freeze(Array.from({ length: 120 }, () => 1)),
      gpuMs: Object.freeze(Array.from({ length: 120 }, () => 15)),
      uploadBytes: Object.freeze(Array.from({ length: 120 }, () => 0)),
      ...overrides.timings,
    }),
    counters: Object.freeze({
      residentLabels: 1_000_000,
      submittedLabels: 1_000_000,
      visibleGlyphs: 8_000_000,
      drawCalls: 1,
      allocatedStoreBytes: CURRENT_WAVE2_LIVE_STORE_BYTES,
      drawReferenceBytes: 8_000_000 * CURRENT_WAVE2_DRAW_REFERENCE_STRIDE_BYTES,
      prototypeRecordBytes: 8 * CURRENT_WAVE2_PROTOTYPE_RECORD_STRIDE_BYTES,
      transformBytes: 1_000_000 * CURRENT_WAVE2_FILL_TRANSFORM_STRIDE_BYTES,
      ...overrides.counters,
    }),
    invariants: Object.freeze({
      exactResidentLabels: true,
      exactVisibleGlyphs: true,
      eightGlyphsPerLabel: true,
      singleDrawCall: true,
      gpuDrawObserved: true,
      exactSubmittedInstanceCount: true,
      nonTransparentOutput: true,
      liveCoordinatorMesh: true,
      splitCpuGpuSamples: true,
      drawReferenceStrideBytes: CURRENT_WAVE2_DRAW_REFERENCE_STRIDE_BYTES,
      prototypeRecordStrideBytes: CURRENT_WAVE2_PROTOTYPE_RECORD_STRIDE_BYTES,
      fillTransformStrideBytes: CURRENT_WAVE2_FILL_TRANSFORM_STRIDE_BYTES,
      effectfulTransformStrideBytes: CURRENT_WAVE2_EFFECTFUL_TRANSFORM_STRIDE_BYTES,
      ...overrides.invariants,
    }),
  });
}
