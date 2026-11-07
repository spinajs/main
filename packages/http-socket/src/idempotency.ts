import { randomUUID } from 'node:crypto';
import { AddDependencyForProperty, Autoinject, Injectable } from '@spinajs/di';
import type { Class, IContainer, IInjectDescriptor } from '@spinajs/di';
import { Config, Configuration } from '@spinajs/configuration';
import { InvalidOperation, InvalidOption } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { principalKey } from '@spinajs/authz';
import { Clock, DbClock, DurableSystemClock, FaultInjector, parseDuration } from '@spinajs/durable';
import { IdempotencyLeases, IdempotencyService, IdempotencyStore as LeasedIdempotencyStore, OrmIdempotencyStore, idempotencyKey, isCrash } from '@spinajs/idempotency';
import type { IdempotencyClaim, IdempotencyHandle, IdempotencyHeld, StoredReply } from '@spinajs/idempotency';
import { SocketException } from '@spinajs/http-socket-common';
import type { CommandOutcome, IdempotentReply, ISocketIdempotencyClaim, ISocketIdempotencyConfig } from './interfaces.js';
import type { SocketConnection } from './connection.js';
import { isOutcomeUnknownAfter, outcomeUnknownAfter } from './context.js';
import { SocketErrorMapper } from './errors.js';
import { untilAborted } from './limits.js';
import { isStreamResult } from './stream.js';
import { fromStoredReply, hasBinary, toStoredReply } from './stored-reply.js';

const MAX_TIMER_MS = 2 ** 31 - 1;
const DEFAULT_MAX_ENTRIES = 100_000;
const DEFAULT_LEASE = '30s';
// An instance built with `new` ( tests, a hand-wired server ) has no injected clock.
const SYSTEM_CLOCK = new DurableSystemClock();

export type IdempotencyRecord = { readonly state: 'running' } | { readonly state: 'done'; readonly reply: IdempotentReply };

/**
 * @deprecated Implement `IdempotencyStore` of `@spinajs/idempotency`: its claims are leases another instance takes over.
 * A store of this shape still works; `http.socket.idempotency.service` wraps it with `fromLegacySocketStore`.
 * Exported as `IdempotencyStore`. The class has another name because DI keys registrations by class name, and the
 * `@spinajs/idempotency` contract owns `IdempotencyStore`.
 */
export abstract class LegacySocketIdempotencyStore {
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
 * @deprecated Use `MemoryIdempotencyStore` of `@spinajs/idempotency`, which `http.socket.idempotency.service:
 * 'MemoryIdempotencyStore'` names. Exported as `MemoryIdempotencyStore` for 3.x subclasses.
 * `maxEntries` caps completed keys only: running claims are not counted and stay until their command completes or releases them.
 */
export class LegacySocketMemoryIdempotencyStore extends LegacySocketIdempotencyStore {
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

export { LegacySocketIdempotencyStore as IdempotencyStore, LegacySocketMemoryIdempotencyStore as MemoryIdempotencyStore };

function copy(record: IdempotencyRecord): IdempotencyRecord {
  return record.state === 'done' ? { state: 'done', reply: structuredClone(record.reply) } : record;
}

function assertMaxEntries(maxEntries: unknown): asserts maxEntries is number {
  if (!(Number.isInteger(maxEntries) && (maxEntries as number) > 0)) {
    throw new RangeError(`http.socket.idempotency.maxEntries must be an integer above 0, got ${String(maxEntries)}`);
  }
}

export function assertIdempotencyConfig(options: ISocketIdempotencyConfig): void {
  // null binds sockets to the store of IdempotencyService
  if (options?.service != null && !(typeof options.service === 'string' && options.service.length > 0)) {
    throw new RangeError(`http.socket.idempotency.service must name an IdempotencyStore class or be null, got ${JSON.stringify(options?.service)}`);
  }

  if (!(typeof options.ttlMs === 'number' && options.ttlMs > 0 && options.ttlMs <= MAX_TIMER_MS)) {
    throw new RangeError(`http.socket.idempotency.ttlMs must be within (0, ${MAX_TIMER_MS}], got ${String(options.ttlMs)}`);
  }

  assertMaxEntries(options.maxEntries);

  if (options.lease !== undefined && !(leaseMsOf(options.lease) > 0)) {
    throw new RangeError(`http.socket.idempotency.lease must be above 0, got ${String(options.lease)}`);
  }
}

function leaseMsOf(lease: unknown): number {
  try {
    return parseDuration(lease as string | number, 'http.socket.idempotency.lease');
  } catch (err) {
    throw new RangeError(`http.socket.idempotency.lease must be a duration ( e.g. 30s ) or milliseconds above 0, got ${JSON.stringify(lease)}`, { cause: err });
  }
}

function heldOf(record: IdempotencyRecord | null): IdempotencyHeld | undefined {
  if (record === null) {
    return undefined;
  }
  return record.state === 'done' ? { state: 'done', reply: { kind: 'socket', body: record.reply } } : { state: 'running', leaseUntil: Number.MAX_SAFE_INTEGER };
}

/** A 3.x store has no leases: its running claims hold until they complete or are released, so its lease never ends. */
export class LegacySocketStoreAdapter extends LeasedIdempotencyStore {
  constructor(public readonly legacy: LegacySocketIdempotencyStore) {
    super();
  }

  public async claim(key: string): Promise<IdempotencyClaim> {
    return heldOf(await this.legacy.claim(key)) ?? { state: 'claimed', token: randomUUID() };
  }

  public async renew(): Promise<boolean> {
    return true;
  }

  public async complete(key: string, _token: string, reply: StoredReply, ttlMs: number): Promise<boolean> {
    await this.legacy.complete(key, fromStoredReply(reply), ttlMs);
    return true;
  }

  public async release(key: string): Promise<void> {
    await this.legacy.release(key);
  }

  public async peek(key: string): Promise<IdempotencyHeld | undefined> {
    return heldOf(await this.legacy.get(key));
  }

  public async sweep(): Promise<number> {
    return 0;
  }
}

/** Wraps a 3.x socket store as an `IdempotencyStore` of `@spinajs/idempotency`. */
export function fromLegacySocketStore(store: LegacySocketIdempotencyStore): LeasedIdempotencyStore {
  return new LegacySocketStoreAdapter(store);
}

/**
 * The store sockets claim on: the one `http.socket.idempotency.service` names, an IdempotencyStore of
 * @spinajs/idempotency first, then a 3.x store of this package, built with the whole `http.socket.idempotency` object,
 * as the 3.x lookup did. `service: null` binds sockets to the store of IdempotencyService (`idempotency.store`); the
 * service is resolved only then, so a socket app on the default never needs its database. Async, as
 * `resolveNamedService` behind the 3.x `@AutoinjectService` is: DI awaits a resolveFunc's promise.
 */
export async function resolveSocketIdempotencyStore(container: IContainer): Promise<LeasedIdempotencyStore | LegacySocketIdempotencyStore> {
  const configuration = container.get(Configuration);
  if (!configuration) {
    throw new InvalidOperation('http.socket.idempotency.service: the Configuration of the container is not resolved');
  }
  const options = configuration.get<ISocketIdempotencyConfig>('http.socket.idempotency');
  if (options.service == null) {
    return (await container.resolve(IdempotencyService)).Store;
  }
  const registered: string[] = [];

  for (const token of [LeasedIdempotencyStore, LegacySocketIdempotencyStore]) {
    const types = (container.getRegisteredTypes<unknown>(token) ?? []) as Array<{ name?: string }>;
    const type = types.find((t) => t.name === options.service);
    if (type) {
      return container.resolve(type as Class<unknown>, [options]) as LeasedIdempotencyStore | LegacySocketIdempotencyStore;
    }
    registered.push(...types.map((t) => t.name ?? '').filter((name) => name !== ''));
  }

  throw new InvalidOption(`http.socket.idempotency.service ${JSON.stringify(options.service)}: no IdempotencyStore is registered under that name (registered: ${registered.join(', ') || 'none'})`);
}

function AutoinjectSocketIdempotencyStore(): PropertyDecorator {
  return AddDependencyForProperty((descriptor: IInjectDescriptor<unknown>, _target: Class<unknown>, propertyKey: string | symbol) => {
    descriptor.inject.push({
      autoinject: true,
      autoinjectKey: propertyKey,
      inject: LeasedIdempotencyStore,
      data: 'http.socket.idempotency',
      resolveFunc: (_data: string, container: IContainer) => resolveSocketIdempotencyStore(container),
    });
  }) as PropertyDecorator;
}

/** Retry hint when a wrapped 3.x store, which has no lease, holds the key on another instance; a leased store answers with the rest of the lease. */
export const ELSEWHERE_RETRY_AFTER_MS = 1_000;

export { outcomeUnknownAfter };

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

  @AutoinjectSocketIdempotencyStore()
  protected Store: LeasedIdempotencyStore | LegacySocketIdempotencyStore;

  /** The lease when http.socket.idempotency.lease is not set; read as config, so IdempotencyService is not resolved for it. */
  @Config('idempotency.lease', { defaultValue: DEFAULT_LEASE })
  protected ServiceLease: string | number;

  @Config('http.socket.idempotency')
  protected Options: ISocketIdempotencyConfig;

  @Autoinject()
  protected Errors: SocketErrorMapper;

  @Autoinject(Clock)
  protected Timers: Clock;

  @Autoinject(DbClock)
  protected Time: DbClock;

  @Autoinject(FaultInjector)
  protected Faults: FaultInjector;

  /** Keys this instance runs: resolves with the stored reply, or null once the key was released. */
  protected local = new Map<string, Promise<IdempotentReply | null>>();

  protected bound?: { store: object; leases: IdempotencyLeases };

  protected synced?: Promise<unknown>;

  protected get leases(): IdempotencyLeases {
    if (this.bound?.store !== this.Store) {
      const legacy = this.Store instanceof LegacySocketIdempotencyStore;
      const timers = this.Timers ?? SYSTEM_CLOCK;
      const time = this.Time ?? timers;
      this.bound = {
        store: this.Store,
        leases: new IdempotencyLeases({
          store: legacy ? fromLegacySocketStore(this.Store as LegacySocketIdempotencyStore) : (this.Store as LeasedIdempotencyStore),
          timers,
          now: () => time.now(),
          leaseMs: this.Options.lease !== undefined ? leaseMsOf(this.Options.lease) : parseDuration(this.ServiceLease ?? DEFAULT_LEASE, 'idempotency.lease'),
          faults: this.Faults,
          renew: !legacy,
          onRenewError: (error, key) => this.Log.warn({ error, key }, 'Renewing the idempotency lease of socket key ${key} failed; it is retried'),
        }),
      };
    }
    return this.bound.leases;
  }

  /** A clientId is not a secret, so a stored reply must never reach another principal. */
  public scope(connection: SocketConnection, key: string): string {
    const principal = principalKey(connection.principal);
    // a 3.x store keeps the 3.x key, so a reply it stored before the upgrade still replays
    if (this.Store instanceof LegacySocketIdempotencyStore) {
      return [principal, connection.clientId, key].map(encodeURIComponent).join(':');
    }
    return idempotencyKey({ namespace: 'socket', principal: JSON.stringify([principal, connection.clientId]) }, key);
  }

  public async completed(scoped: string): Promise<boolean> {
    await this.syncClock();
    return (await this.leases.peek(scoped))?.state === 'done';
  }

  /** `handlerStarted` tells the claim when its handler started, as `start()` does for a caller that drives it by hand. */
  public async begin(scoped: string, name: string, signal: AbortSignal, handlerStarted?: () => boolean): Promise<{ reply: IdempotentReply } | { claim: ISocketIdempotencyClaim }> {
    await this.syncClock();
    let lookedAgain = false;

    for (;;) {
      const held = await this.leases.acquire(scoped, { namespace: 'socket' });

      if (held.state === 'claimed') {
        return { claim: this.claim(scoped, name, signal, held.handle, handlerStarted) };
      }

      if (held.state === 'done') {
        return { reply: this.replay(held.reply, name) };
      }

      const running = this.local.get(scoped);
      if (!running) {
        // the store may have answered just before a local run of the key finished and left `local`
        if (!lookedAgain) {
          lookedAgain = true;
          continue;
        }
        // a wrapped 3.x store has no lease to wait out; a leased store answers with the rest of it
        const retryAfterMs = this.Store instanceof LegacySocketIdempotencyStore ? ELSEWHERE_RETRY_AFTER_MS : held.retryAfterMs;
        throw new SocketException('unavailable', `command ${name} with this idempotency key is running on another server instance`, { retryAfterMs });
      }

      const reply = await untilAborted(running, signal);
      if (reply) {
        return { reply };
      }
      // released by a run that produced no outcome: claim it again
    }
  }

  /** Lease times on a shared database store are database time; DbClock reads the offset once. */
  protected async syncClock(): Promise<void> {
    if (this.Store instanceof OrmIdempotencyStore && this.Time) {
      // a failed sync is tried again by the next command, not remembered
      await (this.synced ??= this.Time.sync().catch((err: unknown) => {
        this.synced = undefined;
        throw err;
      }));
    }
  }

  /**
   * The store contract cannot free a completed key, and running the command again would break at-most-once: a reply the
   * store kept but this instance cannot read is a final error, not an internal one.
   */
  protected replay(stored: StoredReply, name: string): IdempotentReply {
    try {
      return fromStoredReply(stored);
    } catch (err) {
      this.Log.error({ error: err, command: name }, 'Socket command ${command}: its stored idempotent reply cannot be read');
      throw new SocketException('failed_precondition', `command ${name} with this idempotency key already ran, and its stored reply cannot be read`);
    }
  }

  protected claim(scoped: string, name: string, signal: AbortSignal, handle: IdempotencyHandle, handlerStarted?: () => boolean): ISocketIdempotencyClaim {
    let publish!: (reply: IdempotentReply | null) => void;
    const mine = new Promise<IdempotentReply | null>((resolve) => (publish = resolve));
    this.local.set(scoped, mine);

    let answer: Promise<IdempotentReply | null> | null = null;
    let detached = false;
    let started = false;
    const isStarted = () => started || handlerStarted?.() === true;

    // a released key can be claimed again before this cleanup runs: never drop the newer claim's entry
    const forget = () => {
      if (this.local.get(scoped) === mine) {
        this.local.delete(scoped);
      }
    };

    const finish = (outcome: CommandOutcome): Promise<IdempotentReply | null> =>
      (answer ??= this.record(handle, name, signal, outcome, isStarted()).then(
        (reply) => {
          forget();
          publish(reply);
          return reply;
        },
        // a key left claimed would refuse every resend until its lease ends, or for good on a 3.x store
        (err: unknown) => {
          // a dead process releases nothing: the key frees itself when its lease ends
          if (isCrash(err)) {
            forget();
            publish(null);
            throw err;
          }
          this.Log.error({ error: err, command: name }, 'Socket command ${command}: recording its idempotent outcome failed, releasing its key');
          return handle
            .release()
            .catch((releaseErr: Error) => this.Log.error({ error: releaseErr, command: name }, 'Socket command ${command}: releasing its idempotency key failed'))
            .then(() => {
              forget();
              publish(null);
              throw err;
            });
        },
      ));

    return {
      lease: handle.signal,
      get started() {
        return isStarted();
      },
      start: () => {
        started = true;
      },
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

  protected async record(handle: IdempotencyHandle, name: string, signal: AbortSignal, outcome: CommandOutcome, started: boolean): Promise<IdempotentReply | null> {
    if ('error' in outcome && isCrash(outcome.error)) {
      return this.crashed(handle, outcome.error);
    }

    if ('result' in outcome) {
      // a stream reply cannot be replayed
      if (isStreamResult(outcome.result)) {
        return this.forgo(handle, name);
      }

      const reply: IdempotentReply = { ok: true, result: toWireValue(outcome.result) };
      await this.keep(handle, name, reply);
      return reply;
    }

    // the call's own deadline, cancel, disconnect or shutdown: the command produced no outcome
    if (isAbortOf(outcome.error, signal)) {
      if (started && isOutcomeUnknownAfter(signal.reason)) {
        this.Log.warn({ command: name }, 'Socket command ${command}: aborted by shutdown after its handler started; its idempotency key stays claimed until its lease ends, as it may have committed');
        await handle.abandon();
        return null;
      }
      return this.forgo(handle, name);
    }

    const error = this.Errors.toWire(outcome.error, `command ${name}`);
    // unauthenticated refuses the credential, not the command: the client keeps it queued and resends after a login
    if (error.retryable || error.code === 'unauthenticated') {
      return this.forgo(handle, name);
    }

    const reply: IdempotentReply = { ok: false, error: error.details === undefined ? error : { ...error, details: toWireValue(error.details) } };
    await this.keep(handle, name, reply);
    return reply;
  }

  /** The command ran, so its reply is answered even when the store cannot keep it; only a later resend runs it again. */
  protected async keep(handle: IdempotencyHandle, name: string, reply: IdempotentReply): Promise<void> {
    try {
      if (!(await handle.complete(toStoredReply(reply), this.Options.ttlMs))) {
        this.Log.warn({ command: name }, 'Socket command ${command}: its idempotency lease was lost before its reply was stored');
      }
    } catch (err) {
      if (isCrash(err)) {
        await this.crashed(handle, err);
      }
      this.Log.error({ error: err, command: name }, 'Socket command ${command}: storing its idempotent reply failed, releasing its key');
      await this.forgo(handle, name);
    }
  }

  /** Keeps the claim, which another instance takes over when its lease ends, and rethrows: neither stored nor released. */
  protected async crashed(handle: IdempotencyHandle, crash: unknown): Promise<never> {
    // abandon() rejects with a crash the heartbeat recorded, which is this one or an earlier one
    await handle.abandon().catch(() => undefined);
    throw crash;
  }

  /** Frees a key without a reply to keep. A failed release leaves the claim to its lease; a 3.x store keeps it running. */
  protected async forgo(handle: IdempotencyHandle, name: string): Promise<null> {
    try {
      await handle.release();
    } catch (err) {
      if (isCrash(err)) {
        throw err;
      }
      this.Log.error({ error: err, command: name }, 'Socket command ${command}: releasing its idempotency key failed');
    }
    return null;
  }
}
