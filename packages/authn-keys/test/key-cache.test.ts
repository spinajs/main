import 'mocha';
import assert from 'node:assert/strict';
import { AuthnAudit } from '@spinajs/authn/audit';
import { InProcessCredentialChangeBus } from '@spinajs/authn/bus';
import type { CredentialChange, KeyOwner, KeyRecord } from '@spinajs/authn/contracts';
import { FakeBackoffThrottle, FakeClock, MemorySecretStore, RecordingEventSink, generateKeyPair, throttleParams } from '@spinajs/authn-testing';

import type { KeyCacheOptions } from '../src/options/index.js';
import { DefaultKeyRegistry, MemoryKeyStore } from '../src/registry/index.js';
import { keysOptionsFor } from './support/keys-options.js';

const SECOND = 1000;
const AUD = 'https://keys.cache.test';
const SVC: KeyOwner & { type: 'service' } = { type: 'service', id: 'svc-cache' };
const OTHER: KeyOwner & { type: 'service' } = { type: 'service', id: 'svc-other' };
const ADMIN = { type: 'user', id: 'admin' };

/** A MemoryKeyStore that counts the reads `byId` reaches. */
class CountingKeyStore extends MemoryKeyStore {
  public gets = 0;

  async get(kid: string): Promise<KeyRecord | null> {
    this.gets++;
    return super.get(kid);
  }
}

describe('DefaultKeyRegistry key cache', () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = new FakeClock();
    clock.install();
  });

  afterEach(() => {
    clock.uninstall();
  });

  function world(cache: KeyCacheOptions = { ttlSeconds: 10, maxEntries: 10_000 }) {
    const store = new CountingKeyStore();
    const bus = new InProcessCredentialChangeBus();
    const registry = new DefaultKeyRegistry({
      store,
      secrets: new MemorySecretStore(),
      throttle: new FakeBackoffThrottle(throttleParams()),
      audit: AuthnAudit.over([new RecordingEventSink()]),
      options: keysOptionsFor({ assertion: { audience: AUD }, cache }),
      bus,
    });
    const register = async (owner: KeyOwner & { type: 'service' } = SVC): Promise<KeyRecord> => {
      const r = await registry.register({ owner, actor: ADMIN, jwk: generateKeyPair('EdDSA').publicJwk }, clock.ctx());
      assert.ok(r.ok, 'the key is registered');
      return r.key;
    };
    /** byId and the store reads it cost. */
    const byId = async (kid: string) => {
      const before = store.gets;
      const key = await registry.byId(kid);
      return { key, reads: store.gets - before };
    };
    return { store, bus, registry, register, byId };
  }

  it('two byId calls within the ttl read the store once', async () => {
    const w = world();
    const key = await w.register();
    // register reads the stored key back, which caches it; let that entry expire.
    clock.tick(10 * SECOND);

    const first = await w.byId(key.kid);
    const second = await w.byId(key.kid);

    assert.strictEqual(first.reads, 1);
    assert.strictEqual(second.reads, 0);
    assert.deepStrictEqual(second.key, first.key);
    assert.strictEqual(first.key?.kid, key.kid);
  });

  it('reads the store again once the ttl has passed', async () => {
    const w = world();
    const key = await w.register();
    await w.byId(key.kid);

    clock.tick(10 * SECOND - 1);
    assert.strictEqual((await w.byId(key.kid)).reads, 0, 'still cached just before the ttl');

    clock.tick(1);
    assert.strictEqual((await w.byId(key.kid)).reads, 1);
  });

  it('serves a revoked key with its revokedAt right after revoke, and publishes the revoke', async () => {
    const w = world();
    const key = await w.register();
    const seen: CredentialChange[] = [];
    w.bus.subscribe((c) => seen.push(c));
    assert.strictEqual((await w.byId(key.kid)).key?.revokedAt, undefined);

    assert.strictEqual(await w.registry.revoke(SVC, key.kid, clock.ctx()), true);

    const after = await w.byId(key.kid);
    assert.strictEqual(after.key?.revokedAt?.getTime(), clock.now().getTime());
    assert.deepStrictEqual(seen, [{ kind: 'key', id: key.kid }]);
  });

  it('a published key change evicts that key and keeps the others', async () => {
    const w = world();
    const a = await w.register();
    const b = await w.register();
    await w.byId(a.kid);
    await w.byId(b.kid);

    await w.bus.publish({ kind: 'key', id: a.kid });

    assert.strictEqual((await w.byId(a.kid)).reads, 1);
    assert.strictEqual((await w.byId(b.kid)).reads, 0);
  });

  it("a published identity change evicts that owner's keys and keeps the others", async () => {
    const w = world();
    const mine = await w.register(SVC);
    const theirs = await w.register(OTHER);
    await w.byId(mine.kid);
    await w.byId(theirs.kid);

    await w.bus.publish({ kind: 'identity', identity: SVC });

    assert.strictEqual((await w.byId(mine.kid)).reads, 1);
    assert.strictEqual((await w.byId(theirs.kid)).reads, 0);
  });

  it('finds a key registered right after a lookup missed it', async () => {
    const w = world();
    const kp = generateKeyPair('EdDSA');
    assert.strictEqual((await w.byId('k-later')).key, null);

    const r = await w.registry.register({ owner: SVC, actor: ADMIN, jwk: kp.publicJwk, kid: 'k-later' }, clock.ctx());
    assert.ok(r.ok);

    assert.strictEqual((await w.byId('k-later')).key?.kid, 'k-later');
  });

  it('ttlSeconds 0 turns the cache off', async () => {
    const w = world({ ttlSeconds: 0, maxEntries: 10_000 });
    const key = await w.register();
    for (let i = 0; i < 3; i++) {
      assert.strictEqual((await w.byId(key.kid)).reads, 1);
    }
  });

  it('refuses a cache config outside its range', () => {
    for (const cache of [{ ttlSeconds: -1, maxEntries: 10 }, { ttlSeconds: 1.5, maxEntries: 10 }, { ttlSeconds: 10, maxEntries: 0 }, { ttlSeconds: Number.NaN, maxEntries: 10 }]) {
      assert.throws(() => keysOptionsFor({ cache }), /authn\.keys\.cache/, JSON.stringify(cache));
    }
  });
});
