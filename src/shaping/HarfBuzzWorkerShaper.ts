import type { FontRegistry } from "../FontRegistry";
import {
  isLeasedPositionedRun,
  leasePositionedRun,
  releasePositionedRun,
} from "../layout/PositionedRunLease";
import type { PositionedRun } from "../layout/types";
import { KeyedTaskScheduler } from "../worker/KeyedTaskScheduler";
import type {
  SerializedPositionedRun,
  ShapeWorkerRequest,
  ShapeWorkerResponse,
} from "../worker/protocol";
import type { SabShapeTransport } from "../worker/SabShapeTransport";
import type { HarfBuzzShapeInput } from "./types";

export { WorkerQueueOverflowError } from "../worker/KeyedTaskScheduler";

const DEFAULT_MAX_QUEUE_DEPTH = 1_024;

export interface WorkerLike {
  postMessage(message: ShapeWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  terminate(): void;
}

export interface HarfBuzzWorkerShaperOptions {
  readonly workerFactory?: () => WorkerLike;
  readonly maxQueueDepth?: number;
  /** Dedicated advanced transport. The shaper takes lifecycle ownership when supplied. */
  readonly shapeTransport?: SabShapeTransport;
}

export interface HarfBuzzWorkerShaperStats {
  readonly workerStarts: number;
  readonly requests: number;
  readonly queueDepth: number;
  readonly activeRequests: number;
  readonly queuedRequests: number;
  readonly maxQueueDepth: number;
  readonly peakQueueDepth: number;
  readonly queueOverflows: number;
  readonly cancelledRequests: number;
  readonly syncedFonts: number;
  readonly staleResults: number;
  readonly trackedLabels: number;
}

interface PendingRequest {
  readonly resolve: (response: ShapeWorkerResponse) => void;
  readonly reject: (error: Error) => void;
}

type ScheduledWorkerCommand =
  | {
      readonly type: "shape";
      readonly labelId: number;
      readonly sourceRevision: number;
    }
  | {
      readonly type: "unregister-font";
    };

interface LabelRevisionState {
  latestRevision: number;
  pending: number;
}

export class StaleShapeResultError extends Error {
  readonly labelId: number;
  readonly sourceRevision: number;
  readonly latestRevision: number;

  constructor(labelId: number, sourceRevision: number, latestRevision: number) {
    super(
      `Shape result for label ${String(labelId)} revision ${String(sourceRevision)} is stale; latest revision is ${String(latestRevision)}`,
    );
    this.name = "StaleShapeResultError";
    this.labelId = labelId;
    this.sourceRevision = sourceRevision;
    this.latestRevision = latestRevision;
  }
}

export class HarfBuzzWorkerShaper {
  readonly #registry: FontRegistry;
  readonly #workerFactory: () => WorkerLike;
  readonly #scheduler: KeyedTaskScheduler<ScheduledWorkerCommand>;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #syncedFonts = new Map<string, number>();
  readonly #latestByLabel = new Map<number, LabelRevisionState>();
  readonly #messageListener: EventListener;
  readonly #workerFailureListener: EventListener;
  readonly #maxQueueDepth: number;
  readonly #shapeTransport: SabShapeTransport | undefined;
  #shapeTransportReady: Promise<void> | undefined;
  #workerInstance: WorkerLike | undefined;
  #workerFailure: Error | undefined;
  #nextRequestId = 1;
  #workerStarts = 0;
  #requests = 0;
  #staleResults = 0;
  #cancelledRequests = 0;
  #destroyed = false;

  constructor(registry: FontRegistry, options: HarfBuzzWorkerShaperOptions = {}) {
    this.#registry = registry;
    this.#workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.#maxQueueDepth = options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    this.#shapeTransport = options.shapeTransport;
    this.#scheduler = new KeyedTaskScheduler({ maxQueueDepth: this.#maxQueueDepth });
    this.#messageListener = (event: Event) => {
      this.#handleMessage((event as MessageEvent<ShapeWorkerResponse>).data);
    };
    this.#workerFailureListener = (event: Event) => {
      this.#handleWorkerFailure(event);
    };
  }

  async shape(
    labelId: number,
    sourceRevision: number,
    input: HarfBuzzShapeInput,
  ): Promise<Readonly<PositionedRun>> {
    this.#assertActive();
    assertRevision("labelId", labelId);
    assertRevision("sourceRevision", sourceRevision);
    const previous = this.#latestByLabel.get(labelId);
    if (previous !== undefined && sourceRevision < previous.latestRevision) {
      this.#cancelledRequests += 1;
      throw new StaleShapeResultError(labelId, sourceRevision, previous.latestRevision);
    }
    const command: ScheduledWorkerCommand = {
      type: "shape",
      labelId,
      sourceRevision,
    };
    const scheduled = this.#scheduler.schedule(input.family, command, () =>
      this.#shapeScheduled(labelId, sourceRevision, input),
    );
    if (previous !== undefined && sourceRevision > previous.latestRevision) {
      this.#cancelQueuedShapes(labelId, sourceRevision);
    }
    const state = previous ?? { latestRevision: sourceRevision, pending: 0 };
    state.latestRevision = Math.max(state.latestRevision, sourceRevision);
    state.pending += 1;
    this.#latestByLabel.set(labelId, state);

    try {
      return await scheduled;
    } finally {
      this.#finishShape(labelId, state);
    }
  }

  async #shapeScheduled(
    labelId: number,
    sourceRevision: number,
    input: HarfBuzzShapeInput,
  ): Promise<Readonly<PositionedRun>> {
    await this.#ensureShapeTransport();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const registered = this.#registry.get(input.family);
      if (registered?.kind !== "binary") {
        throw new RangeError(`Binary font family is unavailable: ${input.family}`);
      }

      await this.#ensureFont(input.family, registered.revision);
      if (this.#registry.get(input.family)?.revision !== registered.revision) {
        continue;
      }

      const response = await this.#request({
        type: "shape",
        requestId: this.#requestId(),
        labelId,
        sourceRevision,
        fontRevision: registered.revision,
        input: { ...input, fontRevision: registered.revision },
      });
      if (this.#workerFailure !== undefined || this.#destroyed) {
        if (response.type === "shape-result") releasePositionedRun(response.run);
        this.#assertActive();
      }
      if (response.type !== "shape-result") {
        throw new Error("Shape worker returned an unexpected acknowledgement");
      }
      const run = freezeRun(response.run);
      if (this.#registry.get(input.family)?.revision !== registered.revision) {
        releasePositionedRun(run);
        continue;
      }
      const latestRevision = this.#latestByLabel.get(labelId)?.latestRevision ?? sourceRevision;
      if (latestRevision !== sourceRevision) {
        this.#staleResults += 1;
        releasePositionedRun(run);
        throw new StaleShapeResultError(labelId, sourceRevision, latestRevision);
      }

      return run;
    }

    throw new Error(`Font family changed repeatedly during shaping: ${input.family}`);
  }

  invalidate(labelId: number, sourceRevision: number): void {
    this.#assertActive();
    assertRevision("labelId", labelId);
    assertRevision("sourceRevision", sourceRevision);
    const state = this.#latestByLabel.get(labelId);
    if (state === undefined || sourceRevision <= state.latestRevision) {
      return;
    }
    state.latestRevision = sourceRevision;
    this.#cancelQueuedShapes(labelId, sourceRevision);
  }

  async unregisterFont(family: string): Promise<boolean> {
    this.#assertActive();
    return this.#scheduler.schedule(
      family,
      { type: "unregister-font" },
      async (): Promise<boolean> => {
        if (!this.#syncedFonts.has(family)) {
          return false;
        }
        const response = await this.#request({
          type: "unregister-font",
          requestId: this.#requestId(),
          family,
        });
        this.#assertActive();
        if (response.type !== "ok") {
          throw new Error("Shape worker returned an unexpected font acknowledgement");
        }
        this.#syncedFonts.delete(family);

        return true;
      },
    );
  }

  get stats(): Readonly<HarfBuzzWorkerShaperStats> {
    const scheduler = this.#scheduler.stats;
    return Object.freeze({
      workerStarts: this.#workerStarts,
      requests: this.#requests,
      queueDepth: scheduler.depth,
      activeRequests: scheduler.active,
      queuedRequests: scheduler.queued,
      maxQueueDepth: this.#maxQueueDepth,
      peakQueueDepth: scheduler.peakDepth,
      queueOverflows: scheduler.overflows,
      cancelledRequests: scheduler.cancellations + this.#cancelledRequests,
      syncedFonts: this.#syncedFonts.size,
      staleResults: this.#staleResults,
      trackedLabels: this.#latestByLabel.size,
    });
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    const error = this.#workerFailure ?? new Error("HarfBuzzWorkerShaper has been destroyed");
    if (this.#workerFailure === undefined) {
      this.#cancelledRequests += this.#scheduler.stats.active;
    }
    this.#close(error);
  }

  async #ensureFont(family: string, revision: number): Promise<void> {
    if (this.#syncedFonts.get(family) === revision) {
      return;
    }
    const bytes = this.#registry.getBinaryData(family);
    if (bytes === undefined) {
      throw new RangeError(`Binary font data is unavailable: ${family}`);
    }
    const copy = bytes.slice();
    const data = copy.buffer as ArrayBuffer;
    const response = await this.#request(
      {
        type: "register-font",
        requestId: this.#requestId(),
        family,
        fontRevision: revision,
        data,
      },
      [data],
    );
    this.#assertActive();
    if (response.type !== "ok") {
      throw new Error("Shape worker returned an unexpected font acknowledgement");
    }
    const current = this.#registry.get(family);
    if (current?.revision === revision) {
      this.#syncedFonts.set(family, revision);
    }
  }

  async #ensureShapeTransport(): Promise<void> {
    if (this.#shapeTransport === undefined) return;
    const current = this.#shapeTransportReady;
    if (current !== undefined) return current;
    const pending = this.#request({
      type: "attach-shape-transport",
      requestId: this.#requestId(),
      buffer: this.#shapeTransport.buffer,
    }).then((response) => {
      this.#assertActive();
      if (response.type !== "ok") {
        throw new Error("Shape worker returned an unexpected transport acknowledgement");
      }
    });
    this.#shapeTransportReady = pending;
    try {
      await pending;
    } catch (error) {
      if (this.#shapeTransportReady === pending) this.#shapeTransportReady = undefined;
      throw error;
    }
  }

  #cancelQueuedShapes(labelId: number, latestRevision: number): number {
    return this.#scheduler.cancelQueued(
      (command) =>
        command.type === "shape" &&
        command.labelId === labelId &&
        command.sourceRevision < latestRevision,
      (command) =>
        command.type === "shape"
          ? new StaleShapeResultError(command.labelId, command.sourceRevision, latestRevision)
          : new Error("Shape request was cancelled"),
    );
  }

  #finishShape(labelId: number, state: LabelRevisionState): void {
    if (this.#latestByLabel.get(labelId) !== state) return;
    state.pending -= 1;
    if (state.pending === 0) {
      this.#latestByLabel.delete(labelId);
    }
  }

  #request(request: ShapeWorkerRequest, transfer?: Transferable[]): Promise<ShapeWorkerResponse> {
    this.#assertActive();
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

  #worker(): WorkerLike {
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
      throw new RangeError("Shape worker request identity capacity exhausted");
    }
    const requestId = this.#nextRequestId;
    this.#nextRequestId += 1;

    return requestId;
  }

  #handleMessage(response: ShapeWorkerResponse): void {
    if (this.#workerFailure !== undefined || this.#destroyed) return;
    if (response.type === "shape-result-sab") {
      void this.#handleSabMessage(response);
      return;
    }
    const pending = this.#pending.get(response.requestId);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(response.requestId);
    if (response.type === "error") {
      const error = new Error(response.message);
      error.name = response.name;
      if (response.stack !== undefined) {
        error.stack = response.stack;
      }
      pending.reject(error);
      return;
    }
    pending.resolve(response);
  }

  async #handleSabMessage(
    response: Extract<ShapeWorkerResponse, { readonly type: "shape-result-sab" }>,
  ): Promise<void> {
    const transport = this.#shapeTransport;
    if (transport === undefined) {
      this.#rejectTransport(new Error("Shape worker published SAB data without a transport"));
      return;
    }
    try {
      const lease = await transport.read();
      if (lease.result.requestId !== response.requestId) {
        lease.release();
        this.#rejectTransport(new Error("Shared shape result order is inconsistent"));
        return;
      }
      const pending = this.#pending.get(response.requestId);
      if (pending === undefined) {
        lease.release();
        return;
      }
      this.#pending.delete(response.requestId);
      const run = leasePositionedRun(lease.result.run, () =>
        lease.release(),
      ) as Readonly<SerializedPositionedRun>;
      pending.resolve({ ...lease.result, run });
    } catch (error) {
      const pending = this.#pending.get(response.requestId);
      if (pending === undefined) return;
      this.#pending.delete(response.requestId);
      pending.reject(toError(error));
    }
  }

  #rejectTransport(error: Error): void {
    if (this.#workerFailure !== undefined || this.#destroyed) return;
    this.#workerFailure = error;
    this.#cancelledRequests += this.#scheduler.stats.active;
    this.#close(error);
  }

  #handleWorkerFailure(event: Event): void {
    event.preventDefault();
    if (this.#workerFailure !== undefined || this.#destroyed) return;
    const error = new Error(`HarfBuzz shape worker failed: ${readWorkerFailureMessage(event)}`);
    error.name = "HarfBuzzWorkerError";
    this.#workerFailure = error;
    this.#cancelledRequests += this.#scheduler.stats.active;
    this.#close(error);
  }

  #close(error: Error): void {
    this.#scheduler.close(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#syncedFonts.clear();
    this.#latestByLabel.clear();
    this.#shapeTransport?.destroy();
    this.#shapeTransportReady = undefined;
    this.#stopWorker();
  }

  #stopWorker(): void {
    const worker = this.#workerInstance;
    if (worker === undefined) return;
    this.#workerInstance = undefined;
    worker.removeEventListener("message", this.#messageListener);
    worker.removeEventListener("error", this.#workerFailureListener);
    worker.removeEventListener("messageerror", this.#workerFailureListener);
    worker.terminate();
  }

  #assertActive(): void {
    if (this.#workerFailure !== undefined) throw this.#workerFailure;
    if (this.#destroyed) {
      throw new Error("HarfBuzzWorkerShaper has been destroyed");
    }
  }
}

function defaultWorkerFactory(): WorkerLike {
  if (typeof Worker === "undefined") {
    throw new Error("Web Worker support is required for HarfBuzzWorkerShaper");
  }

  return new Worker(new URL("./worker/text-worker.js", import.meta.url), {
    type: "module",
    name: "pixi-glyphflow-shaper",
  }) as unknown as WorkerLike;
}

function freezeRun(run: SerializedPositionedRun): Readonly<PositionedRun> {
  if (isLeasedPositionedRun(run)) return run;
  return Object.freeze({
    ...run,
    ...(run.glyphKeys === undefined ? {} : { glyphKeys: Object.freeze([...run.glyphKeys]) }),
    bounds: Object.freeze({ ...run.bounds }),
  });
}

function assertRevision(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function readWorkerFailureMessage(event: Event): string {
  if (event.type === "messageerror") return "response deserialization failed";
  const message = (event as Event & { readonly message?: unknown }).message;

  return typeof message === "string" && message.length > 0
    ? message
    : "module loading or execution failed";
}
