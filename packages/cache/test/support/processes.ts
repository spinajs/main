import type { IContainer } from '@spinajs/di';
import { createTestApp } from '@spinajs/testing';
import type { TestApp } from '@spinajs/testing';
import { CacheStore, InProcessTagBus, MemoryCacheStore, TagBus } from '../../src/index.js';
import type { CacheEntry, CacheStoreRead, TagBump } from '../../src/index.js';

/** The network between the test processes: every WireBus publishes here; while held, a message waits for deliver(). */
class Wire {
  public sent: TagBump[][] = [];
  public dropping = false;
  private held: TagBump[][] | undefined;
  private hub = new InProcessTagBus();

  public reset(): void {
    Object.assign(this, { sent: [], dropping: false, held: undefined, hub: new InProcessTagBus() });
  }

  public hold(): void {
    this.held = [];
  }

  public async deliver(): Promise<void> {
    const held = this.held ?? [];
    this.held = undefined;
    for (const bumps of held) await this.hub.publish(bumps);
  }

  public async send(bumps: readonly TagBump[]): Promise<void> {
    this.sent.push([...bumps]);
    if (this.dropping) return;
    if (this.held) this.held.push([...bumps]);
    else await this.hub.publish(bumps);
  }

  public subscribe(fn: (bumps: readonly TagBump[]) => void): () => void {
    return this.hub.subscribe(fn);
  }
}

export const wire = new Wire();

export class WireBus extends TagBus {
  public async publish(bumps: readonly TagBump[]): Promise<void> { await wire.send(bumps); }
  public subscribe(fn: (bumps: readonly TagBump[]) => void): () => void { return wire.subscribe(fn); }
}

/** The tier every process reaches (Redis in production): `down` rejects every call, `refusing` rejects bumps only. */
export class SharedTier extends CacheStore {
  public static store = new MemoryCacheStore();
  public static down = false;
  public static refusing = false;

  public static reset(): void {
    Object.assign(SharedTier, { store: new MemoryCacheStore(), down: false, refusing: false });
  }

  private static reach(refused = false): MemoryCacheStore {
    if (SharedTier.down || refused) throw new Error('shared tier down');
    return SharedTier.store;
  }

  public async get(key: string): Promise<CacheStoreRead | undefined> { return SharedTier.reach().get(key); }
  public async set(key: string, entry: CacheEntry): Promise<void> { await SharedTier.reach().set(key, entry); }
  public async delete(key: string): Promise<void> { await SharedTier.reach().delete(key); }
  public async versions(tags: readonly string[]): Promise<readonly string[]> { return SharedTier.reach().versions(tags); }
  public async bump(bumps: readonly TagBump[]): Promise<void> { await SharedTier.reach(SharedTier.refusing).bump(bumps); }
}

/** A process of its own: a child container with its own CacheService, on the wire and the shared tier. */
export async function startProcess(caches: Record<string, Record<string, unknown>>, register?: (container: IContainer) => void): Promise<TestApp> {
  return createTestApp({
    scope: 'child',
    config: { cache: { ttlJitter: 0, maxTtl: '10m', bus: 'WireBus', caches } },
    register: (container) => {
      container.register(WireBus).as(TagBus);
      container.register(SharedTier).as(CacheStore);
      register?.(container);
    },
  });
}

// The stores here are in memory, so every promise chain a call starts has run once the macrotask queue is reached.
export const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
