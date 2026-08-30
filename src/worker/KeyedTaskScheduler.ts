export interface KeyedTaskSchedulerOptions {
  readonly maxQueueDepth: number;
}

export interface KeyedTaskSchedulerStats {
  readonly depth: number;
  readonly active: number;
  readonly queued: number;
  readonly peakDepth: number;
  readonly overflows: number;
  readonly cancellations: number;
}

interface ScheduledTask<Metadata> {
  readonly metadata: Metadata;
  readonly run: () => Promise<void>;
  readonly cancel: (error: Error) => void;
}

interface TaskLane<Metadata> {
  active: boolean;
  readonly queued: ScheduledTask<Metadata>[];
}

export class WorkerQueueOverflowError extends Error {
  readonly maxQueueDepth: number;

  constructor(maxQueueDepth: number) {
    super(`Shape worker queue reached its capacity of ${String(maxQueueDepth)}`);
    this.name = "WorkerQueueOverflowError";
    this.maxQueueDepth = maxQueueDepth;
  }
}

/** @internal */
export class KeyedTaskScheduler<Metadata> {
  readonly #maxQueueDepth: number;
  readonly #lanes = new Map<string, TaskLane<Metadata>>();
  readonly #idleResolvers = new Set<() => void>();
  #depth = 0;
  #active = 0;
  #peakDepth = 0;
  #overflows = 0;
  #cancellations = 0;
  #closedError: Error | undefined;

  constructor(options: KeyedTaskSchedulerOptions) {
    if (!Number.isSafeInteger(options.maxQueueDepth) || options.maxQueueDepth <= 0) {
      throw new TypeError("maxQueueDepth must be a positive safe integer");
    }
    this.#maxQueueDepth = options.maxQueueDepth;
  }

  schedule<Result>(
    key: string,
    metadata: Metadata,
    operation: () => Result | PromiseLike<Result>,
  ): Promise<Result> {
    if (this.#closedError !== undefined) {
      throw this.#closedError;
    }
    if (this.#depth >= this.#maxQueueDepth) {
      this.#overflows += 1;
      throw new WorkerQueueOverflowError(this.#maxQueueDepth);
    }

    let lane = this.#lanes.get(key);
    if (lane === undefined) {
      lane = { active: false, queued: [] };
      this.#lanes.set(key, lane);
    }
    const taskLane = lane;
    let resolve!: (value: Result | PromiseLike<Result>) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<Result>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    const task: ScheduledTask<Metadata> = {
      metadata,
      run: async () => {
        try {
          const value = await operation();
          this.#complete(key, taskLane);
          resolve(value);
        } catch (error) {
          this.#complete(key, taskLane);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      cancel: reject,
    };
    lane.queued.push(task);
    this.#depth += 1;
    this.#peakDepth = Math.max(this.#peakDepth, this.#depth);
    this.#start(key, lane);

    return result;
  }

  cancelQueued(
    predicate: (metadata: Metadata) => boolean,
    errorFor: (metadata: Metadata) => Error,
  ): number {
    let cancelled = 0;
    for (const [key, lane] of this.#lanes) {
      let write = 0;
      for (const task of lane.queued) {
        if (predicate(task.metadata)) {
          task.cancel(errorFor(task.metadata));
          cancelled += 1;
          continue;
        }
        lane.queued[write] = task;
        write += 1;
      }
      lane.queued.length = write;
      if (!lane.active && lane.queued.length === 0) {
        this.#lanes.delete(key);
      }
    }
    this.#depth -= cancelled;
    this.#cancellations += cancelled;
    this.#resolveIdle();

    return cancelled;
  }

  close(error: Error): number {
    if (this.#closedError !== undefined) {
      return 0;
    }
    this.#closedError = error;

    return this.cancelQueued(
      () => true,
      () => error,
    );
  }

  whenIdle(): Promise<void> {
    if (this.#depth === 0) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.#idleResolvers.add(resolve);
    });
  }

  get stats(): Readonly<KeyedTaskSchedulerStats> {
    return Object.freeze({
      depth: this.#depth,
      active: this.#active,
      queued: this.#depth - this.#active,
      peakDepth: this.#peakDepth,
      overflows: this.#overflows,
      cancellations: this.#cancellations,
    });
  }

  #start(key: string, lane: TaskLane<Metadata>): void {
    if (lane.active) return;
    const task = lane.queued.shift();
    if (task === undefined) {
      this.#lanes.delete(key);
      return;
    }
    lane.active = true;
    this.#active += 1;
    queueMicrotask(() => {
      void task.run();
    });
  }

  #complete(key: string, lane: TaskLane<Metadata>): void {
    lane.active = false;
    this.#active -= 1;
    this.#depth -= 1;
    this.#start(key, lane);
    this.#resolveIdle();
  }

  #resolveIdle(): void {
    if (this.#depth !== 0) return;
    for (const resolve of this.#idleResolvers) {
      resolve();
    }
    this.#idleResolvers.clear();
  }
}
