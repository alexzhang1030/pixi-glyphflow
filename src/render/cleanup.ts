export interface CleanupFailure {
  readonly error: unknown;
}

/** Runs every cleanup step once and retains the first thrown value. */
export function cleanupBestEffort(
  cleanupSteps: Iterable<() => void>,
): Readonly<CleanupFailure> | undefined {
  let firstFailure: CleanupFailure | undefined;
  for (const cleanup of cleanupSteps) {
    try {
      cleanup();
    } catch (error: unknown) {
      firstFailure ??= { error };
    }
  }
  return firstFailure;
}

export function cleanupBestEffortOrThrow(cleanupSteps: Iterable<() => void>): void {
  const failure = cleanupBestEffort(cleanupSteps);
  if (failure !== undefined) throw failure.error;
}
