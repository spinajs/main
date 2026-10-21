import { credentialChangeTags, credentialTag, identityTag } from '@spinajs/authn/bus';
import type { CredentialChangeBus, IdentityRef, KeyRecord } from '@spinajs/authn/contracts';
import { LruTtlCache } from '@spinajs/util';

import type { KeyCacheOptions } from '../options/options.js';
import { KeyStore } from './store.js';

/**
 * A KeyStore whose `get` is served from memory for `ttlSeconds`. Every write through it and every change the bus
 * delivers evicts; a key revoked in another process is seen within the ttl. Unknown kids are never cached.
 */
export class CachedKeyStore extends KeyStore {
  private readonly keys: LruTtlCache<string, KeyRecord> | null;
  /** Bumped by every eviction: a read that started before it must not store what it read. */
  private epoch = 0;
  private readonly unsubscribe: (() => void) | undefined;

  constructor(
    protected readonly inner: KeyStore,
    protected readonly options: KeyCacheOptions,
    protected readonly bus?: CredentialChangeBus,
  ) {
    super();
    this.keys = options.ttlSeconds > 0 ? new LruTtlCache<string, KeyRecord>({ maxEntries: options.maxEntries, ttlMs: options.ttlSeconds * 1000, expireOnClockRewind: true }) : null;
    this.unsubscribe = this.keys && bus ? bus.subscribe((change) => this.evict(credentialChangeTags(change))) : undefined;
  }

  public async insert(key: KeyRecord): Promise<'inserted' | 'duplicate'> {
    try {
      return await this.inner.insert(key);
    } finally {
      this.evict([credentialTag('key', key.kid)]);
    }
  }

  public async get(kid: string): Promise<KeyRecord | null> {
    const cached = this.keys?.get(kid);
    if (cached !== undefined) {
      return cached;
    }
    const since = this.epoch;
    const key = await this.inner.get(kid);
    if (key !== null && this.keys !== null && since === this.epoch) {
      this.keys.set(kid, key, { tags: [credentialTag('key', kid), identityTag(key.owner)] });
    }
    return key;
  }

  public listByOwner(owner: IdentityRef): Promise<readonly KeyRecord[]> {
    return this.inner.listByOwner(owner);
  }

  public async revoke(owner: IdentityRef, kid: string, at: Date): Promise<'revoked' | 'already' | 'none'> {
    try {
      return await this.inner.revoke(owner, kid, at);
    } finally {
      this.evict([credentialTag('key', kid)]);
    }
  }

  public async touch(kid: string, at: Date): Promise<void> {
    try {
      await this.inner.touch(kid, at);
    } finally {
      this.evict([credentialTag('key', kid)]);
    }
  }

  /** Stops listening to the bus. */
  public dispose(): Promise<void> {
    this.unsubscribe?.();
    this.keys?.clear();
    return Promise.resolve();
  }

  private evict(tags: string[]): void {
    this.epoch++;
    this.keys?.invalidate(tags);
  }
}
