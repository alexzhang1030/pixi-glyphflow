import { KeyedTaskScheduler } from "../worker/KeyedTaskScheduler";
import type { HbGpuDrawWorkerRequest, HbGpuDrawWorkerResponse } from "./protocol";
import {
  HB_GPU_DRAW_ABI_VERSION,
  HB_GPU_DRAW_HARFBUZZ_VERSION,
  type HbGpuDrawEncoder,
  type HbGpuDrawEncoderStats,
  type HbGpuDrawEncodeRequest,
  type HbGpuDrawEncodeResult,
} from "./types";

const DEFAULT_MAX_QUEUE_DEPTH = 256;
const DEFAULT_DESTROY_GRACE_PERIOD_MS = 250;

export interface HbGpuWorkerLike {
  postMessage(message: HbGpuDrawWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  terminate(): void;
}

export interface HbGpuDrawWorkerEncoderOptions {
  readonly workerFactory?: () => HbGpuWorkerLike;
  readonly wasmUrl?: string | URL;
  readonly maxQueueDepth?: number;
  readonly destroyGracePeriodMs?: number;
}

interface PendingRequest {
  readonly resolve: (response: HbGpuDrawWorkerResponse) => void;
  readonly reject: (error: Error) => void;
}

export class HbGpuDrawWorkerEncoder implements HbGpuDrawEncoder {
  readonly #workerFactory: () => HbGpuWorkerLike;
  readonly #wasmUrl: string;
  readonly #destroyGracePeriodMs: number;
  readonly #scheduler: KeyedTaskScheduler<undefined>;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #syncedFonts = new Set<string>();
  readonly #messageListener: EventListener;
  readonly #workerFailureListener: EventListener;
  #workerInstance: HbGpuWorkerLike | undefined;
  #readyPromise: Promise<void> | undefined;
  #destroyPromise: Promise<void> | undefined;
  #workerFailure: Error | undefined;
  #nextRequestId = 1;
  #workerStarts = 0;
  #requests = 0;
  #encodedGlyphs = 0;
  #destroyed = false;

  constructor(options: Readonly<HbGpuDrawWorkerEncoderOptions> = {}) {
    this.#workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.#wasmUrl = String(
      options.wasmUrl ?? new URL("./wasm/hb-gpu-encoder.wasm", import.meta.url),
    );
    this.#destroyGracePeriodMs = options.destroyGracePeriodMs ?? DEFAULT_DESTROY_GRACE_PERIOD_MS;
    if (!Number.isSafeInteger(this.#destroyGracePeriodMs) || this.#destroyGracePeriodMs < 0) {
      throw new TypeError("destroyGracePeriodMs must be a non-negative safe integer");
    }
    this.#scheduler = new KeyedTaskScheduler({
      maxQueueDepth: options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH,
    });
    this.#messageListener = (event: Event) => {
      this.#handleMessage((event as MessageEvent<HbGpuDrawWorkerResponse>).data);
    };
    this.#workerFailureListener = (event: Event) => {
      this.#handleWorkerFailure(event);
    };
  }

  async encode(
    request: Readonly<HbGpuDrawEncodeRequest>,
  ): Promise<Readonly<HbGpuDrawEncodeResult>> {
    this.#assertActive();
    assertFontKey(request.fontKey);
    assertGlyphId(request.glyphId);
    const fontBytes = request.fontBytes?.slice();
    if (fontBytes !== undefined && fontBytes.byteLength === 0) {
      throw new TypeError("fontBytes must contain a font");
    }

    return this.#scheduler.schedule(request.fontKey, undefined, async () => {
      if (!this.#syncedFonts.has(request.fontKey)) {
        if (fontBytes === undefined) {
          throw new RangeError("fontBytes are required for an uncached fontKey");
        }
        await this.#ensureReady();
        const data = fontBytes.buffer as ArrayBuffer;
        const response = await this.#request(
          {
            type: "register-font",
            requestId: this.#requestId(),
            fontKey: request.fontKey,
            data,
          },
          [data],
        );
        if (response.type !== "ok") {
          throw new Error("Hb GPU worker returned an unexpected font acknowledgement");
        }
        this.#syncedFonts.add(request.fontKey);
      } else {
        await this.#ensureReady();
      }

      const response = await this.#request({
        type: "encode",
        requestId: this.#requestId(),
        fontKey: request.fontKey,
        glyphId: request.glyphId,
      });
      if (response.type !== "encode-result") {
        throw new Error("Hb GPU worker returned an unexpected encode acknowledgement");
      }
      assertEncodeResult(response);
      this.#encodedGlyphs += 1;

      return Object.freeze({
        packedCurveBlob: new Uint8Array(response.packedCurveBlob),
        extents: Object.freeze({ ...response.extents }),
        upem: response.upem,
      });
    });
  }

  async releaseFont(fontKey: string): Promise<boolean> {
    this.#assertActive();
    assertFontKey(fontKey);

    return this.#scheduler.schedule(fontKey, undefined, async (): Promise<boolean> => {
      if (!this.#syncedFonts.has(fontKey)) return false;
      await this.#ensureReady();
      const response = await this.#request({
        type: "release-font",
        requestId: this.#requestId(),
        fontKey,
      });
      if (response.type !== "font-released") {
        throw new Error("Hb GPU worker returned an unexpected release acknowledgement");
      }
      this.#syncedFonts.delete(fontKey);

      return response.released;
    });
  }

  get stats(): Readonly<HbGpuDrawEncoderStats> {
    const scheduler = this.#scheduler.stats;

    return Object.freeze({
      workerStarts: this.#workerStarts,
      requests: this.#requests,
      encodedGlyphs: this.#encodedGlyphs,
      syncedFonts: this.#syncedFonts.size,
      queueDepth: scheduler.depth,
      activeRequests: scheduler.active,
      queuedRequests: scheduler.queued,
      peakQueueDepth: scheduler.peakDepth,
      queueOverflows: scheduler.overflows,
    });
  }

  destroy(): Promise<void> {
    const existing = this.#destroyPromise;
    if (existing !== undefined) return existing;
    this.#destroyed = true;
    const destroyedError = new Error("HbGpuDrawWorkerEncoder has been destroyed");
    this.#scheduler.close(destroyedError);
    const pending = this.#dispose(destroyedError);
    this.#destroyPromise = pending;

    return pending;
  }

  async #dispose(destroyedError: Error): Promise<void> {
    const deadline = performance.now() + this.#destroyGracePeriodMs;
    try {
      const idle = await settleWithin(this.#scheduler.whenIdle(), remainingMs(deadline));
      if (idle.status === "timeout") return;
      if (this.#workerInstance === undefined || this.#workerFailure !== undefined) return;

      const disposal = await settleWithin(
        this.#request({
          type: "dispose",
          requestId: this.#requestId(),
        }),
        remainingMs(deadline),
      );
      if (disposal.status === "timeout") return;
      if (disposal.status === "rejected") throw disposal.error;
      if (disposal.value.type !== "ok") {
        throw new Error("Hb GPU worker returned an unexpected dispose acknowledgement");
      }
    } finally {
      this.#forceDestroy(destroyedError);
    }
  }

  #forceDestroy(destroyedError: Error): void {
    this.#syncedFonts.clear();
    for (const pending of this.#pending.values()) pending.reject(destroyedError);
    this.#pending.clear();
    this.#detachAndTerminateWorker();
  }

  #detachAndTerminateWorker(): void {
    const worker = this.#workerInstance;
    if (worker !== undefined) {
      worker.removeEventListener("message", this.#messageListener);
      worker.removeEventListener("error", this.#workerFailureListener);
      worker.removeEventListener("messageerror", this.#workerFailureListener);
      worker.terminate();
    }
    this.#workerInstance = undefined;
    this.#readyPromise = undefined;
  }

  async #ensureReady(): Promise<void> {
    const current = this.#readyPromise;
    if (current !== undefined) return current;
    const pending = this.#request({
      type: "initialize",
      requestId: this.#requestId(),
      wasmUrl: this.#wasmUrl,
      expectedAbiVersion: HB_GPU_DRAW_ABI_VERSION,
      expectedHarfBuzzVersion: HB_GPU_DRAW_HARFBUZZ_VERSION,
    }).then((response) => {
      if (response.type !== "ready") {
        throw new Error("Hb GPU worker returned an unexpected initialization acknowledgement");
      }
      if (response.abiVersion !== HB_GPU_DRAW_ABI_VERSION) {
        throw new Error(
          `Hb GPU encoder ABI mismatch: expected ${String(HB_GPU_DRAW_ABI_VERSION)}, received ${String(response.abiVersion)}`,
        );
      }
      if (response.harfbuzzVersion !== HB_GPU_DRAW_HARFBUZZ_VERSION) {
        throw new Error(
          `Hb GPU encoder HarfBuzz version mismatch: expected ${HB_GPU_DRAW_HARFBUZZ_VERSION}, received ${response.harfbuzzVersion}`,
        );
      }
    });
    this.#readyPromise = pending;

    return pending;
  }

  #request(
    request: HbGpuDrawWorkerRequest,
    transfer?: Transferable[],
  ): Promise<HbGpuDrawWorkerResponse> {
    if (this.#workerFailure !== undefined) return Promise.reject(this.#workerFailure);
    this.#requests += 1;

    return new Promise((resolve, reject) => {
      this.#pending.set(request.requestId, { resolve, reject });
      try {
        this.#worker().postMessage(request, transfer);
      } catch (error) {
        this.#pending.delete(request.requestId);
        reject(toError(error));
      }
    });
  }

  #worker(): HbGpuWorkerLike {
    if (this.#workerInstance === undefined) {
      this.#workerInstance = this.#workerFactory();
      this.#workerInstance.addEventListener("message", this.#messageListener);
      this.#workerInstance.addEventListener("error", this.#workerFailureListener);
      this.#workerInstance.addEventListener("messageerror", this.#workerFailureListener);
      this.#workerStarts += 1;
    }

    return this.#workerInstance;
  }

  #requestId(): number {
    if (this.#nextRequestId === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Hb GPU worker request identity capacity exhausted");
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;

    return requestId;
  }

  #handleMessage(response: HbGpuDrawWorkerResponse): void {
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined) return;
    this.#pending.delete(response.requestId);
    if (response.type === "error") {
      const error = new Error(response.message);
      error.name = response.name;
      if (response.stack !== undefined) error.stack = response.stack;
      pending.reject(error);
      return;
    }
    pending.resolve(response);
  }

  #handleWorkerFailure(event: Event): void {
    if (this.#workerFailure !== undefined) return;
    const message = readWorkerFailureMessage(event);
    const error = new Error(`Hb GPU worker failed: ${message}`);
    error.name = "HbGpuWorkerError";
    this.#workerFailure = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#detachAndTerminateWorker();
  }

  #assertActive(): void {
    if (this.#destroyed) {
      throw new Error("HbGpuDrawWorkerEncoder has been destroyed");
    }
    if (this.#workerFailure !== undefined) throw this.#workerFailure;
  }
}

function defaultWorkerFactory(): HbGpuWorkerLike {
  if (typeof Worker === "undefined") {
    throw new Error("Web Worker support is required for HbGpuDrawWorkerEncoder");
  }

  return new Worker(new URL("./worker.js", import.meta.url), {
    type: "module",
    name: "pixi-glyphflow-hb-gpu",
  }) as unknown as HbGpuWorkerLike;
}

function assertFontKey(fontKey: string): void {
  if (fontKey.length === 0) throw new TypeError("fontKey must be a non-empty string");
}

function assertGlyphId(glyphId: number): void {
  if (!Number.isSafeInteger(glyphId) || glyphId < 0 || glyphId > 0xffff_ffff) {
    throw new TypeError("glyphId must be a uint32");
  }
}

function assertEncodeResult(
  response: Extract<HbGpuDrawWorkerResponse, { readonly type: "encode-result" }>,
): void {
  if (response.packedCurveBlob.byteLength % 8 !== 0) {
    throw new Error("Hb GPU encoder returned a partial RGBA16I texel");
  }
  if (!Number.isSafeInteger(response.upem) || response.upem <= 0) {
    throw new Error("Hb GPU encoder returned an invalid units-per-em value");
  }
  for (const value of Object.values(response.extents)) {
    if (!Number.isSafeInteger(value)) {
      throw new Error("Hb GPU encoder returned invalid glyph extents");
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function readWorkerFailureMessage(event: Event): string {
  const message = (event as Event & { readonly message?: unknown }).message;

  return typeof message === "string" && message.length > 0
    ? message
    : "message delivery or execution failed";
}

type TimedSettlement<Value> =
  | { readonly status: "fulfilled"; readonly value: Value }
  | { readonly status: "rejected"; readonly error: Error }
  | { readonly status: "timeout" };

function settleWithin<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
): Promise<TimedSettlement<Value>> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      resolve({ status: "timeout" });
    }, timeoutMs);
    void promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: "fulfilled", value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: "rejected", error: toError(error) });
      },
    );
  });
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - performance.now());
}
