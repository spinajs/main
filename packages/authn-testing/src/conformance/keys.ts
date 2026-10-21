import assert from 'node:assert/strict';
import type { IdentityRef, KeyAlgorithm, KeyOwner, KeyRecord } from '@spinajs/authn/contracts';
import { burst } from '../helpers/concurrency.js';
import { generateKeyPair, thumbprint } from '../helpers/crypto.js';
import { conformanceSuite } from './run.js';
import type { ConformanceOptions } from './run.js';

/** The shape of `KeyStore` in `@spinajs/authn-keys`, which this kit does not depend on. */
export interface KeyStorePort {
  insert(key: KeyRecord): Promise<'inserted' | 'duplicate'>;
  get(kid: string): Promise<KeyRecord | null>;
  listByOwner(owner: IdentityRef): Promise<readonly KeyRecord[]>;
  revoke(owner: IdentityRef, kid: string, at: Date): Promise<'revoked' | 'already' | 'none'>;
  touch(kid: string, at: Date): Promise<void>;
  dispose?(): Promise<void>;
}

const T0 = Date.parse('2026-06-01T10:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
const ALICE: KeyOwner = { type: 'user', id: 'conf-alice' };
const BOB: KeyOwner = { type: 'user', id: 'conf-bob' };

function keyOf(kid: string, owner: KeyOwner = ALICE, alg: KeyAlgorithm = 'ES256', over: Partial<KeyRecord> = {}): KeyRecord {
  const kp = generateKeyPair(alg);
  return { alg, jwk: kp.publicJwk, kid, owner, thumbprint: thumbprint(kp.publicJwk), createdAt: at(0), ...over } as KeyRecord;
}

/** Each case gets a store from `make` that holds no keys. */
export function runKeyStoreConformance(name: string, make: () => Promise<KeyStorePort>, opts: ConformanceOptions = {}): void {
  conformanceSuite(name, make, opts, false, (kase) => {
    kase('insert then get round-trips every field', async (store) => {
      const full = keyOf('k-full', { type: 'service', id: 'conf-svc' }, 'ES256', { name: 'ci key', scope: { roles: ['reader'] }, createdBy: { type: 'user', id: 'admin' }, expiresAt: at(3600) });
      const bare = keyOf('k-bare', ALICE, 'EdDSA');
      assert.strictEqual(await store.insert(full), 'inserted');
      assert.strictEqual(await store.insert(bare), 'inserted');
      assert.deepStrictEqual(await store.get('k-full'), full);
      assert.deepStrictEqual(await store.get('k-bare'), bare);
    });

    kase('an unknown kid is null', async (store) => {
      assert.strictEqual(await store.get('conf-missing'), null);
    });

    kase('a taken kid or thumbprint is a duplicate and changes nothing', async (store) => {
      const first = keyOf('k-1');
      assert.strictEqual(await store.insert(first), 'inserted');
      assert.strictEqual(await store.insert(keyOf('k-1')), 'duplicate', 'same kid');
      assert.strictEqual(await store.insert({ ...keyOf('k-2'), jwk: first.jwk, thumbprint: first.thumbprint } as KeyRecord), 'duplicate', 'same thumbprint');
      assert.strictEqual(await store.get('k-2'), null);
      assert.deepStrictEqual(await store.get('k-1'), first);
    });

    kase('of 10 parallel inserts of one kid exactly one inserts', async (store) => {
      const results = await burst(10, () => store.insert(keyOf('k-race')));
      assert.strictEqual(results.rejected().length, 0);
      assert.strictEqual(results.count((r) => r === 'inserted'), 1);
      assert.strictEqual(results.count((r) => r === 'duplicate'), 9);
    });

    kase('revoke keeps the key readable with revokedAt, and listed', async (store) => {
      await store.insert(keyOf('k-live'));
      await store.insert(keyOf('k-gone'));
      assert.strictEqual(await store.revoke(ALICE, 'k-gone', at(10)), 'revoked');
      assert.strictEqual((await store.get('k-gone'))?.revokedAt?.getTime(), at(10).getTime());
      assert.strictEqual((await store.get('k-live'))?.revokedAt, undefined);
      const listed = await store.listByOwner(ALICE);
      assert.deepStrictEqual([...listed.map((k) => k.kid)].sort(), ['k-gone', 'k-live']);
    });

    kase('a second revoke is already and keeps the first revokedAt', async (store) => {
      await store.insert(keyOf('k-1'));
      assert.strictEqual(await store.revoke(ALICE, 'k-1', at(10)), 'revoked');
      assert.strictEqual(await store.revoke(ALICE, 'k-1', at(20)), 'already');
      assert.strictEqual((await store.get('k-1'))?.revokedAt?.getTime(), at(10).getTime());
    });

    kase('revoke by another owner, by another owner type or of an unknown kid is none', async (store) => {
      await store.insert(keyOf('k-1'));
      assert.strictEqual(await store.revoke(BOB, 'k-1', at(10)), 'none');
      assert.strictEqual(await store.revoke({ type: 'service', id: ALICE.id }, 'k-1', at(10)), 'none');
      assert.strictEqual(await store.revoke(ALICE, 'conf-missing', at(10)), 'none');
      assert.strictEqual((await store.get('k-1'))?.revokedAt, undefined);
    });

    kase('of 10 parallel revokes exactly one revokes', async (store) => {
      await store.insert(keyOf('k-race'));
      const results = await burst(10, () => store.revoke(ALICE, 'k-race', at(10)));
      assert.strictEqual(results.rejected().length, 0);
      assert.strictEqual(results.count((r) => r === 'revoked'), 1);
      assert.strictEqual(results.count((r) => r === 'already'), 9);
    });

    kase('touch sets lastUsedAt and nothing else', async (store) => {
      const key = keyOf('k-1', ALICE, 'ES256', { name: 'laptop', expiresAt: at(3600) });
      await store.insert(key);
      await store.touch('k-1', at(30));
      assert.deepStrictEqual(await store.get('k-1'), { ...key, lastUsedAt: at(30) });
      await store.revoke(ALICE, 'k-1', at(40));
      await store.touch('k-1', at(50));
      const after = await store.get('k-1');
      assert.strictEqual(after?.revokedAt?.getTime(), at(40).getTime());
      assert.strictEqual(after?.lastUsedAt?.getTime(), at(50).getTime());
    });

    kase('touch of an unknown kid does not throw or create a key', async (store) => {
      await store.touch('conf-missing', at(30));
      assert.strictEqual(await store.get('conf-missing'), null);
    });

    kase('listByOwner never returns another owner key, also one of the same id and another type', async (store) => {
      await store.insert(keyOf('k-a1', ALICE));
      await store.insert(keyOf('k-a2', ALICE, 'EdDSA'));
      await store.insert(keyOf('k-b1', BOB));
      await store.insert(keyOf('k-s1', { type: 'service', id: ALICE.id }));
      assert.deepStrictEqual([...(await store.listByOwner(ALICE)).map((k) => k.kid)].sort(), ['k-a1', 'k-a2']);
      assert.deepStrictEqual((await store.listByOwner(BOB)).map((k) => k.kid), ['k-b1']);
      assert.deepStrictEqual((await store.listByOwner({ type: 'service', id: ALICE.id })).map((k) => k.kid), ['k-s1']);
      assert.deepStrictEqual(await store.listByOwner({ type: 'user', id: 'conf-nobody' }), []);
    });
  });
}
