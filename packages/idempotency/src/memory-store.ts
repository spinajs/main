import { randomUUID } from 'node:crypto';
import { Injectable } from '@spinajs/di';
import { InvalidArgument } from '@spinajs/exceptions';
import { IdempotencyStore } from './store.js';
import type { IdempotencyClaim, IdempotencyClaimOptions, IdempotencyHeld, StoredReply } from './interfaces.js';

interface IEntry {
  state: 'running' | 'done';
  token: string;
  leaseUntil: number;
  fingerprint?: string;
  reply?: StoredReply;
  expiresAt?: number;
}

const DEFAULT_MAX_ENTRIES = 100_000;

/** Process memory: one replica, lost on restart. `maxEntries` caps completed keys; the oldest completion goes first. */
@Injectable(IdempotencyStore)
export class MemoryIdempotencyStore extends IdempotencyStore {
  protected entries = new Map<string, IEntry>();
  protected doneCount = 0;
  protected readonly maxEntries: number;

  constructor(options: { maxEntries?: number } = {}) {
    super();
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    if (!(Number.isInteger(this.maxEntries) && this.maxEntries > 0)) {
      throw new InvalidArgument(`maxEntries must be an integer above 0, got ${String(options.maxEntries)}`);
    }
  }

  public get Size(): number {
    return this.entries.size;
  }

  public async claim(key: string, opts: IdempotencyClaimOptions): Promise<IdempotencyClaim> {
    const held = this.held(key, opts.now);
    if (held) {
      return held;
    }

    this.drop(key);
    const token = randomUUID();
    this.entries.set(key, { state: 'running', token, leaseUntil: opts.now + opts.leaseMs, ...(opts.fingerprint === undefined ? {} : { fingerprint: opts.fingerprint }) });
    return { state: 'claimed', token };
  }

  public async renew(key: string, token: string, leaseMs: number, now: number): Promise<boolean> {
    const entry = this.running(key, token);
    if (!entry) {
      return false;
    }
    entry.leaseUntil = now + leaseMs;
    return true;
  }

  public async complete(key: string, token: string, reply: StoredReply, ttlMs: number, now: number): Promise<boolean> {
    const entry = this.running(key, token);
    if (!entry) {
      return false;
    }

    // re-inserted: Map order is the completion order eviction follows
    this.entries.delete(key);
    this.entries.set(key, { ...entry, state: 'done', reply: structuredClone(reply), expiresAt: now + ttlMs });
    this.doneCount++;
    this.evict();
    return true;
  }

  public async release(key: string, token: string): Promise<void> {
    if (this.running(key, token)) {
      this.entries.delete(key);
    }
  }

  public async peek(key: string, now: number): Promise<IdempotencyHeld | undefined> {
    return this.held(key, now);
  }

  public async sweep(now: number, limit: number): Promise<number> {
    let swept = 0;
    for (const [key, entry] of this.entries) {
      if (swept >= limit) {
        break;
      }
      if (this.expired(entry, now)) {
        this.drop(key);
        swept++;
      }
    }
    return swept;
  }

  protected held(key: string, now: number): IdempotencyHeld | undefined {
    const entry = this.entries.get(key);
    if (!entry || this.expired(entry, now)) {
      return undefined;
    }

    const fingerprint = entry.fingerprint === undefined ? {} : { fingerprint: entry.fingerprint };
    if (entry.state === 'running') {
      return { state: 'running', leaseUntil: entry.leaseUntil, ...fingerprint };
    }
    return { state: 'done', reply: structuredClone(entry.reply!), ...fingerprint };
  }

  protected running(key: string, token: string): IEntry | undefined {
    const entry = this.entries.get(key);
    return entry?.state === 'running' && entry.token === token ? entry : undefined;
  }

  protected expired(entry: IEntry, now: number): boolean {
    return entry.state === 'done' ? entry.expiresAt! <= now : entry.leaseUntil < now;
  }

  protected drop(key: string): void {
    if (this.entries.get(key)?.state === 'done') {
      this.doneCount--;
    }
    this.entries.delete(key);
  }

  protected evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.doneCount <= this.maxEntries) {
        return;
      }
      if (entry.state === 'done') {
        this.drop(key);
      }
    }
  }
}
