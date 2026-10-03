import { Autoinject, Injectable } from '@spinajs/di';
import { AutoinjectService, Config } from '@spinajs/configuration';
import { Log, Logger } from '@spinajs/log';
import { principalKey } from '@spinajs/authz';
import { SocketException } from '@spinajs/http-socket-common';
import type { CommandOutcome, IdempotentReply, ISocketIdempotencyClaim, ISocketIdempotencyConfig } from './interfaces.js';
import type { SocketConnection } from './connection.js';
import { SocketErrorMapper } from './errors.js';
import { untilAborted } from './limits.js';
import { isStreamResult } from './stream.js';

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

/**
 * Process memory: exactly-once across disconnects and graceful restarts, not across crashes.
 * `maxEntries` caps completed keys only: running claims are not counted and stay until their command completes or releases them.
 */
@Injectable(IdempotencyStore)
export class MemoryIdempotencyStore extends IdempotencyStore {
  protected entries = new Map<string, IMemoryEntry>();
  protected maxEntries: number;
  protected doneCount = 0;

  constructor(options: Partial<ISocketIdempotencyConfig> = {}, protected now: () => number = () => Date.now()) {
    super();
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    assertMaxEntries(this.maxEntries);
  }

  public get Size(): number {
    return this.entries.size;
  }

  public async claim(key: string): Promise<IdempotencyRecord | null> {
    const held = this.lookup(key);
    if (held) {
      return copy(held);
    }

    this.entries.set(key, { record: { state: 'running' }, expiresAt: Number.POSITIVE_INFINITY });
    return null;
  }

  public async complete(key: string, reply: IdempotentReply, ttlMs: number): Promise<void> {
    // NaN would never expire
    if (!(ttlMs > 0)) {
      throw new RangeError(`idempotency ttlMs must be above 0, got ${String(ttlMs)}`);
    }

    // the handler may keep and mutate what it returned
    const record: IdempotencyRecord = { state: 'done', reply: structuredClone(reply) };

    // re-inserted: Map order is the LRU order
    this.drop(key);
    this.entries.set(key, { record, expiresAt: this.now() + ttlMs });
    this.doneCount++;
    this.evict();
  }

  public async release(key: string): Promise<void> {
    if (this.entries.get(key)?.record.state === 'running') {
      this.entries.delete(key);
    }
  }

  public async get(key: string): Promise<IdempotencyRecord | null> {
    const held = this.lookup(key);
    return held && copy(held);
  }

  protected lookup(key: string): IdempotencyRecord | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= this.now()) {
      this.drop(key);
      return null;
    }

    if (entry.record.state === 'done') {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }

    return entry.record;
  }

  protected drop(key: string): void {
    if (this.entries.get(key)?.record.state === 'done') {
      this.doneCount--;
    }
    this.entries.delete(key);
  }

  protected evict(): void {
    const now = this.now();

    for (const [key, entry] of this.entries) {
      if (entry.record.state === 'running') {
        continue;
      }

      if (this.doneCount <= this.maxEntries && entry.expiresAt > now) {
        // under the cap: the remaining expired keys go lazily, on lookup
        break;
      }

      this.drop(key);
    }
  }
}

function copy(record: IdempotencyRecord): IdempotencyRecord {
  return record.state === 'done' ? { state: 'done', reply: structuredClone(record.reply) } : record;
}

function assertMaxEntries(maxEntries: unknown): asserts maxEntries is number {
  if (!(Number.isInteger(maxEntries) && (maxEntries as number) > 0)) {
    throw new RangeError(`http.socket.idempotency.maxEntries must be an integer above 0, got ${String(maxEntries)}`);
  }
}

export function assertIdempotencyConfig(options: ISocketIdempotencyConfig): void {
  if (!(typeof options?.service === 'string' && options.service.length > 0)) {
    throw new RangeError(`http.socket.idempotency.service must name an IdempotencyStore class, got ${JSON.stringify(options?.service)}`);
  }

  if (!(typeof options.ttlMs === 'number' && options.ttlMs > 0 && options.ttlMs <= MAX_TIMER_MS)) {
    throw new RangeError(`http.socket.idempotency.ttlMs must be within (0, ${MAX_TIMER_MS}], got ${String(options.ttlMs)}`);
  }

  assertMaxEntries(options.maxEntries);
}

/** Retry hint when another instance runs the key: this one cannot join it. */
export const ELSEWHERE_RETRY_AFTER_MS = 1_000;

function isBinary(value: unknown): boolean {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value) || (typeof Blob !== 'undefined' && value instanceof Blob);
}

/** Mirrors socket.io-parser's check, which decides between JSON and binary attachments. */
function hasBinary(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return false;
  }
  if (isBinary(value)) {
    return true;
  }

  seen.add(value);
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    return hasBinary(toJSON.call(value), seen);
  }

  return Object.values(value).some((item) => hasBinary(item, seen));
}

/**
 * The value as socket.io sends it, so the live reply and every replay are the same payload: a toJSON
 * class becomes its JSON, a function property disappears. Throws for a value the wire cannot carry ( BigInt, a cycle ).
 */
function toWireValue(value: unknown): unknown {
  if (hasBinary(value)) {
    return structuredClone(value);
  }

  const text = JSON.stringify(value);
  return text === undefined ? undefined : JSON.parse(text);
}

/** Libraries reject with their own AbortError, or wrap the reason as `cause`, rather than rethrowing it. */
function isAbortOf(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    return false;
  }

  const err = error as { name?: unknown; cause?: unknown } | null | undefined;
  return error === signal.reason || err?.name === 'AbortError' || err?.cause === signal.reason;
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
    let lookedAgain = false;

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
        // the store may have answered just before a local run of the key finished and left `local`
        if (!lookedAgain) {
          lookedAgain = true;
          continue;
        }
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
        // a key left running would refuse every resend for good
        (err: unknown) => {
          this.Log.error(err as Error, `Socket command ${name}: recording its idempotent outcome failed, releasing its key`);
          return this.Store.release(scoped)
            .catch((releaseErr: Error) => this.Log.error(releaseErr, `Socket command ${name}: releasing its idempotency key failed`))
            .then(() => {
              forget();
              publish(null);
              throw err;
            });
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
          // logged by finish
          .catch(() => undefined);
      },
    };
  }

  protected async record(scoped: string, name: string, signal: AbortSignal, outcome: CommandOutcome): Promise<IdempotentReply | null> {
    if ('result' in outcome) {
      // a stream reply cannot be replayed
      if (isStreamResult(outcome.result)) {
        return this.forgo(scoped, name);
      }

      const reply: IdempotentReply = { ok: true, result: toWireValue(outcome.result) };
      await this.keep(scoped, name, reply);
      return reply;
    }

    // the call's own deadline, cancel, disconnect or shutdown: the command produced no outcome
    if (isAbortOf(outcome.error, signal)) {
      return this.forgo(scoped, name);
    }

    const error = this.Errors.toWire(outcome.error, `command ${name}`);
    // unauthenticated refuses the credential, not the command: the client keeps it queued and resends after a login
    if (error.retryable || error.code === 'unauthenticated') {
      return this.forgo(scoped, name);
    }

    const reply: IdempotentReply = { ok: false, error: error.details === undefined ? error : { ...error, details: toWireValue(error.details) } };
    await this.keep(scoped, name, reply);
    return reply;
  }

  /** The command ran, so its reply is answered even when the store cannot keep it; only a later resend runs it again. */
  protected async keep(scoped: string, name: string, reply: IdempotentReply): Promise<void> {
    try {
      await this.Store.complete(scoped, reply, this.Options.ttlMs);
    } catch (err) {
      this.Log.error(err as Error, `Socket command ${name}: storing its idempotent reply failed, releasing its key`);
      await this.forgo(scoped, name);
    }
  }

  /** Frees a key without a reply to keep. A failed release leaves it running in the store: no store has a lease yet. */
  protected async forgo(scoped: string, name: string): Promise<null> {
    try {
      await this.Store.release(scoped);
    } catch (err) {
      this.Log.error(err as Error, `Socket command ${name}: releasing its idempotency key failed`);
    }
    return null;
  }
}
