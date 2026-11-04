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
  /** Stops renewing and keeps the claim: another caller takes the key over once the lease ends. */
  abandon(): Promise<void>;
}

export type IdempotencyAcquisition = { state: 'claimed'; handle: IdempotencyHandle } | { state: 'running'; retryAfterMs: number } | { state: 'done'; reply: StoredReply };

const NO_FAULTS = new NoFaults();

/** Turns store claims into handles that renew their lease until they complete, release or are abandoned. */
export class IdempotencyLeases {
  constructor(protected readonly options: IdempotencyLeasesOptions) {}

  public async acquire(key: string, opts: IdempotencyAcquireOptions = {}): Promise<IdempotencyAcquisition> {
    const leaseMs = opts.leaseMs ?? this.options.leaseMs;
    const now = this.options.now();
    const claim = await this.options.store.claim(key, { fingerprint: opts.fingerprint, leaseMs, now, namespace: opts.namespace });

    // a running claim carries its fingerprint too: a repeat with another request is refused before the call ends, not told to wait
    if (claim.state !== 'claimed' && opts.fingerprint !== undefined && claim.fingerprint !== undefined && claim.fingerprint !== opts.fingerprint) {
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
    const { store, timers, now } = this.options;
    const lost = new AbortController();
    let settled = false;
    const renewEveryMs = Math.max(1, Math.floor(leaseMs / 3));

    const heartbeat =
      this.options.renew === false
        ? undefined
        : new Heartbeat({
            timers,
            now,
            intervalMs: renewEveryMs,
            renewEveryMs,
            leaseTtlMs: leaseMs,
            leaseStartedAt: claimedAt,
            needsFlush: () => false,
            renew: async () => ({ ok: await store.renew(key, token, leaseMs, now()), cancelRequested: false }),
            onLost: () => {
              if (!settled) {
                lost.abort(new IdempotencyLeaseLost(key));
              }
            },
            onCancel: () => undefined,
            onError: (error) => this.options.onRenewError?.(error, key),
          });
    heartbeat?.start();

    const settle = async (): Promise<void> => {
      settled = true;
      await heartbeat?.stop(leaseMs);
    };

    return {
      key,
      token,
      signal: lost.signal,
      complete: async (reply, ttlMs) => {
        await settle();
        return store.complete(key, token, reply, ttlMs, now());
      },
      release: async () => {
        await settle();
        await store.release(key, token);
      },
      abandon: settle,
    };
  }
}
