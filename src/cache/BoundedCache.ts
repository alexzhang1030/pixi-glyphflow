export type BoundedCachePolicy = "fifo" | "lru";

export interface BoundedCacheEviction<K, V> {
  readonly key: K;
  readonly value: V;
  readonly bytes: number;
  readonly reason: "capacity";
}

export interface BoundedCacheOptions<K, V> {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly policy?: BoundedCachePolicy;
  readonly sizeOf?: (value: V, key: K) => number;
  readonly onEviction?: (eviction: Readonly<BoundedCacheEviction<K, V>>) => void;
}

export interface BoundedCacheStats {
  readonly policy: BoundedCachePolicy;
  readonly maxEntries: number | undefined;
  readonly maxBytes: number | undefined;
  readonly entries: number;
  readonly bytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly sets: number;
  readonly evictions: number;
  readonly evictedBytes: number;
}

interface CacheEntry<K, V> {
  readonly key: K;
  value: V;
  bytes: number;
  previous: CacheEntry<K, V> | undefined;
  next: CacheEntry<K, V> | undefined;
}

/** A synchronous entry/byte-bounded cache with deterministic FIFO or LRU capacity eviction. */
export class BoundedCache<K, V> {
  readonly #maxEntries: number | undefined;
  readonly #maxBytes: number | undefined;
  readonly #policy: BoundedCachePolicy;
  readonly #sizeOf: (value: V, key: K) => number;
  readonly #onEviction: BoundedCacheOptions<K, V>["onEviction"];
  readonly #entries = new Map<K, CacheEntry<K, V>>();
  #oldest: CacheEntry<K, V> | undefined;
  #newest: CacheEntry<K, V> | undefined;
  #bytes = 0;
  #hits = 0;
  #misses = 0;
  #sets = 0;
  #evictions = 0;
  #evictedBytes = 0;

  constructor(options: Readonly<BoundedCacheOptions<K, V>>) {
    if (options.maxEntries === undefined && options.maxBytes === undefined) {
      throw new TypeError("BoundedCache requires maxEntries or maxBytes");
    }
    if (options.maxEntries !== undefined) {
      assertPositiveSafeInteger("maxEntries", options.maxEntries);
    }
    if (options.maxBytes !== undefined) {
      assertPositiveSafeInteger("maxBytes", options.maxBytes);
      if (options.sizeOf === undefined) {
        throw new TypeError("sizeOf is required when maxBytes is configured");
      }
    }
    this.#maxEntries = options.maxEntries;
    this.#maxBytes = options.maxBytes;
    this.#policy = options.policy ?? "lru";
    if (this.#policy !== "lru" && this.#policy !== "fifo") {
      throw new TypeError("policy must be lru or fifo");
    }
    this.#sizeOf = options.sizeOf ?? (() => 0);
    this.#onEviction = options.onEviction;
  }

  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      this.#misses += 1;
      return undefined;
    }
    this.#hits += 1;
    if (this.#policy === "lru") this.#moveToNewest(entry);
    return entry.value;
  }

  /** Read without changing recency or hit/miss telemetry. */
  peek(key: K): V | undefined {
    return this.#entries.get(key)?.value;
  }

  /** Returns whether the inserted key survived capacity eviction. */
  set(key: K, value: V): boolean {
    const bytes = this.#measure(value, key);
    const existing = this.#entries.get(key);
    const previousBytes = existing?.bytes ?? 0;
    if (existing === undefined) {
      const entry: CacheEntry<K, V> = {
        key,
        value,
        bytes,
        previous: undefined,
        next: undefined,
      };
      this.#entries.set(key, entry);
      this.#append(entry);
    } else if (this.#policy === "lru") {
      existing.value = value;
      existing.bytes = bytes;
      this.#moveToNewest(existing);
    } else {
      existing.value = value;
      existing.bytes = bytes;
    }
    this.#bytes += bytes - previousBytes;
    this.#sets += 1;
    this.#trimToCapacity();
    return this.#entries.has(key);
  }

  delete(key: K): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) return false;
    this.#entries.delete(key);
    this.#unlink(entry);
    this.#bytes -= entry.bytes;
    return true;
  }

  clear(): number {
    const entries = this.#entries.size;
    this.#entries.clear();
    this.#oldest = undefined;
    this.#newest = undefined;
    this.#bytes = 0;
    return entries;
  }

  get stats(): Readonly<BoundedCacheStats> {
    return Object.freeze({
      policy: this.#policy,
      maxEntries: this.#maxEntries,
      maxBytes: this.#maxBytes,
      entries: this.#entries.size,
      bytes: this.#bytes,
      hits: this.#hits,
      misses: this.#misses,
      sets: this.#sets,
      evictions: this.#evictions,
      evictedBytes: this.#evictedBytes,
    });
  }

  #moveToNewest(entry: CacheEntry<K, V>): void {
    if (entry === this.#newest) return;
    this.#unlink(entry);
    this.#append(entry);
  }

  #append(entry: CacheEntry<K, V>): void {
    entry.previous = this.#newest;
    entry.next = undefined;
    if (this.#newest === undefined) this.#oldest = entry;
    else this.#newest.next = entry;
    this.#newest = entry;
  }

  #unlink(entry: CacheEntry<K, V>): void {
    if (entry.previous === undefined) this.#oldest = entry.next;
    else entry.previous.next = entry.next;
    if (entry.next === undefined) this.#newest = entry.previous;
    else entry.next.previous = entry.previous;
    entry.previous = undefined;
    entry.next = undefined;
  }

  #measure(value: V, key: K): number {
    const bytes = this.#sizeOf(value, key);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new TypeError("sizeOf must return a non-negative safe integer");
    }
    return bytes;
  }

  #trimToCapacity(): void {
    const evictions: Array<Readonly<BoundedCacheEviction<K, V>>> | undefined =
      this.#onEviction === undefined ? undefined : [];
    while (
      (this.#maxEntries !== undefined && this.#entries.size > this.#maxEntries) ||
      (this.#maxBytes !== undefined && this.#bytes > this.#maxBytes)
    ) {
      const entry = this.#oldest;
      if (entry === undefined) break;
      this.#entries.delete(entry.key);
      this.#unlink(entry);
      this.#bytes -= entry.bytes;
      this.#evictions += 1;
      this.#evictedBytes += entry.bytes;
      evictions?.push(
        Object.freeze({
          key: entry.key,
          value: entry.value,
          bytes: entry.bytes,
          reason: "capacity",
        }),
      );
    }
    if (evictions !== undefined) {
      for (const eviction of evictions) this.#onEviction?.(eviction);
    }
  }
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}
