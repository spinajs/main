import type { CredentialChangeBus, IdentityRef, KeyRecord } from '@spinajs/authn/contracts';

import type { KeyCacheOptions } from '../options/options.js';
import { KeyStore } from './store.js';

/** A KeyStore whose `get` is served from memory for `ttlSeconds`; every write through it and every bus change evicts. */
export class CachedKeyStore extends KeyStore {
  constructor(
    protected readonly inner: KeyStore,
    protected readonly options: KeyCacheOptions,
    protected readonly bus?: CredentialChangeBus,
  ) {
    super();
  }

  public insert(_key: KeyRecord): Promise<'inserted' | 'duplicate'> {
    throw new Error('not implemented: CachedKeyStore.insert');
  }

  public get(_kid: string): Promise<KeyRecord | null> {
    throw new Error('not implemented: CachedKeyStore.get');
  }

  public listByOwner(_owner: IdentityRef): Promise<readonly KeyRecord[]> {
    throw new Error('not implemented: CachedKeyStore.listByOwner');
  }

  public revoke(_owner: IdentityRef, _kid: string, _at: Date): Promise<'revoked' | 'already' | 'none'> {
    throw new Error('not implemented: CachedKeyStore.revoke');
  }

  public touch(_kid: string, _at: Date): Promise<void> {
    throw new Error('not implemented: CachedKeyStore.touch');
  }

  /** Stops listening to the bus. */
  public dispose(): Promise<void> {
    throw new Error('not implemented: CachedKeyStore.dispose');
  }
}
