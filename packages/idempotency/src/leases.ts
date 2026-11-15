import { Heartbeat, NoFaults } from '@spinajs/durable';
import type { Clock, FaultInjector } from '@spinajs/durable';
import { IdempotencyKeyReuse, IdempotencyLeaseLost } from './errors.js';
import type { IdempotencyStore } from './store.js';
import type { IdempotencyHeld, StoredReply } from './interfaces.js';

export interface IdempotencyLeasesOptions {
  store: IdempotencyStore;
  /** Timers of the renewal. */
  timers: Clock;
  /** Database time ( DbClock.now ) for every lease and expiry. */
  now: () => number;
  leaseMs: number;
  faults?: FaultInjector;
  /** false for a store whose claims never expire ( a 3.x socket store ): there is nothing to renew. */
  renew?: boolean;
  onRenewError?: (error: unknown, key: string) => void;
}

export interface IdempotencyAcquireOptions {
  fingerprint?: string;
  namespace?: string;
  leaseMs?: number;
}

export interface IdempotencyHandle {
  readonly key: string;
  readonly token: string;
  /** Aborted with IdempotencyLeaseLost once a renewal fails: another caller may hold the key now. */
  readonly signal: AbortSignal;
  /** false: the lease was lost, and the reply is not stored. */
  complete(reply: StoredReply, ttlMs: number): Promise<boolean>;
  release(): Promise<void>;
  /** Stops renewing and keeps the claim: another caller takes the key over once the lease ends. Rejects with a recorded crash. */
  abandon(): Promise<void>;
}

export type IdempotencyAcquisition = { state: 'claimed'; handle: IdempotencyHandle } | { state: 'running'; retryAfterMs: number } | { state: 'done'; reply: StoredReply };

const NO_FAULTS = new NoFaults();

interface ILeaseState {
  settled: boolean;
  crash?: Error;
}

/** Records an error that carries `crash: true` and aborts the handle's signal with it. */
function crashed(state: ILeaseState, lost: AbortController, error: unknown): boolean {
  if ((error as { crash?: unknown } | undefined)?.crash !== true) {
    return false;
  }
  state.settled = true;
  state.crash ??= error as Error;
  lost.abort(state.crash);
  return true;
}

/** Turns store claims into handles that renew their lease until they complete, release or are abandoned. */
export class IdempotencyLeases {
  constructor(protected readonly options: IdempotencyLeasesOptions) {}

  public async acquire(key: string, opts: IdempotencyAcquireOptions = {}): Promise<IdempotencyAcquisition> {
    const leaseMs = opts.leaseMs ?? this.options.leaseMs;
    const now = this.options.now();
    const claim = await this.options.store.claim(key, { fingerprint: opts.fingerprint, leaseMs, now, namespace: opts.namespace });

    // a running claim carries its fingerprint too: a repeat with another request is refused before the call ends, not told to wait
    if (claim.state !== 'claimed' && opts.fingerprint && claim.fingerprint !== undefined && claim.fingerprint !== opts.fingerprint) {
      throw new IdempotencyKeyReuse();
    }

    if (claim.state === 'done') {
      return { state: 'done', reply: claim.reply };
    }

    if (claim.state === 'running') {
      return { state: 'running', retryAfterMs: Math.max(1, Math.min(claim.leaseUntil - now, leaseMs)) };
    }

    await (this.options.faults ?? NO_FAULTS).point('idempotency.after-claim', { key });
    return { state: 'claimed', handle: this.hold(key, claim.token, leaseMs, now) };
  }

  public peek(key: string): Promise<IdempotencyHeld | undefined> {
    return this.options.store.peek(key, this.options.now());
  }

  protected hold(key: string, token: string, leaseMs: number, claimedAt: number): IdempotencyHandle {
    const { store, now } = this.options;
    const lost = new AbortController();
    const state: ILeaseState = { settled: false };

    const heartbeat = this.options.renew === false ? undefined : this.heartbeat(key, token, leaseMs, claimedAt, lost, state);
    heartbeat?.start();

    // Crash contract: a dead process writes nothing, releases nothing, and its caller sees the crash.
    const write = async <T>(op: () => Promise<T>): Promise<T> => {
      state.settled = true;
      await heartbeat?.stop(leaseMs);
      if (state.crash) {
        throw state.crash;
      }
      try {
        return await op();
      } catch (error) {
        crashed(state, lost, error);
        throw error;
      }
    };

    return {
      key,
      token,
      signal: lost.signal,
      complete: (reply, ttlMs) => write(() => store.complete(key, token, reply, ttlMs, now())),
      release: () => write(() => store.release(key, token)),
      abandon: async () => {
        state.settled = true;
        await heartbeat?.stop(leaseMs);
        if (state.crash) {
          throw state.crash;
        }
      },
    };
  }

  protected heartbeat(key: string, token: string, leaseMs: number, claimedAt: number, lost: AbortController, state: ILeaseState): Heartbeat {
    const { store, timers, now } = this.options;
    const renewEveryMs = Math.max(1, Math.floor(leaseMs / 3));
    const heartbeat: Heartbeat = new Heartbeat({
      timers,
      now,
      // Heartbeat counts a renewal from when it returns, so a tick exactly one period later finds it not yet due;
      // four ticks per period keep the cadence within a quarter period of lease/3 and retry a failed renewal soon.
      intervalMs: Math.max(1, Math.floor(renewEveryMs / 4)),
      renewEveryMs,
      leaseTtlMs: leaseMs,
      leaseStartedAt: claimedAt,
      needsFlush: () => false,
      renew: async () => ({ ok: await store.renew(key, token, leaseMs, now()), cancelRequested: false }),
      onLost: () => {
        if (!state.settled) {
          lost.abort(new IdempotencyLeaseLost(key));
        }
      },
      onCancel: () => undefined,
      onError: (error) => {
        if (crashed(state, lost, error)) {
          void heartbeat.stop(0);
        }
        this.options.onRenewError?.(error, key);
      },
    });
    return heartbeat;
  }
}
