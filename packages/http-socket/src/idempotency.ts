import { Autoinject, Injectable } from '@spinajs/di';
import { AutoinjectService, Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { principalKey } from '@spinajs/authz';
import { SocketException } from '@spinajs/http-socket-common';
import type { CommandOutcome, IdempotentReply, ISocketIdempotencyClaim, ISocketIdempotencyConfig } from './interfaces.js';
import type { SocketConnection } from './connection.js';
import { SocketErrorMapper } from './errors.js';
import { untilAborted } from './limits.js';

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

/** Retry hint when another instance runs the key: this one cannot join it. */
export const ELSEWHERE_RETRY_AFTER_MS = 1_000;

function isAsyncIterable(value: unknown): boolean {
  return value !== null && typeof value === 'object' && typeof (value as Record<symbol, unknown>)[Symbol.asyncIterator] === 'function';
}

/** The idempotency stage and the ordering stage's `after` fence share this: one store, one key scheme, one set of local runs. */
@Injectable()
export class SocketIdempotency {
  @Logger('http-socket')
  protected Log: Log;

  @AutoinjectService('http.socket.idempotency', IdempotencyStore)
  protected Store: IdempotencyStore;

  @Config('http.socket.idempotency')
  protected Options: ISocketIdempotencyConfig;

  @Autoinject()
  protected Errors: SocketErrorMapper;

  /** Keys this instance runs: resolves with the stored reply, or null once the key was released. */
  protected local = new Map<string, Promise<IdempotentReply | null>>();

  /** A clientId is not a secret, so a stored reply must never reach another principal. */
  public scope(connection: SocketConnection, key: string): string {
    return [principalKey(connection.principal), connection.clientId, key].map(encodeURIComponent).join(':');
  }

  public async completed(scoped: string): Promise<boolean> {
    return (await this.Store.get(scoped))?.state === 'done';
  }

  public async begin(scoped: string, name: string, signal: AbortSignal): Promise<{ reply: IdempotentReply } | { claim: ISocketIdempotencyClaim }> {
    for (;;) {
      const held = await this.Store.claim(scoped);

      if (held === null) {
        return { claim: this.claim(scoped, name, signal) };
      }

      if (held.state === 'done') {
        return { reply: held.reply };
      }

      const running = this.local.get(scoped);
      if (!running) {
        throw new SocketException('unavailable', `command ${name} with this idempotency key is running on another server instance`, { retryAfterMs: ELSEWHERE_RETRY_AFTER_MS });
      }

      const reply = await untilAborted(running, signal);
      if (reply) {
        return { reply };
      }
      // released by a run that produced no outcome: claim it again
    }
  }

  protected claim(scoped: string, name: string, signal: AbortSignal): ISocketIdempotencyClaim {
    let publish!: (reply: IdempotentReply | null) => void;
    const mine = new Promise<IdempotentReply | null>((resolve) => (publish = resolve));
    this.local.set(scoped, mine);

    let answer: Promise<IdempotentReply | null> | null = null;
    let detached = false;

    // a released key can be claimed again before this cleanup runs: never drop the newer claim's entry
    const forget = () => {
      if (this.local.get(scoped) === mine) {
        this.local.delete(scoped);
      }
    };

    const finish = (outcome: CommandOutcome): Promise<IdempotentReply | null> =>
      (answer ??= this.record(scoped, name, signal, outcome).then(
        (reply) => {
          forget();
          publish(reply);
          return reply;
        },
        (err: unknown) => {
          forget();
          publish(null);
          throw err;
        },
      ));

    return {
      settle: (outcome) => (detached ? Promise.resolve(null) : finish(outcome)),
      detach: (running) => {
        if (answer || detached) {
          return;
        }

        detached = true;
        running
          .then(
            (result) => finish({ result }),
            (error: unknown) => finish({ error }),
          )
          .catch((err: Error) => this.Log.error(err, `Socket command ${name}: recording the outcome of its detached handler failed`));
      },
    };
  }

  protected async record(scoped: string, name: string, signal: AbortSignal, outcome: CommandOutcome): Promise<IdempotentReply | null> {
    if ('result' in outcome) {
      // a stream reply cannot be replayed
      if (isAsyncIterable(outcome.result)) {
        await this.Store.release(scoped);
        return null;
      }

      const reply: IdempotentReply = { ok: true, result: outcome.result === undefined ? null : outcome.result };
      await this.Store.complete(scoped, reply, this.Options.ttlMs);
      return reply;
    }

    // the call's own deadline, cancel, disconnect or shutdown: the command produced no outcome
    if (signal.aborted && outcome.error === signal.reason) {
      await this.Store.release(scoped);
      return null;
    }

    const error = this.Errors.toWire(outcome.error, `command ${name}`);
    if (error.retryable) {
      await this.Store.release(scoped);
      return null;
    }

    const reply: IdempotentReply = { ok: false, error };
    await this.Store.complete(scoped, reply, this.Options.ttlMs);
    return reply;
  }
}
