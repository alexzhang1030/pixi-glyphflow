/** @internal */
export class WorkerFontRevisions {
  readonly #active = new Map<string, number>();
  readonly #latest = new Map<string, number>();

  beginRegistration(family: string, revision: number): boolean {
    assertRevision(revision);
    const latest = this.#latest.get(family);
    if (latest !== undefined && revision < latest) {
      throw new RangeError(
        `Worker font revision ${String(revision)} precedes current revision ${String(latest)}`,
      );
    }
    if (this.#active.get(family) === revision) {
      return false;
    }
    this.#latest.set(family, revision);

    return true;
  }

  activate(family: string, revision: number): void {
    if (this.#latest.get(family) !== revision) {
      throw new RangeError(`Worker font revision ${String(revision)} has not been registered`);
    }
    this.#active.set(family, revision);
  }

  unregister(family: string): boolean {
    return this.#active.delete(family);
  }

  active(family: string): number | undefined {
    return this.#active.get(family);
  }

  clear(): void {
    this.#active.clear();
    this.#latest.clear();
  }
}

function assertRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError("fontRevision must be a non-negative safe integer");
  }
}
