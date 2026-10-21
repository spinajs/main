import { credentialChangeTags, credentialTag, identityTag } from '@spinajs/authn/bus';
import type { CredentialChange, CredentialChangeBus, TokenRecord, TokenValidation } from '@spinajs/authn/contracts';
import { InvalidOption } from '@spinajs/exceptions';
import { LruTtlCache } from '@spinajs/util';

/** `authn.token.cache`. */
export interface TokenCacheConfig {
  /** 0 turns the cache off. */
  readonly ttlSeconds: number;
  readonly maxEntries: number;
}

export const DEFAULT_TOKEN_CACHE: TokenCacheConfig = Object.freeze({ ttlSeconds: 10, maxEntries: 10_000 });

export type ValidatedToken = Extract<TokenValidation, { ok: true }>;

interface Entry {
  readonly validation: ValidatedToken;
  /** The token's own expiry. */
  readonly expiresAt: number;
  /** When the rows behind it were read; a stamp keeps it, so it never outlives the ttl. */
  readonly readAt: number;
}

const isCount = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min;

/**
 * Successful validations by token hash (never the plaintext), for `ttlSeconds`. Revocations and identity changes
 * evict through {@link evict}, also when they arrive on the bus.
 */
export class TokenValidationCache {
  private readonly entries: LruTtlCache<string, Entry> | null;
  private readonly ttlMs: number;
  /** Token id to hash, for {@link stamp}; kept in step by `onEvict`. */
  private readonly hashes = new Map<string, string>();
  /** Bumped by every eviction: a validation that read the rows before it must not store what it read. */
  private epoch = 0;
  private readonly unsubscribe: (() => void) | undefined;

  constructor(config: TokenCacheConfig, bus?: CredentialChangeBus) {
    // The schema is the gate; this floor holds for values set at run time without it.
    if (!isCount(config?.ttlSeconds, 0) || !isCount(config?.maxEntries, 1)) {
      throw new InvalidOption('authn.token.cache needs an integer ttlSeconds >= 0 and an integer maxEntries >= 1');
    }
    this.ttlMs = config.ttlSeconds * 1000;
    this.entries =
      this.ttlMs > 0
        ? new LruTtlCache<string, Entry>({
            maxEntries: config.maxEntries,
            ttlMs: this.ttlMs,
            expireOnClockRewind: true,
            onEvict: (hash, entry) => {
              if (this.hashes.get(entry.validation.token.id) === hash) {
                this.hashes.delete(entry.validation.token.id);
              }
            },
          })
        : null;
    this.unsubscribe = this.entries && bus ? bus.subscribe((change) => this.evict(change)) : undefined;
  }

  /** Taken before the rows are read, and handed to {@link set}. */
  public mark(): number {
    return this.epoch;
  }

  /** The cached validation, unless the token expired by `now`. */
  public get(hash: string, now: number): ValidatedToken | undefined {
    const entry = this.entries?.get(hash);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.entries!.delete(hash);
      return undefined;
    }
    return entry.validation;
  }

  /** Stores `validation` unless an eviction ran since `since` was marked. */
  public set(hash: string, validation: ValidatedToken, expiresAt: number, since: number): void {
    if (this.entries === null || since !== this.epoch) {
      return;
    }
    this.put(hash, { validation, expiresAt, readAt: Date.now() }, this.ttlMs);
  }

  /** The last use `touch` wrote, so the cached record does not ask for another stamp on every request. */
  public stamp(id: string, at: Date, ip: string | null): void {
    const hash = this.hashes.get(id);
    const entry = hash === undefined ? undefined : this.entries?.peek(hash);
    if (hash === undefined || entry === undefined) {
      return;
    }
    const remaining = entry.readAt + this.ttlMs - Date.now();
    if (remaining <= 0) {
      return;
    }
    const { lastUsedIp: _previous, ...rest } = entry.validation.token;
    const token: TokenRecord = { ...rest, lastUsedAt: at, ...(ip !== null ? { lastUsedIp: ip } : {}) };
    this.put(hash, { ...entry, validation: { ...entry.validation, token } }, remaining);
  }

  public evict(change: CredentialChange): void {
    this.epoch++;
    this.entries?.invalidate(credentialChangeTags(change));
  }

  public dispose(): void {
    this.unsubscribe?.();
    this.entries?.clear();
  }

  private put(hash: string, entry: Entry, ttlMs: number): void {
    const { token, identity } = entry.validation;
    // An agent token is tagged with its owner (token.owner) and with itself as an identity.
    const tags = [credentialTag('token', token.id), identityTag(token.owner), identityTag(identity)];
    this.entries!.set(hash, entry, { ttlMs, tags });
    this.hashes.set(token.id, hash);
  }
}
