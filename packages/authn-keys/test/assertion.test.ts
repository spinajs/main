import 'mocha';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AuthnContext, Credentials, KeyOwner } from '@spinajs/authn/contracts';
import { FakeClock, generateKeyPair, runStrategyConformance, signCompactJws } from '@spinajs/authn-testing';
import type { KitKeyPair } from '@spinajs/authn-testing';
import { DbKeyNonceStore, MemoryKeyNonceStore } from '../src/nonce/index.js';
import type { KeyNonceStore } from '../src/nonce/index.js';
import { keysOptions } from '../src/options/index.js';
import { JwsAssertionStrategy, assertionIssuer } from '../src/strategies/index.js';
import { bootSqlite, clearKeys } from './db.js';
import { KIT_AUDIENCE, keysParts } from './harness.js';

const SVC: KeyOwner & { type: 'service' } = { type: 'service', id: 'runner-1' };
const ADMIN = { type: 'user', id: 'admin' };
const TYP = 'spinajs-client+jwt';

async function world(clock = new FakeClock()) {
  const p = await keysParts({}, 'memory');
  const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => clock.ctx({ purpose: 'request', ...over });
  const add = async (kp: KitKeyPair = generateKeyPair('EdDSA'), over: object = {}) => {
    const r = await p.registry.register({ owner: SVC, actor: ADMIN, jwk: kp.publicJwk, ...over }, ctx());
    assert.ok(r.ok, JSON.stringify(r));
    return { kp, kid: r.key.kid };
  };
  const nowS = () => Math.floor(clock.now().getTime() / 1000);
  const assertion = (kp: KitKeyPair, kid: string, over: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Credentials => ({
    kind: 'jws-assertion',
    jws: signCompactJws({ alg: kp.alg, kid, typ: TYP, ...header }, { iss: assertionIssuer(SVC), aud: KIT_AUDIENCE, iat: nowS(), exp: nowS() + 60, jti: randomUUID(), ...over }, kp),
  });
  const strategy = p.strategies[0] as JwsAssertionStrategy;
  return { p, clock, ctx, add, nowS, assertion, strategy };
}

describe('JwsAssertionStrategy', () => {
  it('accepts an assertion of a registered key: identity = owner, method jws, ceiling = scope', async () => {
    const w = await world();
    const { kp, kid } = await w.add(generateKeyPair('ES256'), { scope: { roles: ['runner'] } });
    assert.deepStrictEqual(await w.strategy.verify(w.assertion(kp, kid), w.ctx()), { ok: true, identity: SVC, method: 'jws', ceiling: { roles: ['runner'] } });
  });

  it('refuses a wrong iss form, audience, typ or jti, and a lifetime over the configured one', async () => {
    const w = await world();
    const { kp, kid } = await w.add();
    const refused = [w.assertion(kp, kid, { iss: SVC.id }), w.assertion(kp, kid, { iss: 'user:runner-1' }), w.assertion(kp, kid, { aud: 'other' }), w.assertion(kp, kid, {}, { typ: 'JWT' }), w.assertion(kp, kid, { jti: undefined }), w.assertion(kp, kid, { jti: '' }), w.assertion(kp, kid, { jti: 'j'.repeat(129) }), w.assertion(kp, kid, { jti: 7 }), w.assertion(kp, kid, { exp: w.nowS() + 301 }), { kind: 'jws-assertion', jws: 42 } as unknown as Credentials];
    for (const c of refused) {
      assert.deepStrictEqual(await w.strategy.verify(c, w.ctx()), { ok: false, reason: 'invalid_credentials' }, JSON.stringify(c));
    }
    assert.ok((await w.strategy.verify(w.assertion(kp, kid, { jti: 'j'.repeat(128), exp: w.nowS() + 300 }), w.ctx())).ok);
  });

  it('honours a lower configured lifetime', async () => {
    const clock = new FakeClock();
    const p = await keysParts({ authn: { keys: { assertion: { maxLifetimeSeconds: 60, skewSeconds: 30 } } } }, 'memory');
    const kp = generateKeyPair('EdDSA');
    const r = await p.registry.register({ owner: SVC, actor: ADMIN, jwk: kp.publicJwk }, clock.ctx());
    assert.ok(r.ok);
    const s = Math.floor(clock.now().getTime() / 1000);
    const c = (exp: number): Credentials => ({ kind: 'jws-assertion', jws: signCompactJws({ alg: 'EdDSA', kid: r.key.kid, typ: TYP }, { iss: assertionIssuer(SVC), aud: KIT_AUDIENCE, iat: s, exp, jti: randomUUID() }, kp) });
    assert.ok((await p.strategies[0].verify(c(s + 60), clock.ctx())).ok);
    assert.strictEqual((await p.strategies[0].verify(c(s + 61), clock.ctx())).ok, false);
  });

  it('gives revoked and expired as audit reasons, and the same answer for an unknown kid as for a bad signature', async () => {
    const w = await world();
    const a = await w.add();
    const b = await w.add(generateKeyPair('EdDSA'), { expiresAt: new Date(w.clock.now().getTime() + 1000) });
    await w.p.registry.revoke(SVC, a.kid, w.ctx());
    assert.deepStrictEqual(await w.strategy.verify(w.assertion(a.kp, a.kid), w.ctx()), { ok: false, reason: 'revoked' });
    w.clock.tick(1000);
    assert.deepStrictEqual(await w.strategy.verify(w.assertion(b.kp, b.kid), w.ctx()), { ok: false, reason: 'expired' });
    const c = await w.add();
    assert.deepStrictEqual(await w.strategy.verify(w.assertion(generateKeyPair('EdDSA'), c.kid), w.ctx()), { ok: false, reason: 'invalid_credentials' });
    assert.deepStrictEqual(await w.strategy.verify(w.assertion(c.kp, 'kit-unknown'), w.ctx()), { ok: false, reason: 'invalid_credentials' });
  });

  it('accepts a jti once per key within its lifetime', async () => {
    const w = await world();
    const a = await w.add();
    const b = await w.add();
    const jti = randomUUID();
    assert.ok((await w.strategy.verify(w.assertion(a.kp, a.kid, { jti }), w.ctx())).ok);
    assert.strictEqual((await w.strategy.verify(w.assertion(a.kp, a.kid, { jti }), w.ctx())).ok, false, 'the same jti again, newly signed');
    assert.ok((await w.strategy.verify(w.assertion(b.kp, b.kid, { jti }), w.ctx())).ok, 'jti is scoped to the key');
  });

  it('throttles by kid, never by the token, and refuses the wrong kind', async () => {
    const w = await world();
    const { kp, kid } = await w.add();
    const c = w.assertion(kp, kid);
    assert.deepStrictEqual(w.strategy.throttleKeys(c, w.ctx({ ip: '192.0.2.1' })), [
      { kind: 'account', value: `key:${kid}` },
      { kind: 'account-ip', value: `key:${kid}|192.0.2.1` },
    ]);
    assert.deepStrictEqual(
      w.strategy.throttleKeys({ kind: 'jws-assertion', jws: 'garbage' }, w.ctx({ ip: '192.0.2.1' })).map((k) => k.value),
      ['key:?', 'key:?|192.0.2.1'],
    );
    assert.deepStrictEqual(await w.strategy.verify({ kind: 'bearer', token: 'x' }, w.ctx()), { ok: false, reason: 'unsupported_credentials' });
  });

  it('stamps last use at most once a minute', async () => {
    const w = await world();
    const { kp, kid } = await w.add();
    await w.strategy.verify(w.assertion(kp, kid), w.ctx());
    const first = (await w.p.registry.byId(kid))!.lastUsedAt!.getTime();
    w.clock.tick(59_000);
    await w.strategy.verify(w.assertion(kp, kid), w.ctx());
    assert.strictEqual((await w.p.registry.byId(kid))!.lastUsedAt!.getTime(), first);
    w.clock.tick(1_000);
    await w.strategy.verify(w.assertion(kp, kid), w.ctx());
    assert.strictEqual((await w.p.registry.byId(kid))!.lastUsedAt!.getTime(), first + 60_000);
  });

  it('cannot be built without an audience', async () => {
    const p = await keysParts({}, 'memory');
    assert.throws(() => new JwsAssertionStrategy(p.registry, p.verifier, new MemoryKeyNonceStore(), keysOptions()), /audience/);
  });
});

for (const kind of ['memory', 'sqlite'] as const) {
  describe(`KeyNonceStore (${kind})`, () => {
    let store: KeyNonceStore;
    beforeEach(async () => {
      if (kind === 'sqlite') {
        await bootSqlite();
        await clearKeys();
        store = new DbKeyNonceStore();
      } else {
        store = new MemoryKeyNonceStore();
      }
    });

    it('claims a live key once and an expired one again', async () => {
      const t0 = new Date(1_800_000_000_000);
      const later = (ms: number) => new Date(t0.getTime() + ms);
      assert.strictEqual(await store.claim('jti:a', later(60_000), t0), true);
      assert.strictEqual(await store.claim('jti:a', later(120_000), later(59_000)), false);
      assert.strictEqual(await store.claim('jti:b', later(60_000), t0), true);
      assert.strictEqual(await store.claim('jti:a', later(120_000), later(60_000)), true, 'expired at expiresAt');
      assert.strictEqual(await store.claim('jti:a', later(180_000), later(61_000)), false);
    });

    it('lets one of many parallel claims win', async () => {
      const t0 = new Date(1_800_000_000_000);
      const results = await Promise.all(Array.from({ length: 20 }, () => store.claim('sig:race', new Date(t0.getTime() + 1000), t0)));
      assert.strictEqual(results.filter(Boolean).length, 1);
      const again = await Promise.all(Array.from({ length: 20 }, () => store.claim('sig:race', new Date(t0.getTime() + 5000), new Date(t0.getTime() + 2000))));
      assert.strictEqual(again.filter(Boolean).length, 1, 'one claimant takes over the expired key');
    });
  });
}

runStrategyConformance(
  async ({ clock }) => {
    const w = await world(clock);
    const { kp, kid } = await w.add();
    const other = generateKeyPair('EdDSA');
    w.p.events.clear();
    return {
      strategy: w.strategy,
      valid: async () => w.assertion(kp, kid),
      invalid: async () => w.assertion(other, kid),
      unknown: async () => w.assertion(other, other.kid),
      sameId: async () => w.assertion(kp, kid),
      secretsOf: (c) => [String((c as { jws?: unknown }).jws)],
      sessions: { count: async () => (await w.p.sessions.storage.storedKeys()).length },
      events: w.p.events,
    };
  },
  { title: 'authn-keys: JwsAssertionStrategy conformance' },
);
