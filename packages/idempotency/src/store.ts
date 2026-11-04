import type { IdempotencyClaim, IdempotencyClaimOptions, IdempotencyHeld, StoredReply } from './interfaces.js';

/**
 * A claim is a lease fenced by a token. A running claim whose lease ended (`leaseUntil < now`) and a reply past its TTL
 * (`expiresAt <= now`) are free to claim again, and every later write of the old holder is refused. The caller passes
 * every time ( database time, DbClock ); a store never reads a clock.
 */
export abstract class IdempotencyStore {
  /** Atomic: of many concurrent claims of a free key exactly one answers `claimed`. */
  public abstract claim(key: string, opts: IdempotencyClaimOptions): Promise<IdempotencyClaim>;

  public abstract renew(key: string, token: string, leaseMs: number, now: number): Promise<boolean>;

  /** false: the lease was lost to another claim, and the reply is not stored. */
  public abstract complete(key: string, token: string, reply: StoredReply, ttlMs: number, now: number): Promise<boolean>;

  /** Frees a running claim of this token; never a completed key. */
  public abstract release(key: string, token: string): Promise<void>;

  /** Reads a key without claiming it; undefined for a free one. */
  public abstract peek(key: string, now: number): Promise<IdempotencyHeld | undefined>;

  /** Deletes up to `limit` replies past their TTL and claims past their lease; answers how many. */
  public abstract sweep(now: number, limit: number): Promise<number>;
}
