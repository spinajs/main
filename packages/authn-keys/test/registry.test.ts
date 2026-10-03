import 'mocha';
import assert from 'node:assert/strict';
import { DI } from '@spinajs/di';
import { AuthnEventSink, AuthnThrottle, KeyRegistry, SecretStore } from '@spinajs/authn/contracts';
import type { AuthnContext, KeyChallenge, KeyOwner, KeyRegistration } from '@spinajs/authn/contracts';
import { FakeBackoffThrottle, FakeClock, MemorySecretStore, RecordingEventSink, generateKeyPair, throttleParams } from '@spinajs/authn-testing';
import type { KitKeyPair } from '@spinajs/authn-testing';
import { challengeSecretPurpose, parseChallengeId, signChallenge } from '../src/challenge/index.js';
import { keysOptions } from '../src/options/index.js';
import { DefaultKeyRegistry, KeyStore, MemoryKeyStore } from '../src/registry/index.js';

const ALICE: KeyOwner & { type: 'user' } = { type: 'user', id: 'alice' };
const BOB: KeyOwner & { type: 'user' } = { type: 'user', id: 'bob' };
const SVC: KeyOwner & { type: 'service' } = { type: 'service', id: 'svc' };
const ADMIN = { type: 'user', id: 'admin' };

const AUD = 'https://keys.kit.test';

function world(options = keysOptions({ assertion: { audience: AUD } })) {
  const clock = new FakeClock();
  const secrets = new MemorySecretStore();
  const events = new RecordingEventSink();
  const registry = new DefaultKeyRegistry(new MemoryKeyStore(), secrets, new FakeBackoffThrottle(throttleParams()), [events], options);
  const ctx = (): AuthnContext => clock.ctx();
  const challenge = async (owner = ALICE): Promise<KeyChallenge> => {
    const r = await registry.challenge({ purpose: 'register', owner }, ctx());
    assert.ok(r.ok);
    return r.challenge;
  };
  const proofFor = async (kp: KitKeyPair, owner = ALICE, ch?: KeyChallenge, purpose: 'register' | 'login' = 'register') => {
    const c = ch ?? (await challenge(owner));
    return { challengeId: c.id, signature: signChallenge(c, purpose, AUD, kp.privateKey, kp.alg) };
  };
  return { clock, secrets, events, registry, ctx, challenge, proofFor };
}

const userReg = (kp: KitKeyPair, proof: unknown, owner = ALICE, over: object = {}): KeyRegistration => ({ owner, jwk: kp.publicJwk, proof, ...over } as unknown as KeyRegistration);

describe('DefaultKeyRegistry', () => {
  it('refuses a kid outside the grammar and keys outside the configured algorithms', async () => {
    const w = world(keysOptions({ algorithms: ['EdDSA'], assertion: { audience: AUD } }));
    const kp = generateKeyPair('EdDSA');
    for (const kid of ['', 'a b', 'x'.repeat(65), 'ä']) {
      assert.deepStrictEqual(await w.registry.register({ owner: SVC, actor: ADMIN, jwk: kp.publicJwk, kid }, w.ctx()), { ok: false, code: 'invalid_key' }, kid);
    }
    assert.deepStrictEqual(await w.registry.register({ owner: SVC, actor: ADMIN, jwk: generateKeyPair('ES256').publicJwk }, w.ctx()), { ok: false, code: 'invalid_key' });
  });

  it('refuses a past expiry, an empty or long name and a scope that is not an object', async () => {
    const w = world();
    const kp = generateKeyPair('EdDSA');
    const base = { owner: SVC, actor: ADMIN, jwk: kp.publicJwk };
    for (const over of [{ expiresAt: w.clock.now() }, { expiresAt: new Date(NaN) }, { name: '' }, { name: 'n'.repeat(129) }, { scope: ['x'] }]) {
      assert.deepStrictEqual(await w.registry.register({ ...base, ...over } as never, w.ctx()), { ok: false, code: 'invalid_key' }, JSON.stringify(over));
    }
  });

  it('registers a service key without a proof and records the actor', async () => {
    const w = world();
    const kp = generateKeyPair('ES256');
    const r = await w.registry.register({ owner: SVC, actor: ADMIN, jwk: kp.publicJwk, name: 'runner', scope: { roles: ['runner'] } }, w.ctx());
    assert.ok(r.ok);
    assert.deepStrictEqual({ alg: r.key.alg, owner: r.key.owner, createdBy: r.key.createdBy, name: r.key.name, scope: r.key.scope }, { alg: 'ES256', owner: SVC, createdBy: ADMIN, name: 'runner', scope: { roles: ['runner'] } });
    assert.strictEqual(r.key.createdAt.getTime(), w.clock.now().getTime());
  });

  it('refuses a user key without a proof whatever the caller passes', async () => {
    const w = world();
    const kp = generateKeyPair('EdDSA');
    assert.deepStrictEqual(await w.registry.register(userReg(kp, undefined), w.ctx()), { ok: false, code: 'invalid_proof' });
    assert.deepStrictEqual(await w.registry.register({ owner: ALICE, actor: ADMIN, jwk: kp.publicJwk } as never, w.ctx()), { ok: false, code: 'invalid_proof' });
    assert.deepStrictEqual(await w.registry.register(userReg(kp, { challengeId: 'x', signature: 'y' }), w.ctx()), { ok: false, code: 'invalid_proof' });
  });

  it('checks the key, then the proof, then duplicates', async () => {
    const w = world();
    const kp = generateKeyPair('EdDSA');
    assert.ok((await w.registry.register(userReg(kp, await w.proofFor(kp)), w.ctx())).ok);
    assert.deepStrictEqual(await w.registry.register(userReg(kp, { challengeId: 'bad', signature: 'bad' }), w.ctx()), { ok: false, code: 'invalid_proof' }, 'a duplicate key with a bad proof');
    assert.deepStrictEqual(await w.registry.register(userReg(kp, await w.proofFor(kp)), w.ctx()), { ok: false, code: 'duplicate' }, 'a duplicate key with a good proof');
    assert.deepStrictEqual(await w.registry.register({ ...userReg(kp, { challengeId: 'bad', signature: 'bad' }), jwk: { kty: 'RSA' } } as never, w.ctx()), { ok: false, code: 'invalid_key' }, 'an invalid key with a bad proof');
  });

  it('refuses proofs under a login challenge, another user’s challenge, an expired challenge or a broken id', async () => {
    const w = world();
    const kp = generateKeyPair('EdDSA');
    const login = await w.registry.challenge({ purpose: 'login', kid: kp.kid }, w.ctx());
    assert.ok(login.ok);
    assert.deepStrictEqual(await w.registry.register(userReg(kp, await w.proofFor(kp, ALICE, login.challenge, 'register')), w.ctx()), { ok: false, code: 'invalid_proof' }, 'login challenge');
    assert.deepStrictEqual(await w.registry.register(userReg(kp, await w.proofFor(kp, BOB)), w.ctx()), { ok: false, code: 'invalid_proof' }, "bob's challenge");

    const ch = await w.challenge();
    w.clock.install();
    try {
      w.clock.tick(121_000);
      assert.deepStrictEqual(await w.registry.register(userReg(kp, await w.proofFor(kp, ALICE, ch)), w.ctx()), { ok: false, code: 'invalid_proof' }, 'expired');
    } finally {
      w.clock.uninstall();
    }
    const fresh = await w.challenge();
    const proof = await w.proofFor(kp, ALICE, fresh);
    for (const challengeId of [fresh.nonce, `${fresh.id}x`, fresh.id.replace('.', '-'), `${fresh.id.slice(0, 15)}.${fresh.nonce}`]) {
      assert.deepStrictEqual(await w.registry.register(userReg(kp, { ...proof, challengeId }), w.ctx()), { ok: false, code: 'invalid_proof' }, challengeId);
    }
    assert.ok((await w.registry.register(userReg(kp, proof), w.ctx())).ok, 'the untouched challenge still works');
  });

  it('a bad signature burns nothing; a good one redeems once', async () => {
    const w = world();
    const kp = generateKeyPair('EdDSA');
    const ch = await w.challenge();
    const bad = { challengeId: ch.id, signature: signChallenge(ch, 'register', AUD, generateKeyPair('EdDSA').privateKey, 'EdDSA') };
    assert.deepStrictEqual(await w.registry.register(userReg(kp, bad), w.ctx()), { ok: false, code: 'invalid_proof' });
    assert.ok((await w.registry.register(userReg(kp, await w.proofFor(kp, ALICE, ch)), w.ctx())).ok);
    const parsed = parseChallengeId(ch.id)!;
    assert.strictEqual(await w.secrets.redeem(ALICE, challengeSecretPurpose(parsed.rid), parsed.nonce), false, 'redeemed');
  });

  it('challenge ids are <rid>.<nonce>, every challenge stands alone and the purpose fits varchar(32)', async () => {
    const w = world();
    const a = await w.challenge();
    const b = await w.challenge();
    const l = await w.registry.challenge({ purpose: 'login', kid: 'k' }, w.ctx());
    assert.ok(l.ok);
    for (const c of [a, b, l.challenge]) {
      const p = parseChallengeId(c.id)!;
      assert.strictEqual(p.nonce, c.nonce);
      assert.ok(challengeSecretPurpose(p.rid).length <= 32);
      assert.strictEqual(c.expiresAt.getTime(), w.clock.now().getTime() + 120_000);
    }
    const kp = generateKeyPair('EdDSA');
    assert.ok((await w.registry.register(userReg(kp, await w.proofFor(kp, ALICE, a)), w.ctx())).ok, 'the first challenge survives the second');
  });

  it('a login challenge for a name that is not a kid has the same shape', async () => {
    const w = world();
    const r = await w.registry.challenge({ purpose: 'login', kid: 'no such kid/ä'.repeat(20) }, w.ctx());
    assert.ok(r.ok);
    assert.deepStrictEqual(Object.keys(r.challenge).sort(), ['expiresAt', 'id', 'nonce']);
    assert.ok(w.secrets.rows().every((row) => row.identity.id.length <= 64));
  });

  it('revoke is owner-bound, keeps the first revocation time and emits one event without key material', async () => {
    const w = world();
    const kp = generateKeyPair('ES256');
    const r = await w.registry.register({ owner: SVC, actor: ADMIN, jwk: kp.publicJwk }, w.ctx());
    assert.ok(r.ok);
    assert.strictEqual(await w.registry.revoke({ type: 'agent', id: 'svc' }, r.key.kid, w.ctx()), false, 'same id, other type');
    assert.strictEqual(await w.registry.revoke(SVC, 'nope', w.ctx()), false);
    const first = w.clock.now();
    assert.strictEqual(await w.registry.revoke(SVC, r.key.kid, w.ctx(), { actor: ADMIN }), true);
    w.clock.tick(5000);
    assert.strictEqual(await w.registry.revoke(SVC, r.key.kid, w.ctx()), true);
    assert.strictEqual((await w.registry.byId(r.key.kid))!.revokedAt!.getTime(), first.getTime());
    const text = JSON.stringify(w.events.all());
    assert.ok(!text.includes(kp.publicJwk.x) && !text.includes((kp.publicJwk as { y: string }).y), 'no key material in events');
    assert.deepStrictEqual(
      w.events.all().map((e) => [e.type, e.outcome, e.actor]),
      [
        ['key.register', 'success', ADMIN],
        ['key.revoke', 'success', ADMIN],
      ],
    );
  });

  it('throws on a malformed owner or a service key without an actor (programming errors, not credentials)', async () => {
    const w = world();
    const kp = generateKeyPair('EdDSA');
    await assert.rejects(w.registry.register({ owner: { type: 'group', id: 'g' }, actor: ADMIN, jwk: kp.publicJwk } as never, w.ctx()), TypeError);
    await assert.rejects(w.registry.register({ owner: SVC, jwk: kp.publicJwk } as never, w.ctx()), TypeError);
    await assert.rejects(w.registry.challenge({ purpose: 'register', owner: SVC } as never, w.ctx()), TypeError);
  });

  it('binds challenge signatures to this service: a proof signed for another audience fails', async () => {
    const w = world();
    const kp = generateKeyPair('EdDSA');
    const ch = await w.challenge();
    const relayed = { challengeId: ch.id, signature: signChallenge(ch, 'register', 'https://other.example', kp.privateKey, kp.alg) };
    assert.deepStrictEqual(await w.registry.register(userReg(kp, relayed), w.ctx()), { ok: false, code: 'invalid_proof' });
    assert.ok((await w.registry.register(userReg(kp, await w.proofFor(kp, ALICE, ch)), w.ctx())).ok, 'the challenge was not burnt');
  });

  it('issues no challenge without an audience, or with a SecretStore whose secrets are not base64url', async () => {
    const noAudience = world(keysOptions());
    await assert.rejects(noAudience.registry.challenge({ purpose: 'register', owner: ALICE }, noAudience.ctx()), /audience/);
    const kp = generateKeyPair('EdDSA');
    assert.deepStrictEqual(await noAudience.registry.register(userReg(kp, { challengeId: 'x', signature: 'y' }), noAudience.ctx()), { ok: false, code: 'invalid_proof' });
    class ColonSecrets extends MemorySecretStore {
      async issue(identity: Parameters<MemorySecretStore['issue']>[0], purpose: string, ttl: number): Promise<string> {
        await super.issue(identity, purpose, ttl);
        return 'abc:def:ghi-jkl-mno-pqr-stu';
      }
    }
    const registry = new DefaultKeyRegistry(new MemoryKeyStore(), new ColonSecrets(), new FakeBackoffThrottle(throttleParams()), [], keysOptions({ assertion: { audience: AUD } }));
    await assert.rejects(registry.challenge({ purpose: 'login', kid: 'k' }, new FakeClock().ctx()), /base64url/);
  });

  it('refuses an actor longer than created_by and a scope that is not a Ceiling', async () => {
    const w = world();
    const jwk = () => generateKeyPair('EdDSA').publicJwk;
    await assert.rejects(w.registry.register({ owner: SVC, actor: { type: 'user', id: 'a'.repeat(96) }, jwk: jwk() }, w.ctx()), TypeError);
    assert.ok((await w.registry.register({ owner: SVC, actor: { type: 'user', id: 'a'.repeat(95) }, jwk: jwk() }, w.ctx())).ok, '100 characters fit');
    for (const scope of [{ roles: 'admin' }, { roles: [1] }, { permissions: [null] }, { resources: [{ id: 'x' }] }, { expiresAt: 'tomorrow' }, { expiresAt: new Date(NaN) }, { reason: 7 }, { extra: true }]) {
      assert.deepStrictEqual(await w.registry.register({ owner: SVC, actor: ADMIN, jwk: jwk(), scope } as never, w.ctx()), { ok: false, code: 'invalid_key' }, JSON.stringify(scope));
    }
    const ok = await w.registry.register({ owner: SVC, actor: ADMIN, jwk: jwk(), scope: { roles: ['r'], permissions: ['file:*'], resources: [{ type: 'file', id: '1' }, { type: 'dir' }], expiresAt: new Date(2_000_000_000_000), reason: 'out_of_scope' } }, w.ctx());
    assert.ok(ok.ok);
    assert.deepStrictEqual(ok.key.scope?.expiresAt, new Date(2_000_000_000_000));
  });

  it('resolves from DI with its dependencies registered', async () => {
    class TestThrottle extends FakeBackoffThrottle {
      constructor() {
        super(throttleParams());
      }
    }
    class SpySink extends RecordingEventSink {
      static last: SpySink | undefined;
      constructor() {
        super();
        SpySink.last = this;
      }
    }
    const types = [MemoryKeyStore, MemorySecretStore, TestThrottle, SpySink];
    DI.register(MemoryKeyStore).as(KeyStore);
    DI.register(MemorySecretStore).as(SecretStore);
    DI.register(TestThrottle).as(AuthnThrottle);
    DI.register(SpySink).as(AuthnEventSink);
    try {
      const registry = await DI.resolve(KeyRegistry);
      assert.ok(registry instanceof DefaultKeyRegistry);
      const r = await registry.register({ owner: SVC, actor: ADMIN, jwk: generateKeyPair('EdDSA').publicJwk }, new FakeClock().ctx());
      assert.ok(r.ok);
      assert.strictEqual(SpySink.last?.all().length, 1, 'the registered sink got the event');
    } finally {
      for (const t of [KeyRegistry, KeyStore, SecretStore, AuthnThrottle, AuthnEventSink, ...types] as unknown as (new () => unknown)[]) {
        DI.uncache(t);
      }
      for (const t of types) {
        DI.unregister(t);
      }
    }
  });
});
