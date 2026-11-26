import { AsyncService, Autoinject, Container, DI, Injectable, Singleton } from '@spinajs/di';
import type { IContainer } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import { stampBumps } from './bumps.js';
import { Cache } from './contracts.js';
import type { CacheLookup, CacheOptions, CacheReadOptions, TagBump } from './contracts.js';
import { NamedCache } from './named-cache.js';
import type { CacheHost, OpenedStore } from './named-cache.js';
import { DEFAULT_CACHE, cacheSettings, readCacheConfig, resolveStore } from './settings.js';
import type { CacheConfig } from './settings.js';

/** The caches of one container. cache() resolves it on first use. */
@Singleton()
@Injectable()
export class CacheService extends AsyncService implements CacheHost {
  @Autoinject(Container)
  public Container: IContainer;

  @Autoinject(Configuration)
  protected Configuration: Configuration;

  public config: CacheConfig;

  private readonly caches = new Map<string, NamedCache>();

  public async resolve(): Promise<void> {
    this.config = readCacheConfig(this.Configuration);
    await super.resolve();
  }

  public cache(name = DEFAULT_CACHE): Cache {
    return this.named(name);
  }

  public async openStore(name: string): Promise<OpenedStore> {
    const settings = cacheSettings(this.config, name);
    const store = await resolveStore(this.Container, settings.store, `cache.caches.${name}.store`);
    await store.configure(settings, this.Container);
    return { store, settings };
  }

  /** Bumps `tags` in every configured cache of this service. */
  public async invalidate(tags: readonly string[]): Promise<void> {
    if (tags.length === 0) return;
    await this.apply(stampBumps(tags));
  }

  /** Applies bumps to the store of every configured cache, also one this process never used. Never throws. */
  public async apply(bumps: readonly TagBump[]): Promise<void> {
    if (bumps.length === 0) return;
    // A shared store must hear a process that only writes, so the caches it opened are not enough. A name that is not
    // configured has no store to bump.
    const names = new Set([DEFAULT_CACHE, ...Object.keys(this.config.caches)]);
    await Promise.all([...names].map((name) => this.named(name).applyBumps(bumps)));
  }

  private named(name: string): NamedCache {
    let named = this.caches.get(name);
    if (named === undefined) {
      named = new NamedCache(name, this);
      this.caches.set(name, named);
    }
    return named;
  }
}

class LazyCache extends Cache {
  constructor(
    public readonly name: string,
    private readonly container: IContainer,
  ) {
    super();
  }

  public async get<T>(key: string, options?: CacheReadOptions): Promise<T | undefined> {
    return (await this.target()).get<T>(key, options);
  }

  public async set<T>(key: string, value: T, options: CacheOptions): Promise<void> {
    return (await this.target()).set(key, value, options);
  }

  public async wrap<T>(key: string, options: CacheOptions, compute: () => Promise<T>): Promise<T> {
    return (await this.target()).wrap(key, options, compute);
  }

  public async lookup<T>(key: string, options: CacheOptions): Promise<CacheLookup<T>> {
    return (await this.target()).lookup<T>(key, options);
  }

  public async delete(key: string, options?: CacheReadOptions): Promise<void> {
    return (await this.target()).delete(key, options);
  }

  public async invalidate(tags: readonly string[], options?: CacheReadOptions): Promise<void> {
    return (await this.target()).invalidate(tags, options);
  }

  private async target(): Promise<Cache> {
    const service = await this.container.resolve(CacheService);
    return service.cache(this.name);
  }
}

/** The cache `name` of the CacheService in `container`; nothing resolves until the first call, so this may run at module load. */
export function cache(name = DEFAULT_CACHE, container: IContainer = DI.RootContainer): Cache {
  return new LazyCache(name, container);
}
