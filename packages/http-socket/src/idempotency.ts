import { Injectable } from '@spinajs/di';
import type { IdempotentReply, ISocketIdempotencyConfig } from './interfaces.js';

const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_MAX_ENTRIES = 100_000;

export type IdempotencyRecord = { readonly state: 'running' } | { readonly state: 'done'; readonly reply: IdempotentReply };

/**
 * Remembers the outcome of idempotent commands by one key per principal, clientId and idempotency key.
 * A store shared by several instances ( Redis, ORM ) must make `claim` atomic, and should expire the
 * running claims of an instance that died.
 */
export abstract class IdempotencyStore {
  /** Claims a free key as running and returns null, or returns the record that already holds it; atomic. */
  public abstract claim(key: string): Promise<IdempotencyRecord | null>;

  public abstract complete(key: string, reply: IdempotentReply, ttlMs: number): Promise<void>;

  /** Drops a running claim whose command produced no outcome, so a resend runs it again; never a completed key. */
  public abstract release(key: string): Promise<void>;

  public abstract get(key: string): Promise<IdempotencyRecord | null>;
}

interface IMemoryEntry {
  record: IdempotencyRecord;
  expiresAt: number;
}

/** Process memory: exactly-once across disconnects and graceful restarts, not across crashes. */
@Injectable(IdempotencyStore)
export class MemoryIdempotencyStore extends IdempotencyStore {
  protected entries = new Map<string, IMemoryEntry>();
  protected maxEntries: number;

  constructor(options: Partial<ISocketIdempotencyConfig> = {}, protected now: () => number = () => Date.now()) {
    super();
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  public get Size(): number {
    return this.entries.size;
  }

  public async claim(key: string): Promise<IdempotencyRecord | null> {
    const held = this.lookup(key);
    if (held) {
      return held;
    }

    this.entries.set(key, { record: { state: 'running' }, expiresAt: Number.POSITIVE_INFINITY });
    return null;
  }

  public async complete(key: string, reply: IdempotentReply, ttlMs: number): Promise<void> {
    // re-inserted: Map order is the LRU order
    this.entries.delete(key);
    this.entries.set(key, { record: { state: 'done', reply }, expiresAt: this.now() + ttlMs });
    this.evict();
  }

  public async release(key: string): Promise<void> {
    if (this.entries.get(key)?.record.state === 'running') {
      this.entries.delete(key);
    }
  }

  public async get(key: string): Promise<IdempotencyRecord | null> {
    return this.lookup(key);
  }

  protected lookup(key: string): IdempotencyRecord | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }

    if (entry.record.state === 'done') {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }

    return entry.record;
  }

  protected evict(): void {
    const now = this.now();
    let done = [...this.entries.values()].filter((e) => e.record.state === 'done').length;

    for (const [key, entry] of this.entries) {
      if (entry.record.state === 'running') {
        continue;
      }

      if (done <= this.maxEntries && entry.expiresAt > now) {
        // under the cap: the remaining expired keys go lazily, on lookup
        break;
      }

      this.entries.delete(key);
      done--;
    }
  }
}

export function assertIdempotencyConfig(options: ISocketIdempotencyConfig): void {
  if (!(typeof options?.service === 'string' && options.service.length > 0)) {
    throw new RangeError(`http.socket.idempotency.service must name an IdempotencyStore class, got ${JSON.stringify(options?.service)}`);
  }

  if (!(typeof options.ttlMs === 'number' && options.ttlMs > 0 && options.ttlMs <= MAX_TIMER_MS)) {
    throw new RangeError(`http.socket.idempotency.ttlMs must be within (0, ${MAX_TIMER_MS}], got ${String(options.ttlMs)}`);
  }

  if (!(Number.isInteger(options.maxEntries) && options.maxEntries > 0)) {
    throw new RangeError(`http.socket.idempotency.maxEntries must be an integer above 0, got ${String(options.maxEntries)}`);
  }
}
