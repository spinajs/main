import 'mocha';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { KeyRegistry, NonceStore } from '@spinajs/authn/contracts';
import type { AuthnContext, Credentials, KeyOwner } from '@spinajs/authn/contracts';
import { MemoryNonceStore } from '@spinajs/authn/nonces';
import { DbNonceStore } from '@spinajs/authn-orm';
import { FakeClock, generateKeyPair, signCompactJws, signHttpRequest } from '@spinajs/authn-testing';
import type { KitKeyPair } from '@spinajs/authn-testing';
import { StrictJwsVerifier } from '../src/jws/index.js';
import { HttpSignatureStrategy, JwsAssertionStrategy, assertionIssuer, nonceKey } from '../src/index.js';
import { keysOptionsFor } from './support/keys-options.js';
import { KIT_AUDIENCE, keysParts } from './harness.js';
import type { KeysParts, StoreKind } from './harness.js';

const SVC: KeyOwner & { type: 'service' } = { type: 'service', id: 'runner-1' };
const ADMIN = { type: 'user', id: 'admin' };
const TARGET = 'https://api.kit.test/v1/items';
const BODY = Buffer.from('{"a":1}', 'utf8');

async function registered(p: KeysParts, clock: FakeClock, kp: KitKeyPair = generateKeyPair('EdDSA')) {
  const ctx = (): AuthnContext => clock.ctx({ purpose: 'request' });
  const r = await p.registry.register({ owner: SVC, actor: ADMIN, jwk: kp.publicJwk }, ctx());
  assert.ok(r.ok);
  const nowS = Math.floor(clock.now().getTime() / 1000);
  return { kp, kid: r.key.kid, ctx, nowS };
}

/** Runs `body` with `store` as the only NonceStore in the root container, as an app without (or with) authn-orm sees it. */
async function withNonceStore<T>(store: Class<NonceStore> | null, registry: KeyRegistry, body: () => Promise<T>): Promise<T> {
  const registryFactory = { NonceTestKeyRegistry: () => registry }.NonceTestKeyRegistry;
  DI.unregister(NonceStore, DbNonceStore);
  if (store) {
    DI.register(store).as(NonceStore);
  }
  DI.register(registryFactory).as(KeyRegistry);
  try {
    return await body();
  } finally {
    for (const t of [KeyRegistry, NonceStore, HttpSignatureStrategy]) {
      DI.uncache(t as Class<unknown>);
    }
    DI.unregister(KeyRegistry, registryFactory);
    if (store) {
      DI.unregister(NonceStore, store);
    }
    DI.register(DbNonceStore).as(NonceStore);
  }
}

describe('key strategies resolve the core NonceStore', () => {
  describe('without a registered NonceStore', () => {
    it('JwsAssertionStrategy refuses to boot and names @spinajs/authn-orm', async () => {
      const p = await keysParts({}, 'memory');
      const strategy = new JwsAssertionStrategy({ registry: p.registry, verifier: new StrictJwsVerifier(), options: keysOptionsFor({ assertion: { audience: KIT_AUDIENCE } }) });
      await assert.rejects(strategy.resolve(), /@spinajs\/authn-orm/);
    });

    it('HttpSignatureStrategy refuses to boot and names @spinajs/authn-orm', async () => {
      const p = await keysParts({}, 'memory');
      await assert.rejects(new HttpSignatureStrategy({ registry: p.registry, options: keysOptionsFor() }).resolve(), /@spinajs\/authn-orm/);
    });

    it('resolving the strategy from DI fails the same way', async () => {
      const p = await keysParts({}, 'memory');
      await withNonceStore(null, p.registry, async () => {
        await assert.rejects(DI.resolve(HttpSignatureStrategy), /@spinajs\/authn-orm/);
      });
    });

    it('an injected store satisfies the boot check', async () => {
      const p = await keysParts({}, 'memory');
      await new HttpSignatureStrategy({ registry: p.registry, nonces: new MemoryNonceStore(), options: keysOptionsFor() }).resolve();
    });
  });

  for (const [label, kind] of [
    ['DbNonceStore', 'sqlite'],
    ['an explicitly registered MemoryNonceStore', 'memory'],
  ] as [string, StoreKind][]) {
    describe(`replay protection with ${label}`, function () {
      this.timeout(30000);

      it('accepts a JWS assertion jti once and holds it in the store', async () => {
        const clock = new FakeClock();
        const p = await keysParts({}, kind);
        assert.ok(p.nonces instanceof (kind === 'sqlite' ? DbNonceStore : MemoryNonceStore));
        const { kp, kid, ctx, nowS } = await registered(p, clock);
        const strategy = p.strategies.find((s) => s instanceof JwsAssertionStrategy) as JwsAssertionStrategy;
        const jti = randomUUID();
        const cred = (): Credentials => ({ kind: 'jws-assertion', jws: signCompactJws({ alg: kp.alg, kid, typ: 'spinajs-client+jwt' }, { iss: assertionIssuer(SVC), aud: KIT_AUDIENCE, iat: nowS, exp: nowS + 60, jti }, kp) });

        assert.ok((await strategy.verify(cred(), ctx())).ok);
        assert.deepStrictEqual(await strategy.verify(cred(), ctx()), { ok: false, reason: 'invalid_credentials' });
        const stillLive = new Date(clock.now().getTime() + 1000);
        assert.strictEqual(await p.nonces.claim(nonceKey('jti', kid, jti), new Date(stillLive.getTime() + 60_000), stillLive), false);
      });

      it('accepts an HTTP signature nonce once and holds it in the store', async () => {
        const clock = new FakeClock();
        const p = await keysParts({}, kind);
        const { kp, kid, ctx, nowS } = await registered(p, clock);
        const strategy = p.strategies.find((s) => s instanceof HttpSignatureStrategy) as HttpSignatureStrategy;
        const nonce = randomUUID();
        const cred = (): Credentials => ({ kind: 'http-signature', request: signHttpRequest({ method: 'POST', targetUri: TARGET, headers: { 'content-type': 'application/json' }, body: BODY }, kp, kid, { created: nowS, expires: nowS + 300, nonce }) });

        assert.ok((await strategy.verify(cred(), ctx())).ok);
        assert.deepStrictEqual(await strategy.verify(cred(), ctx()), { ok: false, reason: 'invalid_credentials' });
        const stillLive = new Date(clock.now().getTime() + 1000);
        assert.strictEqual(await p.nonces.claim(nonceKey('sig', kid, nonce), new Date(stillLive.getTime() + 60_000), stillLive), false);
      });
    });
  }

  it('the strategy resolved from DI uses the registered NonceStore', async () => {
    const clock = new FakeClock();
    const p = await keysParts({}, 'memory');
    const { kp, kid, ctx, nowS } = await registered(p, clock);
    await withNonceStore(MemoryNonceStore, p.registry, async () => {
      const strategy = await DI.resolve(HttpSignatureStrategy);
      assert.ok((strategy as unknown as { nonces: NonceStore }).nonces instanceof MemoryNonceStore);
      const request = signHttpRequest({ method: 'POST', targetUri: TARGET, headers: { 'content-type': 'application/json' }, body: BODY }, kp, kid, { created: nowS, expires: nowS + 300, nonce: randomUUID() });
      assert.ok((await strategy.verify({ kind: 'http-signature', request }, ctx())).ok);
      assert.deepStrictEqual(await strategy.verify({ kind: 'http-signature', request }, ctx()), { ok: false, reason: 'invalid_credentials' });
    });
  });
});
