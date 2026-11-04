import { AsyncService, Autoinject, Injectable, Singleton } from '@spinajs/di';
import { AutoinjectNamedService, Config } from '@spinajs/configuration';
import { Clock, DbClock, FaultInjector, parseDuration } from '@spinajs/durable';
import { InvalidArgument } from '@spinajs/exceptions';
import { Log, Logger } from '@spinajs/log';
import { IdempotencyInFlight, IdempotencyOutcomeUnknown } from './errors.js';
import { idempotencyKey } from './key.js';
import { IdempotencyLeases } from './leases.js';
import type { IdempotencyAcquisition, IdempotencyHandle } from './leases.js';
import { OrmIdempotencyStore } from './orm-store.js';
import { IdempotencyStore } from './store.js';
import type { IdempotencyOutcome, IdempotencyRunOptions, IdempotencyScope, StoredReply } from './interfaces.js';

export interface IdempotencyServiceAcquireOptions {
  fingerprint?: string;
  lease?: string | number;
}

/** Crash contract: an error with `crash: true` stands for a dead process, which writes and releases nothing. */
const isCrash = (error: unknown): boolean => (error as { crash?: unknown } | null | undefined)?.crash === true;

/**
 * Runs a function at most once per scoped key while its reply is kept: a repeat replays the reply, a concurrent call gets
 * IdempotencyInFlight. The function runs at least once: a replica that dies before `complete` leaves the key to be taken
 * over when its lease ends.
 */
@Singleton()
@Injectable()
export class IdempotencyService extends AsyncService {
  @Logger('idempotency')
  protected Log: Log;

  /** Public: http-socket builds its own IdempotencyLeases on it, and the http gate checks its class at registration. */
  @AutoinjectNamedService('idempotency.store', IdempotencyStore, { default: 'OrmIdempotencyStore' })
  public Store: IdempotencyStore;

  @Config('idempotency.lease', { defaultValue: '30s' })
  protected Lease: string | number;

  @Config('idempotency.sweepBatch', { defaultValue: 500 })
  protected SweepBatch: number;

  @Autoinject(Clock)
  protected Timers: Clock;

  @Autoinject(DbClock)
  protected Time: DbClock;

  @Autoinject(FaultInjector)
  protected Faults: FaultInjector;

  protected Leases: IdempotencyLeases;

  protected leaseMs: number;

  /** `idempotency.lease` in milliseconds: the lease of every claim of this service. */
  public get LeaseMs(): number {
    return this.leaseMs;
  }

  public async resolve(): Promise<void> {
    await super.resolve();
    this.leaseMs = this.ttlOf(this.Lease, 'idempotency.lease');
    this.Leases = new IdempotencyLeases({
      store: this.Store,
      timers: this.Timers,
      now: () => this.Time.now(),
      leaseMs: this.leaseMs,
      faults: this.Faults,
      onRenewError: (error, key) => this.onRenewError(error, key),
    });
    await this.syncClock();
  }

  public scopedKey(scope: IdempotencyScope, key: string): string {
    return idempotencyKey(scope, key);
  }

  public ttlOf(value: string | number, field = 'ttl'): number {
    const ms = parseDuration(value, field);
    if (!(ms > 0)) {
      throw new InvalidArgument(`${field} must be above 0, got ${String(value)}`);
    }
    return ms;
  }

  public acquire(scope: IdempotencyScope, key: string, opts: IdempotencyServiceAcquireOptions = {}): Promise<IdempotencyAcquisition> {
    return this.Leases.acquire(this.scopedKey(scope, key), {
      fingerprint: opts.fingerprint,
      namespace: scope.namespace,
      leaseMs: opts.lease === undefined ? undefined : this.ttlOf(opts.lease, 'lease'),
    });
  }

  public async run<T>(scope: IdempotencyScope, key: string, fn: (signal: AbortSignal) => Promise<T>, opts: IdempotencyRunOptions<T>): Promise<IdempotencyOutcome<T>> {
    const ttlMs = this.ttlOf(opts.ttl);
    const acquired = await this.acquire(scope, key, { fingerprint: opts.fingerprint, lease: opts.lease });

    if (acquired.state === 'done') {
      return { replayed: true, value: opts.fromReply(acquired.reply) };
    }
    if (acquired.state === 'running') {
      throw new IdempotencyInFlight(acquired.retryAfterMs);
    }

    const { handle } = acquired;
    let value: T;
    try {
      value = await fn(handle.signal);
    } catch (err) {
      // the side effect may have happened: a dead process or a caller that lost its client releases nothing, and the
      // lease ends on its own
      if (err instanceof IdempotencyOutcomeUnknown || isCrash(err)) {
        await handle.abandon();
      } else {
        await this.release(handle, scope);
      }
      throw err;
    }

    let reply: StoredReply | undefined;
    try {
      reply = opts.toReply(value);
    } catch (err) {
      // a reply that cannot be built must not leave the key claimed until the lease ends
      await this.release(handle, scope);
      throw err;
    }
    if (reply === undefined) {
      await this.release(handle, scope);
    } else {
      await this.complete(handle, scope, reply, ttlMs);
    }
    return { replayed: false, value };
  }

  public async sweep(limit = this.SweepBatch): Promise<number> {
    await this.syncClock();
    return this.Store.sweep(this.Time.now(), limit);
  }

  protected async complete(handle: IdempotencyHandle, scope: IdempotencyScope, reply: StoredReply, ttlMs: number): Promise<void> {
    try {
      if (!(await handle.complete(reply, ttlMs))) {
        this.Log.warn({ namespace: scope.namespace }, 'An idempotent call in ${namespace} lost its lease before its reply was stored; a repeat runs it again');
      }
    } catch (error) {
      if (isCrash(error)) {
        throw error;
      }
      this.Log.error({ error, namespace: scope.namespace }, 'Storing the reply of an idempotent call in ${namespace} failed; a repeat runs it again');
      await this.release(handle, scope);
    }
  }

  /** A failed release leaves the key to its lease, which ends on its own. */
  protected async release(handle: IdempotencyHandle, scope: IdempotencyScope): Promise<void> {
    try {
      await handle.release();
    } catch (error) {
      if (isCrash(error)) {
        throw error;
      }
      this.Log.error({ error, namespace: scope.namespace }, 'Releasing an idempotency key in ${namespace} failed; it frees itself when its lease ends');
    }
  }

  protected onRenewError(error: unknown, key: string): void {
    if (isCrash(error)) {
      this.Log.warn({ error, key }, 'Renewing the lease of idempotency key ${key} crashed; the call stops and the key frees itself when its lease ends');
      return;
    }
    this.Log.warn({ error, key }, 'Renewing the lease of idempotency key ${key} failed; it is retried');
  }

  /** Only a database store shares its times with other replicas; the memory store lives in one process. */
  protected async syncClock(): Promise<void> {
    if (this.Store instanceof OrmIdempotencyStore) {
      await this.Time.sync();
    }
  }
}
