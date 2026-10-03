import 'mocha';
import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import type { AuthnContext, Credentials, KeyAlgorithm, KeyChallenge, KeyOwner } from '@spinajs/authn/contracts';
import { FakeClock, generateKeyPair, runStrategyConformance } from '@spinajs/authn-testing';
import type { KitKeyPair } from '@spinajs/authn-testing';
import { challengeSigningInput, signChallenge } from '../src/challenge/index.js';
import { keysOptions } from '../src/options/index.js';
import { KeyChallengeStrategy } from '../src/strategies/index.js';
import { KIT_AUDIENCE, keysParts } from './harness.js';

const ALICE: KeyOwner & { type: 'user' } = { type: 'user', id: 'alice' };

async function world(clock = new FakeClock()) {
  const p = await keysParts({}, 'memory');
  const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => clock.ctx(over);
  const add = async (kp: KitKeyPair = generateKeyPair('EdDSA'), over: object = {}) => {
    const reg = await p.registry.challenge({ purpose: 'register', owner: ALICE }, ctx());
    assert.ok(reg.ok);
    const r = await p.registry.register({ owner: ALICE, jwk: kp.publicJwk, proof: { challengeId: reg.challenge.id, signature: signChallenge(reg.challenge, 'register', KIT_AUDIENCE, kp.privateKey, kp.alg) }, ...over }, ctx());
    assert.ok(r.ok, JSON.stringify(r));
    return { kp, kid: r.key.kid };
  };
  const challenge = async (kid: string): Promise<KeyChallenge> => {
    // No IP: the timing case issues hundreds of challenges, which the login IP key would throttle.
    const r = await p.registry.challenge({ purpose: 'login', kid }, ctx({ ip: undefined }));
    assert.ok(r.ok);
    return r.challenge;
  };
  const login = (kid: string, ch: KeyChallenge, kp: KitKeyPair, purpose: 'login' | 'register' = 'login'): Credentials => ({ kind: 'key-challenge', keyId: kid, challengeId: ch.id, signature: signChallenge(ch, purpose, KIT_AUDIENCE, kp.privateKey, kp.alg) });
  const strategy = p.strategies.find((s) => s instanceof KeyChallengeStrategy) as KeyChallengeStrategy;
  return { p, clock, ctx, add, challenge, login, strategy };
}

describe('KeyChallengeStrategy', () => {
  it('signs spinajs-key-login:<nonce> and logs in once, for Ed25519 and P-256 keys', async () => {
    const w = await world();
    for (const alg of ['EdDSA', 'ES256'] as const) {
      const { kp, kid } = await w.add(generateKeyPair(alg));
      const ch = await w.challenge(kid);
      assert.deepStrictEqual(challengeSigningInput(ch, 'login', KIT_AUDIENCE).toString('utf8'), `spinajs-key-login:${ch.nonce}:${KIT_AUDIENCE}`);
      const c = w.login(kid, ch, kp);
      assert.deepStrictEqual(await w.strategy.verify(c, w.ctx()), { ok: true, identity: ALICE, method: 'key-challenge' });
      assert.deepStrictEqual(await w.strategy.verify(c, w.ctx()), { ok: false, reason: 'invalid_credentials' }, 'used');
    }
  });

  it('a raw Ed25519 signature over the documented bytes works (what a CLI with openssl sends)', async () => {
    const w = await world();
    const { kp, kid } = await w.add();
    const ch = await w.challenge(kid);
    const signature = sign(null, Buffer.from(`spinajs-key-login:${ch.nonce}:${KIT_AUDIENCE}`, 'utf8'), kp.privateKey).toString('base64url');
    assert.ok((await w.strategy.verify({ kind: 'key-challenge', keyId: kid, challengeId: ch.id, signature }, w.ctx())).ok);
  });

  it('a wrong signature burns nothing; a register signature, another kid’s challenge or a broken id never log in', async () => {
    const w = await world();
    const a = await w.add();
    const b = await w.add();
    const ch = await w.challenge(a.kid);
    assert.strictEqual((await w.strategy.verify(w.login(a.kid, ch, b.kp), w.ctx())).ok, false, 'signed by another key');
    assert.strictEqual((await w.strategy.verify(w.login(a.kid, ch, a.kp, 'register'), w.ctx())).ok, false, 'register purpose');
    assert.strictEqual((await w.strategy.verify(w.login(b.kid, ch, b.kp), w.ctx())).ok, false, "a's challenge with b's key");
    assert.strictEqual((await w.strategy.verify({ ...w.login(a.kid, ch, a.kp), challengeId: ch.nonce }, w.ctx())).ok, false, 'nonce alone');
    assert.ok((await w.strategy.verify(w.login(a.kid, ch, a.kp), w.ctx())).ok, 'the challenge is still live');
  });

  it('expired challenges and revoked or expired keys fail', async () => {
    const w = await world();
    w.clock.install();
    try {
      const a = await w.add();
      const ch = await w.challenge(a.kid);
      w.clock.tick(119_999);
      const early = await w.challenge(a.kid);
      assert.ok((await w.strategy.verify(w.login(a.kid, early, a.kp), w.ctx())).ok, 'a fresh challenge');
      w.clock.tick(1);
      assert.strictEqual((await w.strategy.verify(w.login(a.kid, ch, a.kp), w.ctx())).ok, false, 'expired challenge');
    } finally {
      w.clock.uninstall();
    }
    const a = await w.add();
    const fresh = await w.challenge(a.kid);
    await w.p.registry.revoke(ALICE, a.kid, w.ctx());
    assert.deepStrictEqual(await w.strategy.verify(w.login(a.kid, fresh, a.kp), w.ctx()), { ok: false, reason: 'revoked' });
    assert.deepStrictEqual(await w.strategy.verify({ kind: 'key-challenge', keyId: a.kid, challengeId: 7, signature: 'x' } as never, w.ctx()), { ok: false, reason: 'invalid_credentials' });
    assert.deepStrictEqual(await w.strategy.verify({ kind: 'key-challenge', keyId: 7 } as never, w.ctx()), { ok: false, reason: 'invalid_credentials' });
  });

  it('binds the signature to this service: a login challenge relayed from another service fails', async () => {
    const w = await world();
    const { kp, kid } = await w.add();
    const ch = await w.challenge(kid);
    const relayed: Credentials = { kind: 'key-challenge', keyId: kid, challengeId: ch.id, signature: signChallenge(ch, 'login', 'https://evil.example', kp.privateKey, kp.alg) };
    assert.strictEqual((await w.strategy.verify(relayed, w.ctx())).ok, false);
    assert.ok((await w.strategy.verify(w.login(kid, ch, kp), w.ctx())).ok, 'the challenge survived');
  });

  it('cannot be built without an audience, and does the signature work for unknown keys only', async () => {
    const w = await world();
    assert.throws(() => new KeyChallengeStrategy(w.p.registry, w.p.secrets, keysOptions()), /audience/);
    let work = 0;
    class Counting extends KeyChallengeStrategy {
      protected unknownKeyWork(alg: KeyAlgorithm, data: Uint8Array, signature: Uint8Array): void {
        work += 1;
        super.unknownKeyWork(alg, data, signature);
      }
    }
    const s = new Counting(w.p.registry, w.p.secrets, w.p.options);
    const { kp, kid } = await w.add();
    await s.verify(w.login(kid, await w.challenge(kid), generateKeyPair('EdDSA')), w.ctx());
    assert.strictEqual(work, 0);
    await s.verify(w.login('kit-unknown', await w.challenge('kit-unknown'), kp), w.ctx());
    assert.strictEqual(work, 1);
  });

  it('refuses credentials over 8 KiB', async () => {
    const w = await world();
    const { kp, kid } = await w.add();
    const c = w.login(kid, await w.challenge(kid), kp);
    assert.deepStrictEqual(await w.strategy.verify({ ...c, signature: `${(c as { signature: string }).signature}${'A'.repeat(9000)}` }, w.ctx()), { ok: false, reason: 'invalid_credentials' });
  });

  it('is interactive and throttles by kid', async () => {
    const w = await world();
    assert.strictEqual(w.strategy.interactive, true);
    assert.deepStrictEqual(
      w.strategy.throttleKeys({ kind: 'key-challenge', keyId: 'k1', challengeId: 'x', signature: 'y' }, w.ctx({ ip: '192.0.2.4' })).map((k) => k.value),
      ['key:k1', 'key:k1|192.0.2.4'],
    );
  });
});

runStrategyConformance(
  async ({ clock }) => {
    const w = await world(clock);
    const { kp, kid } = await w.add();
    const other = generateKeyPair('EdDSA');
    w.p.events.clear();
    return {
      strategy: w.strategy,
      valid: async () => w.login(kid, await w.challenge(kid), kp),
      invalid: async () => w.login(kid, await w.challenge(kid), other),
      unknown: async () => w.login(other.kid, await w.challenge(other.kid), other),
      secretsOf: (c) => [String((c as { signature?: unknown }).signature), String((c as { challengeId?: unknown }).challengeId)],
      sessions: { count: async () => (await w.p.sessions.storage.storedKeys()).length },
      events: w.p.events,
    };
  },
  { title: 'authn-keys: KeyChallengeStrategy conformance' },
);
