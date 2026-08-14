import type { FontRegistry } from "../FontRegistry";
import type { PositionedRun } from "../layout/types";
import type {
  SerializedPositionedRun,
  ShapeWorkerRequest,
  ShapeWorkerResponse,
} from "../worker/protocol";
import type { HarfBuzzShapeInput } from "./types";

export interface WorkerLike {
  postMessage(message: ShapeWorkerRequest, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: EventListener): void;
  removeEventListener(type: "message", listener: EventListener): void;
  terminate(): void;
}

export interface HarfBuzzWorkerShaperOptions {
  readonly workerFactory?: () => WorkerLike;
}

export interface HarfBuzzWorkerShaperStats {
  readonly workerStarts: number;
  readonly requests: number;
  readonly queueDepth: number;
  readonly syncedFonts: number;
  readonly staleResults: number;
}

interface PendingRequest {
  readonly resolve: (response: ShapeWorkerResponse) => void;
  readonly reject: (error: Error) => void;
}

interface FontSync {
  readonly revision: number;
  readonly promise: Promise<void>;
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
  readonly #pending = new Map<number, PendingRequest>();
  readonly #syncedFonts = new Map<string, number>();
  readonly #fontSyncs = new Map<string, FontSync>();
  readonly #latestByLabel = new Map<number, number>();
  readonly #messageListener: EventListener;
  #workerInstance: WorkerLike | undefined;
  #nextRequestId = 1;
  #workerStarts = 0;
  #requests = 0;
  #staleResults = 0;
  #destroyed = false;

  constructor(registry: FontRegistry, options: HarfBuzzWorkerShaperOptions = {}) {
    this.#registry = registry;
    this.#workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.#messageListener = (event: Event) => {
      this.#handleMessage((event as MessageEvent<ShapeWorkerResponse>).data);
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
    this.#latestByLabel.set(labelId, sourceRevision);
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
      if (response.type !== "shape-result") {
        throw new Error("Shape worker returned an unexpected acknowledgement");
      }
      if (this.#registry.get(input.family)?.revision !== registered.revision) {
        continue;
      }
      const latestRevision = this.#latestByLabel.get(labelId) ?? sourceRevision;
      if (latestRevision !== sourceRevision) {
        this.#staleResults += 1;
        throw new StaleShapeResultError(labelId, sourceRevision, latestRevision);
      }

      return freezeRun(response.run);
    }

    throw new Error(`Font family changed repeatedly during shaping: ${input.family}`);
  }

  invalidate(labelId: number, sourceRevision: number): void {
    this.#assertActive();
    assertRevision("labelId", labelId);
    assertRevision("sourceRevision", sourceRevision);
    this.#latestByLabel.set(labelId, sourceRevision);
  }

  async unregisterFont(family: string): Promise<boolean> {
    this.#assertActive();
    if (!this.#syncedFonts.has(family)) {
      return false;
    }
    const response = await this.#request({
      type: "unregister-font",
      requestId: this.#requestId(),
      family,
    });
    if (response.type !== "ok") {
      throw new Error("Shape worker returned an unexpected font acknowledgement");
    }
    this.#syncedFonts.delete(family);

    return true;
  }

  get stats(): Readonly<HarfBuzzWorkerShaperStats> {
    return Object.freeze({
      workerStarts: this.#workerStarts,
      requests: this.#requests,
      queueDepth: this.#pending.size,
      syncedFonts: this.#syncedFonts.size,
      staleResults: this.#staleResults,
    });
  }

  destroy(): void {
    if (this.#destroyed) {
      return;
    }
    this.#destroyed = true;
    const error = new Error("HarfBuzzWorkerShaper has been destroyed");
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
    this.#fontSyncs.clear();
    this.#syncedFonts.clear();
    this.#latestByLabel.clear();
    if (this.#workerInstance !== undefined) {
      this.#workerInstance.removeEventListener("message", this.#messageListener);
      this.#workerInstance.terminate();
      this.#workerInstance = undefined;
    }
  }

  async #ensureFont(family: string, revision: number): Promise<void> {
    if (this.#syncedFonts.get(family) === revision) {
      return;
    }
    const existing = this.#fontSyncs.get(family);
    if (existing !== undefined) {
      await existing.promise;
      if (this.#syncedFonts.get(family) === revision) {
        return;
      }
      return this.#ensureFont(family, revision);
    }

    const promise = this.#syncFont(family, revision);
    this.#fontSyncs.set(family, { revision, promise });
    try {
      await promise;
    } finally {
      const current = this.#fontSyncs.get(family);
      if (current?.promise === promise) {
        this.#fontSyncs.delete(family);
      }
    }
  }

  async #syncFont(family: string, revision: number): Promise<void> {
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
    if (response.type !== "ok") {
      throw new Error("Shape worker returned an unexpected font acknowledgement");
    }
    const current = this.#registry.get(family);
    if (current?.revision === revision) {
      this.#syncedFonts.set(family, revision);
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

  #assertActive(): void {
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
