import type { WebGPURenderer } from "pixi.js";

export type WebGPUFrameStage = "palette" | "cull";
export type WebGPUFrameCancelReason = "superseded" | "stale" | "destroyed" | "failed";

export interface WebGPUFrameTimestampPlan {
  readonly querySet: GPUQuerySet;
  readonly paletteStartQuery: number;
  readonly paletteEndQuery: number;
  readonly cullStartQuery: number;
  readonly cullEndQuery: number;
}

export interface WebGPUFrameTimestampSummary {
  readonly palettePasses: number;
  readonly cullPasses: number;
}

export interface WebGPUFrameTimestampObserver {
  beginFrame(encoder: GPUCommandEncoder): Readonly<WebGPUFrameTimestampPlan> | undefined;
  endFrame?(summary: Readonly<WebGPUFrameTimestampSummary>): void;
  fail?(error: unknown): void;
}

export interface WebGPUFrameWork {
  encode(encoder: GPUCommandEncoder, timestampWrites?: GPUComputePassTimestampWrites): void;
  complete?(): void;
  cancel?(reason: WebGPUFrameCancelReason): void;
  fail?(error: unknown): void;
}

export interface WebGPUFrameTransactionStats {
  readonly pendingPaletteSlices: number;
  readonly pendingCull: boolean;
  readonly fusedSubmissions: number;
  readonly standaloneSubmissions: number;
  readonly submissions: number;
  readonly queuedPaletteSlices: number;
  readonly queuedCulls: number;
  readonly coalescedCulls: number;
  readonly cancelledWork: number;
  readonly encodedWork: number;
  readonly failedWork: number;
}

export interface WebGPUFrameFlushResult {
  readonly ok: boolean;
  readonly submitted: boolean;
  readonly encodedWork: number;
  readonly reason?: string;
}

interface PendingWork {
  readonly epoch: number;
  readonly work: Readonly<WebGPUFrameWork>;
}

interface FrameWork {
  readonly owner: WebGPUFrameTransaction;
  readonly state: OwnerState;
  readonly stage: WebGPUFrameStage;
  readonly pending: PendingWork;
}

interface ActiveTimestampObservation {
  readonly observer: Readonly<WebGPUFrameTimestampObserver>;
  readonly plan: Readonly<WebGPUFrameTimestampPlan>;
  failed: boolean;
}

interface OwnerState {
  hook: RendererHookState;
  readonly palette: PendingWork[];
  readonly retireCallbacks: Array<() => void>;
  cull: PendingWork | undefined;
  destroyed: boolean;
  finalized: boolean;
  currentEpoch: number;
  fusedSubmissions: number;
  standaloneSubmissions: number;
  queuedPaletteSlices: number;
  queuedCulls: number;
  coalescedCulls: number;
  cancelledWork: number;
  encodedWork: number;
  failedWork: number;
}

type HookableEncoder = WebGPURenderer["encoder"] & {
  commandEncoder: GPUCommandEncoder | null;
  renderStart(...args: unknown[]): void;
  postrender(...args: unknown[]): void;
};

interface RendererHookState {
  readonly renderer: WebGPURenderer;
  readonly encoder: HookableEncoder;
  readonly device: GPUDevice;
  readonly encoderEpoch: number;
  readonly owners: Set<WebGPUFrameTransaction>;
  readonly renderStartSnapshot: RendererLifecycleHookSnapshot;
  readonly postrenderSnapshot: RendererLifecycleHookSnapshot;
  renderStartInstalledOwnDescriptor: PropertyDescriptor | undefined;
  postrenderInstalledOwnDescriptor: PropertyDescriptor | undefined;
  readonly renderStartHook: HookableEncoder["renderStart"];
  readonly postrenderHook: HookableEncoder["postrender"];
  readonly frameOwners: Set<WebGPUFrameTransaction>;
  readonly frameBatch: FrameWork[];
  activeTimestampObservation: ActiveTimestampObservation | undefined;
  retired: boolean;
}

interface RetiredRendererHookWork {
  readonly pendingByState: Array<readonly [OwnerState, PendingWork[]]>;
  readonly frameBatch: FrameWork[];
  readonly timestampObservation: ActiveTimestampObservation | undefined;
}

type RendererLifecycleHookName = "renderStart" | "postrender";

interface RendererLifecycleHookSnapshot {
  readonly name: RendererLifecycleHookName;
  readonly original: HookableEncoder[RendererLifecycleHookName];
  readonly ownDescriptor: PropertyDescriptor | undefined;
}

interface RendererLifecycleHookInstallResult {
  readonly renderStartOwnDescriptor: PropertyDescriptor | undefined;
  readonly postrenderOwnDescriptor: PropertyDescriptor | undefined;
}

const rendererHooks = new WeakMap<WebGPURenderer, RendererHookState>();
const ownerStates = new WeakMap<WebGPUFrameTransaction, OwnerState>();
const rendererLifecyclePassthrough = new WeakMap<
  HookableEncoder,
  Record<RendererLifecycleHookName, number>
>();
const rendererTimestampObservers = new WeakMap<
  WebGPURenderer,
  Set<Readonly<WebGPUFrameTimestampObserver>>
>();

/** Supply renderer-scoped compute-pass timestamp queries for the active product command encoder. */
export function observeWebGPUFrameTimestamps(
  renderer: WebGPURenderer,
  observer: Readonly<WebGPUFrameTimestampObserver>,
): () => void {
  const hook = rendererHooks.get(renderer);
  if (hook !== undefined) ensureRendererHook(hook);
  let observers = rendererTimestampObservers.get(renderer);
  if (observers === undefined) {
    observers = new Set<Readonly<WebGPUFrameTimestampObserver>>();
    rendererTimestampObservers.set(renderer, observers);
  }
  observers.add(observer);
  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    observers?.delete(observer);
    if (observers?.size === 0) rendererTimestampObservers.delete(renderer);
  };
}

/**
 * Collects GPU-resident frame work at Pixi's encoder seam. Palette slices retain commit order; cull
 * work resolves to the latest queued viewport before the scene render pass begins.
 */
export class WebGPUFrameTransaction {
  constructor(renderer: WebGPURenderer) {
    const installed = rendererHooks.get(renderer);
    const hook =
      installed === undefined ? installRendererHooks(renderer) : ensureRendererHook(installed);
    hook.owners.add(this);
    ownerStates.set(this, {
      hook,
      palette: [],
      retireCallbacks: [],
      cull: undefined,
      destroyed: false,
      finalized: false,
      currentEpoch: 0,
      fusedSubmissions: 0,
      standaloneSubmissions: 0,
      queuedPaletteSlices: 0,
      queuedCulls: 0,
      coalescedCulls: 0,
      cancelledWork: 0,
      encodedWork: 0,
      failedWork: 0,
    });
  }

  queue(stage: WebGPUFrameStage, epoch: number, work: Readonly<WebGPUFrameWork>): boolean {
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new RangeError("WebGPU frame epoch must be a non-negative safe integer");
    }
    const state = ownerStates.get(this);
    if (state === undefined || state.destroyed) {
      invokeCancel(work, "destroyed");
      return false;
    }
    try {
      ensureOwnerHook(this, state);
    } catch (error: unknown) {
      invokeFail(work, error);
      state.failedWork += 1;
      return false;
    }
    const pending = { epoch, work };
    if (stage === "palette") {
      state.palette.push(pending);
      state.queuedPaletteSlices += 1;
    } else {
      state.queuedCulls += 1;
      if (state.cull !== undefined) {
        invokeCancel(state.cull.work, "superseded");
        state.coalescedCulls += 1;
        state.cancelledWork += 1;
      }
      state.cull = pending;
    }
    return true;
  }

  get currentEpoch(): number {
    const state = ownerStates.get(this);
    if (state === undefined || state.destroyed) return state?.currentEpoch ?? 0;
    ensureOwnerHook(this, state);
    return state.currentEpoch;
  }

  cancelEpoch(epoch: number): number {
    if (!Number.isSafeInteger(epoch) || epoch < 0) {
      throw new RangeError("WebGPU frame epoch must be a non-negative safe integer");
    }
    const state = ownerStates.get(this);
    if (state === undefined || state.destroyed) return 0;
    ensureOwnerHook(this, state);
    let cancelled = 0;
    for (let index = state.palette.length - 1; index >= 0; index -= 1) {
      const pending = state.palette[index];
      if (pending?.epoch !== epoch) continue;
      state.palette.splice(index, 1);
      invokeCancel(pending.work, "stale");
      cancelled += 1;
    }
    const cull = state.cull;
    if (cull?.epoch === epoch) {
      state.cull = undefined;
      invokeCancel(cull.work, "stale");
      cancelled += 1;
    }
    state.cancelledWork += cancelled;
    if (epoch === state.currentEpoch && cancelled > 0) state.currentEpoch += 1;
    return cancelled;
  }

  flush(): Readonly<WebGPUFrameFlushResult> {
    const state = ownerStates.get(this);
    if (state === undefined || state.destroyed) {
      return Object.freeze({
        ok: false,
        submitted: false,
        encodedWork: 0,
        reason: "WebGPU frame transaction is destroyed",
      });
    }
    try {
      ensureOwnerHook(this, state);
    } catch (error: unknown) {
      return Object.freeze({
        ok: false,
        submitted: false,
        encodedWork: 0,
        reason: errorMessage(error),
      });
    }
    if (state.palette.length === 0 && state.cull === undefined) {
      return Object.freeze({ ok: true, submitted: false, encodedWork: 0 });
    }
    const pending = takeOwnerPending(state);
    let completed = 0;
    try {
      const encoder = state.hook.renderer.gpu.device.createCommandEncoder({
        label: "pixi-glyphflow-frame-transaction-flush",
      });
      for (const entry of pending) {
        entry.work.encode(encoder);
        completed += 1;
      }
      state.hook.renderer.gpu.device.queue.submit([encoder.finish()]);
      for (const entry of pending) invokeComplete(entry.work);
      state.encodedWork += pending.length;
      state.standaloneSubmissions += 1;
      state.currentEpoch += 1;
      return Object.freeze({ ok: true, submitted: true, encodedWork: pending.length });
    } catch (error: unknown) {
      if (completed < pending.length) {
        failPendingBatch(state, pending, completed, error);
      } else {
        failSubmittedBatch(state, pending, error);
      }
      return Object.freeze({
        ok: false,
        submitted: false,
        encodedWork: 0,
        reason: errorMessage(error),
      });
    }
  }

  destroy(retire?: () => void): void {
    const state = ownerStates.get(this);
    if (state === undefined) {
      invokeRetire(retire);
      return;
    }
    if (retire !== undefined) state.retireCallbacks.push(retire);
    if (state.finalized) {
      drainRetireCallbacks(state);
      return;
    }
    if (state.destroyed) return;
    const installedHook = state.hook;
    if (!installedHook.retired && !rendererHookIdentityMatches(installedHook)) {
      state.destroyed = true;
      const hasSurvivingOwner = Array.from(installedHook.owners).some((owner) => {
        if (owner === this) return false;
        const ownerState = ownerStates.get(owner);
        return ownerState !== undefined && !ownerState.destroyed && !ownerState.finalized;
      });
      if (hasSurvivingOwner) {
        try {
          ensureRendererHook(installedHook);
        } catch {
          // Replacement retirement already restored the old hooks and settled this owner.
        }
      } else {
        retireRendererHookEpoch(
          installedHook,
          rendererHookReplacementError(installedHook),
          undefined,
        );
      }
      if (!state.finalized) finalizeOwner(this, state);
      return;
    }
    cancelOwnerPending(state, "destroyed");
    state.destroyed = true;
    const hook = state.hook;
    if (hook.frameBatch.some((entry) => entry.owner === this)) return;
    finalizeOwner(this, state);
  }

  get stats(): Readonly<WebGPUFrameTransactionStats> {
    const state = ownerStates.get(this);
    if (state === undefined) {
      return Object.freeze({
        pendingPaletteSlices: 0,
        pendingCull: false,
        fusedSubmissions: 0,
        standaloneSubmissions: 0,
        submissions: 0,
        queuedPaletteSlices: 0,
        queuedCulls: 0,
        coalescedCulls: 0,
        cancelledWork: 0,
        encodedWork: 0,
        failedWork: 0,
      });
    }
    return Object.freeze({
      pendingPaletteSlices: state.palette.length,
      pendingCull: state.cull !== undefined,
      fusedSubmissions: state.fusedSubmissions,
      standaloneSubmissions: state.standaloneSubmissions,
      submissions: state.fusedSubmissions + state.standaloneSubmissions,
      queuedPaletteSlices: state.queuedPaletteSlices,
      queuedCulls: state.queuedCulls,
      coalescedCulls: state.coalescedCulls,
      cancelledWork: state.cancelledWork,
      encodedWork: state.encodedWork,
      failedWork: state.failedWork,
    });
  }
}

function ensureOwnerHook(owner: WebGPUFrameTransaction, state: OwnerState): void {
  const hook = ensureRendererHook(state.hook);
  if (state.hook === hook) return;
  state.hook.owners.delete(owner);
  hook.owners.add(owner);
  state.hook = hook;
}

function ensureRendererHook(hook: RendererHookState): RendererHookState {
  const renderer = hook.renderer;
  const encoder = renderer.encoder as HookableEncoder;
  const device = renderer.gpu.device;
  const installed = rendererHooks.get(renderer);
  if (
    installed !== undefined &&
    !installed.retired &&
    installed.encoder === encoder &&
    installed.device === device
  ) {
    return installed;
  }
  const previous = installed ?? hook;
  if (previous.encoder === encoder && previous.device !== device) {
    return reinstallRendererHooksOnDeviceReplacement(previous, device);
  }
  let replacement: RendererHookState;
  try {
    replacement = installRendererHooks(renderer, encoder, previous.encoderEpoch + 1, device);
  } catch (error: unknown) {
    retireRendererHookEpoch(previous, rendererHookReplacementError(previous), undefined);
    throw error;
  }
  retireRendererHookEpoch(previous, rendererHookReplacementError(previous), replacement);
  return replacement;
}

function reinstallRendererHooksOnDeviceReplacement(
  previous: RendererHookState,
  device: GPUDevice,
): RendererHookState {
  const retiredWork = beginRendererHookRetirement(previous);
  if (rendererHooks.get(previous.renderer) === previous) {
    rendererHooks.delete(previous.renderer);
  }
  restoreRendererHookState(previous);
  let replacement: RendererHookState;
  try {
    replacement = installRendererHooks(
      previous.renderer,
      previous.encoder,
      previous.encoderEpoch + 1,
      device,
    );
  } catch (error: unknown) {
    finishRendererHookRetirement(
      previous,
      rendererHookReplacementError(previous),
      undefined,
      retiredWork,
    );
    throw error;
  }
  finishRendererHookRetirement(
    previous,
    rendererHookReplacementError(previous),
    replacement,
    retiredWork,
  );
  return replacement;
}

function installRendererHooks(
  renderer: WebGPURenderer,
  encoder = renderer.encoder as HookableEncoder,
  encoderEpoch = 0,
  device = renderer.gpu.device,
): RendererHookState {
  const originalRenderStart = encoder.renderStart;
  const originalPostrender = encoder.postrender;
  if (typeof originalRenderStart !== "function" || typeof originalPostrender !== "function") {
    throw new TypeError("WebGPU frame transactions require Pixi encoder lifecycle hooks");
  }
  const renderStartSnapshot = captureRendererLifecycleHook(
    encoder,
    "renderStart",
    originalRenderStart,
  );
  const postrenderSnapshot = captureRendererLifecycleHook(
    encoder,
    "postrender",
    originalPostrender,
  );
  const state: RendererHookState = {
    renderer,
    encoder,
    device,
    encoderEpoch,
    owners: new Set<WebGPUFrameTransaction>(),
    renderStartSnapshot,
    postrenderSnapshot,
    renderStartInstalledOwnDescriptor: undefined,
    postrenderInstalledOwnDescriptor: undefined,
    renderStartHook: originalRenderStart,
    postrenderHook: originalPostrender,
    frameOwners: new Set<WebGPUFrameTransaction>(),
    frameBatch: [],
    activeTimestampObservation: undefined,
    retired: false,
  };
  const renderStartHook: HookableEncoder["renderStart"] = function (
    this: HookableEncoder,
    ...args
  ): void {
    if (state.retired) {
      if (isRendererLifecyclePassthroughActive(this, "renderStart")) {
        originalRenderStart.apply(this, args);
      }
      return;
    }
    if (!prepareRendererRenderStartInvocation(state, this, args)) return;
    executeRendererRenderStart(state, this, args, originalRenderStart);
  };
  const postrenderHook: HookableEncoder["postrender"] = function (
    this: HookableEncoder,
    ...args
  ): void {
    if (state.retired) {
      if (isRendererLifecyclePassthroughActive(this, "postrender")) {
        originalPostrender.apply(this, args);
      }
      return;
    }
    if (!prepareRendererHookInvocation(state, this)) return;
    try {
      invokeRendererLifecycleOriginal(this, "postrender", originalPostrender, args);
    } catch (error: unknown) {
      failFrameSubmission(state, error);
      throw error;
    }
    for (const entry of state.frameBatch) {
      invokeComplete(entry.pending.work);
      entry.state.encodedWork += 1;
    }
    for (const owner of state.frameOwners) {
      const ownerState = ownerStates.get(owner);
      if (ownerState !== undefined) {
        ownerState.fusedSubmissions += 1;
        ownerState.currentEpoch += 1;
      }
    }
    state.frameOwners.clear();
    state.frameBatch.length = 0;
    state.activeTimestampObservation = undefined;
    finalizeDestroyedOwners(state);
  };
  Object.assign(state, { renderStartHook, postrenderHook });
  const installed = installRendererLifecycleHooks(
    encoder,
    renderStartSnapshot,
    postrenderSnapshot,
    renderStartHook,
    postrenderHook,
  );
  state.renderStartInstalledOwnDescriptor = installed.renderStartOwnDescriptor;
  state.postrenderInstalledOwnDescriptor = installed.postrenderOwnDescriptor;
  rendererHooks.set(renderer, state);
  return state;
}

function executeRendererRenderStart(
  state: RendererHookState,
  encoder: HookableEncoder,
  args: unknown[],
  originalRenderStart: HookableEncoder["renderStart"],
): void {
  if (state.frameBatch.length > 0) {
    failFrameSubmission(state, new Error("previous Pixi frame was not submitted"));
  }
  state.frameOwners.clear();
  invokeRendererLifecycleOriginal(encoder, "renderStart", originalRenderStart, args);
  if (!prepareRendererHookInvocation(state, encoder)) return;
  const commandEncoder = encoder.commandEncoder;
  if (commandEncoder === null) {
    throw new Error("Pixi renderStart completed without a WebGPU command encoder");
  }
  const snapshot = takeFrameSnapshot(state);
  state.frameBatch.push(...snapshot);
  const palettePasses = snapshot.findIndex((entry) => entry.stage === "cull");
  const paletteCount = palettePasses < 0 ? snapshot.length : palettePasses;
  const cullCount = snapshot.length - paletteCount;
  const timestampObservation = beginFrameTimestampObservation(state, commandEncoder);
  state.activeTimestampObservation = timestampObservation;
  let index = 0;
  try {
    for (; index < paletteCount; index += 1) {
      snapshot[index]?.pending.work.encode(
        commandEncoder,
        timestampWritesForWork(timestampObservation?.plan, "palette", index, paletteCount),
      );
    }
    for (; index < snapshot.length; index += 1) {
      snapshot[index]?.pending.work.encode(
        commandEncoder,
        timestampWritesForWork(timestampObservation?.plan, "cull", index - paletteCount, cullCount),
      );
    }
    endFrameTimestampObservation(timestampObservation, {
      palettePasses: paletteCount,
      cullPasses: cullCount,
    });
  } catch (error: unknown) {
    failTimestampObservation(timestampObservation, error);
    failFrameSnapshot(state, snapshot, index, error);
    throw error;
  }
  for (const entry of snapshot) {
    state.frameOwners.add(entry.owner);
  }
}

function prepareRendererRenderStartInvocation(
  state: RendererHookState,
  encoder: HookableEncoder,
  args: unknown[],
): boolean {
  if (state.retired) return false;
  if (
    encoder === state.encoder &&
    rendererHookIdentityMatches(state) &&
    rendererHooks.get(state.renderer) === state
  ) {
    return true;
  }
  if (!rendererHookIdentityMatches(state)) {
    const invokedAsInstalledHook = encoder.renderStart === state.renderStartHook;
    const replacement = ensureRendererHook(state);
    if (replacement.encoder === encoder) {
      if (invokedAsInstalledHook) {
        replacement.renderStartHook.apply(encoder, args);
      } else {
        executeRendererRenderStart(replacement, encoder, args, state.renderStartSnapshot.original);
      }
    }
  }
  return false;
}

function invokeRendererLifecycleOriginal(
  encoder: HookableEncoder,
  name: RendererLifecycleHookName,
  original: HookableEncoder[RendererLifecycleHookName],
  args: unknown[],
): void {
  let depth = rendererLifecyclePassthrough.get(encoder);
  if (depth === undefined) {
    depth = { renderStart: 0, postrender: 0 };
    rendererLifecyclePassthrough.set(encoder, depth);
  }
  depth[name] += 1;
  try {
    original.apply(encoder, args);
  } finally {
    depth[name] -= 1;
    if (depth.renderStart === 0 && depth.postrender === 0) {
      rendererLifecyclePassthrough.delete(encoder);
    }
  }
}

function isRendererLifecyclePassthroughActive(
  encoder: HookableEncoder,
  name: RendererLifecycleHookName,
): boolean {
  return (rendererLifecyclePassthrough.get(encoder)?.[name] ?? 0) > 0;
}

function prepareRendererHookInvocation(
  state: RendererHookState,
  encoder: HookableEncoder,
): boolean {
  if (state.retired) return false;
  if (
    encoder === state.encoder &&
    rendererHookIdentityMatches(state) &&
    rendererHooks.get(state.renderer) === state
  ) {
    return true;
  }
  if (!rendererHookIdentityMatches(state)) ensureRendererHook(state);
  return false;
}

function retireRendererHookEpoch(
  hook: RendererHookState,
  error: unknown,
  replacement: RendererHookState | undefined,
): void {
  const retiredWork = beginRendererHookRetirement(hook);
  finishRendererHookRetirement(hook, error, replacement, retiredWork);
}

function beginRendererHookRetirement(hook: RendererHookState): RetiredRendererHookWork {
  if (hook.retired) {
    return { pendingByState: [], frameBatch: [], timestampObservation: undefined };
  }
  const pendingByState: Array<readonly [OwnerState, PendingWork[]]> = [];
  for (const owner of hook.owners) {
    const state = ownerStates.get(owner);
    if (state === undefined || state.hook !== hook) continue;
    const pending = takeOwnerPending(state);
    if (pending.length > 0) pendingByState.push([state, pending]);
  }
  const frameBatch = hook.frameBatch.splice(0);
  const timestampObservation = hook.activeTimestampObservation;
  hook.activeTimestampObservation = undefined;
  hook.frameOwners.clear();
  hook.retired = true;
  return { pendingByState, frameBatch, timestampObservation };
}

function finishRendererHookRetirement(
  hook: RendererHookState,
  error: unknown,
  replacement: RendererHookState | undefined,
  retiredWork: RetiredRendererHookWork,
): void {
  if (replacement !== undefined) {
    for (const owner of Array.from(hook.owners)) {
      const state = ownerStates.get(owner);
      if (state === undefined || state.hook !== hook || state.destroyed || state.finalized) {
        continue;
      }
      hook.owners.delete(owner);
      replacement.owners.add(owner);
      state.hook = replacement;
    }
  } else if (rendererHooks.get(hook.renderer) === hook) {
    rendererHooks.delete(hook.renderer);
  }

  restoreRendererHookState(hook);
  failTimestampObservation(retiredWork.timestampObservation, error);
  for (const entry of retiredWork.frameBatch) {
    invokeFail(entry.pending.work, error);
    entry.state.failedWork += 1;
  }
  for (const [state, pending] of retiredWork.pendingByState) {
    for (const entry of pending) invokeCancel(entry.work, "stale");
    state.cancelledWork += pending.length;
  }
  finalizeDestroyedOwners(hook);
  if (replacement !== undefined && replacement.owners.size === 0 && !replacement.retired) {
    retireRendererHookEpoch(replacement, error, undefined);
  }
}

function rendererHookIdentityMatches(hook: RendererHookState): boolean {
  return hook.renderer.encoder === hook.encoder && hook.renderer.gpu.device === hook.device;
}

function rendererHookReplacementError(hook: RendererHookState): Error {
  return new Error(
    `Pixi WebGPU encoder or device was replaced during frame transaction epoch ${String(hook.encoderEpoch)}`,
  );
}

function restoreRendererHookState(hook: RendererHookState): void {
  restoreRendererLifecycleHookIfCurrent(
    hook.encoder,
    hook.postrenderSnapshot,
    hook.postrenderHook,
    hook.postrenderInstalledOwnDescriptor,
  );
  restoreRendererLifecycleHookIfCurrent(
    hook.encoder,
    hook.renderStartSnapshot,
    hook.renderStartHook,
    hook.renderStartInstalledOwnDescriptor,
  );
}

function installRendererLifecycleHooks(
  encoder: HookableEncoder,
  renderStartSnapshot: RendererLifecycleHookSnapshot,
  postrenderSnapshot: RendererLifecycleHookSnapshot,
  renderStartHook: HookableEncoder["renderStart"],
  postrenderHook: HookableEncoder["postrender"],
): RendererLifecycleHookInstallResult {
  const assignments: RendererLifecycleHookSnapshot[] = [];
  try {
    const renderStartOwnDescriptor = assignRendererLifecycleHook(
      encoder,
      renderStartSnapshot,
      renderStartHook,
      assignments,
    );
    const postrenderOwnDescriptor = assignRendererLifecycleHook(
      encoder,
      postrenderSnapshot,
      postrenderHook,
      assignments,
    );
    return { renderStartOwnDescriptor, postrenderOwnDescriptor };
  } catch (error: unknown) {
    rollbackRendererLifecycleHooks(encoder, assignments);
    throw error;
  }
}

function captureRendererLifecycleHook(
  encoder: HookableEncoder,
  name: RendererLifecycleHookName,
  original: HookableEncoder[RendererLifecycleHookName],
): RendererLifecycleHookSnapshot {
  return {
    name,
    original,
    ownDescriptor: Object.getOwnPropertyDescriptor(encoder, name),
  };
}

function assignRendererLifecycleHook(
  encoder: HookableEncoder,
  snapshot: RendererLifecycleHookSnapshot,
  hook: HookableEncoder[RendererLifecycleHookName],
  assignments: RendererLifecycleHookSnapshot[],
): PropertyDescriptor | undefined {
  assignments.push(snapshot);
  if (!Reflect.set(encoder, snapshot.name, hook) || Reflect.get(encoder, snapshot.name) !== hook) {
    throw new TypeError(`Pixi encoder ${snapshot.name} hook is not writable`);
  }
  return Object.getOwnPropertyDescriptor(encoder, snapshot.name);
}

function rollbackRendererLifecycleHooks(
  encoder: HookableEncoder,
  assignments: readonly RendererLifecycleHookSnapshot[],
): void {
  for (let index = assignments.length - 1; index >= 0; index -= 1) {
    const snapshot = assignments[index];
    if (snapshot !== undefined) restoreRendererLifecycleHook(encoder, snapshot);
  }
}

function restoreRendererLifecycleHook(
  encoder: HookableEncoder,
  snapshot: RendererLifecycleHookSnapshot,
): void {
  try {
    if (Reflect.get(encoder, snapshot.name) !== snapshot.original) {
      Reflect.set(encoder, snapshot.name, snapshot.original);
    }
  } catch {
    // Descriptor restoration below still runs when a setter rejects value cleanup.
  }
  try {
    if (snapshot.ownDescriptor === undefined) {
      Reflect.deleteProperty(encoder, snapshot.name);
    } else {
      Object.defineProperty(encoder, snapshot.name, snapshot.ownDescriptor);
    }
  } catch {
    // Preserve the lifecycle operation error after best-effort descriptor restoration.
  }
}

function restoreRendererLifecycleHookIfCurrent(
  encoder: HookableEncoder,
  snapshot: RendererLifecycleHookSnapshot,
  hook: HookableEncoder[RendererLifecycleHookName],
  installedOwnDescriptor: PropertyDescriptor | undefined,
): void {
  try {
    if (Reflect.get(encoder, snapshot.name) !== hook) return;
  } catch {
    return;
  }
  let descriptorBefore: PropertyDescriptor | undefined;
  try {
    descriptorBefore = Object.getOwnPropertyDescriptor(encoder, snapshot.name);
  } catch {
    return;
  }
  const ownsPlacement = sameRendererLifecycleHookPlacement(
    descriptorBefore,
    installedOwnDescriptor,
  );
  try {
    Reflect.set(encoder, snapshot.name, snapshot.original);
  } catch {
    // Descriptor provenance below still determines whether exact placement can be restored.
  }
  if (!ownsPlacement) return;
  let descriptorAfter: PropertyDescriptor | undefined;
  try {
    descriptorAfter = Object.getOwnPropertyDescriptor(encoder, snapshot.name);
  } catch {
    return;
  }
  if (!sameRendererLifecycleHookPlacement(descriptorBefore, descriptorAfter)) return;
  restoreRendererLifecycleHookPlacement(encoder, snapshot);
}

function sameRendererLifecycleHookPlacement(
  left: PropertyDescriptor | undefined,
  right: PropertyDescriptor | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftIsData = "value" in left;
  const rightIsData = "value" in right;
  if (leftIsData !== rightIsData) return false;
  if (left.configurable !== right.configurable || left.enumerable !== right.enumerable)
    return false;
  if (leftIsData) return left.writable === right.writable;
  return left.get === right.get && left.set === right.set;
}

function restoreRendererLifecycleHookPlacement(
  encoder: HookableEncoder,
  snapshot: RendererLifecycleHookSnapshot,
): void {
  try {
    if (snapshot.ownDescriptor === undefined) {
      Reflect.deleteProperty(encoder, snapshot.name);
    } else {
      Object.defineProperty(encoder, snapshot.name, snapshot.ownDescriptor);
    }
  } catch {
    // Final hook teardown remains best-effort when a host descriptor rejects restoration.
  }
}

function takeFrameSnapshot(hook: RendererHookState): FrameWork[] {
  const owners: Array<readonly [WebGPUFrameTransaction, OwnerState]> = [];
  for (const owner of hook.owners) {
    const state = ownerStates.get(owner);
    if (state !== undefined && !state.destroyed) owners.push([owner, state]);
  }
  const snapshot: FrameWork[] = [];
  for (const [owner, state] of owners) {
    const palette = state.palette.splice(0);
    for (const pending of palette) snapshot.push({ owner, state, stage: "palette", pending });
  }
  for (const [owner, state] of owners) {
    const pending = state.cull;
    if (pending === undefined) continue;
    state.cull = undefined;
    snapshot.push({ owner, state, stage: "cull", pending });
  }
  return snapshot;
}

function beginFrameTimestampObservation(
  hook: RendererHookState,
  encoder: GPUCommandEncoder,
): ActiveTimestampObservation | undefined {
  const observers = rendererTimestampObservers.get(hook.renderer);
  if (observers === undefined) return undefined;
  let active: ActiveTimestampObservation | undefined;
  for (const observer of observers) {
    try {
      const plan = observer.beginFrame(encoder);
      if (plan === undefined) continue;
      validateTimestampPlan(plan);
      if (active !== undefined) {
        throw new Error("WebGPU frame timestamp observation is already active");
      }
      active = { observer, plan, failed: false };
    } catch (error: unknown) {
      try {
        observer.fail?.(error);
      } catch {
        // Diagnostic observers keep product work independent from telemetry failures.
      }
    }
  }
  return active;
}

function validateTimestampPlan(plan: Readonly<WebGPUFrameTimestampPlan>): void {
  for (const queryIndex of [
    plan.paletteStartQuery,
    plan.paletteEndQuery,
    plan.cullStartQuery,
    plan.cullEndQuery,
  ]) {
    if (!Number.isSafeInteger(queryIndex) || queryIndex < 0) {
      throw new RangeError("WebGPU frame timestamp query indices must be non-negative integers");
    }
  }
}

function timestampWritesForWork(
  plan: Readonly<WebGPUFrameTimestampPlan> | undefined,
  stage: WebGPUFrameStage,
  stageIndex: number,
  stageCount: number,
): GPUComputePassTimestampWrites | undefined {
  if (plan === undefined || stageCount === 0) return undefined;
  const first = stageIndex === 0;
  const last = stageIndex === stageCount - 1;
  const startQuery = stage === "palette" ? plan.paletteStartQuery : plan.cullStartQuery;
  const endQuery = stage === "palette" ? plan.paletteEndQuery : plan.cullEndQuery;
  return {
    querySet: plan.querySet,
    ...(first ? { beginningOfPassWriteIndex: startQuery } : {}),
    ...(last ? { endOfPassWriteIndex: endQuery } : {}),
  };
}

function endFrameTimestampObservation(
  observation: ActiveTimestampObservation | undefined,
  summary: Readonly<WebGPUFrameTimestampSummary>,
): void {
  if (observation === undefined) return;
  try {
    observation.observer.endFrame?.(Object.freeze(summary));
  } catch (error: unknown) {
    failTimestampObservation(observation, error);
  }
}

function failTimestampObservation(
  observation: ActiveTimestampObservation | undefined,
  error: unknown,
): void {
  if (observation === undefined || observation.failed) return;
  observation.failed = true;
  try {
    observation.observer.fail?.(error);
  } catch {
    // Product failure and diagnostic failure retain independent ownership.
  }
}

function failFrameSnapshot(
  hook: RendererHookState,
  snapshot: readonly FrameWork[],
  failedIndex: number,
  error: unknown,
): void {
  const failed = snapshot[failedIndex];
  if (failed !== undefined) {
    invokeFail(failed.pending.work, error);
    failed.state.failedWork += 1;
  }
  for (let index = 0; index < snapshot.length; index += 1) {
    if (index === failedIndex) continue;
    const entry = snapshot[index];
    if (entry === undefined) continue;
    invokeCancel(entry.pending.work, "failed");
    entry.state.cancelledWork += 1;
  }
  const states = new Set(snapshot.map((entry) => entry.state));
  for (const owner of hook.owners) {
    const state = ownerStates.get(owner);
    if (state !== undefined) states.add(state);
  }
  for (const state of states) cancelOwnerPending(state, "failed");
  hook.frameOwners.clear();
  hook.frameBatch.length = 0;
  hook.activeTimestampObservation = undefined;
  finalizeDestroyedOwners(hook);
}

function failFrameSubmission(hook: RendererHookState, error: unknown): void {
  failTimestampObservation(hook.activeTimestampObservation, error);
  hook.activeTimestampObservation = undefined;
  for (const entry of hook.frameBatch) {
    invokeFail(entry.pending.work, error);
    entry.state.failedWork += 1;
  }
  hook.frameBatch.length = 0;
  hook.frameOwners.clear();
  finalizeDestroyedOwners(hook);
}

function finalizeDestroyedOwners(hook: RendererHookState): void {
  for (const owner of Array.from(hook.owners)) {
    const state = ownerStates.get(owner);
    if (state !== undefined && state.destroyed && !state.finalized) finalizeOwner(owner, state);
  }
}

function finalizeOwner(owner: WebGPUFrameTransaction, state: OwnerState): void {
  if (state.finalized) return;
  const hook = state.hook;
  hook.owners.delete(owner);
  hook.frameOwners.delete(owner);
  state.finalized = true;
  if (hook.owners.size === 0) {
    restoreRendererHookState(hook);
    if (rendererHooks.get(hook.renderer) === hook) rendererHooks.delete(hook.renderer);
  }
  drainRetireCallbacks(state);
}

function drainRetireCallbacks(state: OwnerState): void {
  const callbacks = state.retireCallbacks.splice(0);
  for (const callback of callbacks) invokeRetire(callback);
}

function invokeRetire(retire: (() => void) | undefined): void {
  if (retire === undefined) return;
  try {
    retire();
  } catch {
    // Resource retirement stays isolated from renderer hook restoration.
  }
}

function takeOwnerPending(state: OwnerState): PendingWork[] {
  const pending = state.palette.splice(0);
  if (state.cull !== undefined) {
    pending.push(state.cull);
    state.cull = undefined;
  }
  return pending;
}

function cancelOwnerPending(state: OwnerState, reason: WebGPUFrameCancelReason): number {
  const pending = takeOwnerPending(state);
  for (const entry of pending) invokeCancel(entry.work, reason);
  state.cancelledWork += pending.length;
  return pending.length;
}

function failPendingBatch(
  state: OwnerState,
  pending: readonly PendingWork[],
  failedIndex: number,
  error: unknown,
): void {
  const failed = pending[failedIndex];
  if (failed !== undefined) invokeFail(failed.work, error);
  state.failedWork += failed === undefined ? 0 : 1;
  for (let index = 0; index < pending.length; index += 1) {
    if (index === failedIndex) continue;
    const entry = pending[index];
    if (entry !== undefined) invokeCancel(entry.work, "failed");
  }
  state.cancelledWork += Math.max(0, pending.length - 1);
}

function failSubmittedBatch(
  state: OwnerState,
  pending: readonly PendingWork[],
  error: unknown,
): void {
  for (const entry of pending) invokeFail(entry.work, error);
  state.failedWork += pending.length;
}

function invokeComplete(work: Readonly<WebGPUFrameWork>): void {
  try {
    work.complete?.();
  } catch {
    // Completion observers cannot change an accepted queue submission.
  }
}

function invokeFail(work: Readonly<WebGPUFrameWork>, error: unknown): void {
  try {
    work.fail?.(error);
  } catch {
    // Failure observation stays isolated from fallback control flow.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invokeCancel(work: Readonly<WebGPUFrameWork>, reason: WebGPUFrameCancelReason): void {
  try {
    work.cancel?.(reason);
  } catch {
    // Cancellation completes even when observer telemetry throws.
  }
}
