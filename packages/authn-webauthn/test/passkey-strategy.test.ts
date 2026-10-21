import 'mocha';
import assert from 'node:assert/strict';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthnContext, Credentials, StrategyOutcome } from '@spinajs/authn/contracts';
import { FakeClock } from '@spinajs/authn-testing';
import type { SoftAuthenticator } from '@spinajs/authn-testing';

import { MemoryWebAuthnChallengeStore } from '../src/challenge.js';
import type { WebAuthnChallenge } from '../src/challenge.js';
import { MemoryWebAuthnCredentialStore } from '../src/store/index.js';
import { PasskeyStrategy } from '../src/strategy/index.js';
import { ALICE, BOB, FIXED_CHALLENGE, ORIGIN, RP_ID, START, authenticator, webauthnOptions } from './support/fixtures.js';

type Success = Extract<StrategyOutcome, { ok: true }>;

describe('PasskeyStrategy', function () {
  this.timeout(30000);
  let clock: FakeClock;
  let credentials: MemoryWebAuthnCredentialStore;
  let challenges: MemoryWebAuthnChallengeStore;
  let verifierCalls: number;
  let strategy: PasskeyStrategy;
  let alice: SoftAuthenticator;
  let serial: number;

  const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => clock.ctx(over);

  /** A stored discoverable credential of `owner`, as a registration would have left it. */
  async function seed(key: SoftAuthenticator, owner = ALICE): Promise<void> {
    key.bindUser(Buffer.from(owner.id).toString('base64url'));
    await credentials.add({ credentialId: key.credentialId, identity: owner, publicKey: key.cosePublicKey(), counter: 0, transports: ['internal'], createdAt: START });
  }

  /** A login challenge over the fixed challenge bytes, so the signed assertion is the same on every run. */
  async function loginChallenge(over: Partial<WebAuthnChallenge> = {}): Promise<WebAuthnChallenge> {
    const c: WebAuthnChallenge = { id: `Y2hhbGxlbmdlLQ${serial++}`, challenge: FIXED_CHALLENGE, purpose: 'login', expiresAt: new Date(START.getTime() + 300_000), ...over };
    await challenges.put(c);
    return c;
  }

  async function login(key: SoftAuthenticator, over: { uv?: boolean; origin?: string; challenge?: Partial<WebAuthnChallenge> } = {}): Promise<Credentials> {
    const c = await loginChallenge(over.challenge);
    return { kind: 'webauthn', challengeId: c.id, response: key.get({ challenge: c.challenge, rpId: RP_ID }, over.origin ?? ORIGIN, { uv: over.uv }) };
  }

  beforeEach(() => {
    clock = new FakeClock(START);
    clock.install();
    credentials = new MemoryWebAuthnCredentialStore();
    challenges = new MemoryWebAuthnChallengeStore();
    verifierCalls = 0;
    serial = 0;
    strategy = new PasskeyStrategy({
      credentials,
      challenges,
      options: webauthnOptions(),
      verifier: async (o) => {
        verifierCalls++;
        return verifyAuthenticationResponse(o);
      },
    });
    alice = authenticator('alice');
  });

  afterEach(() => {
    clock.uninstall();
  });

  it('is the interactive passkey strategy for webauthn credentials', () => {
    assert.strictEqual(strategy.name, 'passkey');
    assert.deepStrictEqual([...strategy.kinds], ['webauthn']);
    assert.strictEqual(strategy.interactive, true);
  });

  it('a fixture assertion with user verification yields the credential’s identity, method webauthn, assurance aal2', async () => {
    await seed(alice);
    const out = await strategy.verify(await login(alice, { uv: true }), ctx());
    assert.ok(out.ok, JSON.stringify(out));
    const ok = out as Success;
    assert.deepStrictEqual(ok.identity, ALICE);
    assert.strictEqual(ok.method, 'webauthn');
    assert.strictEqual(ok.assurance, 'aal2');
  });

  it('a fixture assertion without user verification yields aal1', async () => {
    await seed(alice);
    const out = await strategy.verify(await login(alice, { uv: false }), ctx());
    assert.ok(out.ok, JSON.stringify(out));
    assert.strictEqual((out as Success).assurance, 'aal1');
    assert.strictEqual((out as Success).method, 'webauthn');
  });

  it('the identity comes from the stored credential, not from the assertion', async () => {
    const bob = authenticator('bob');
    await seed(bob, BOB);
    bob.bindUser(Buffer.from(ALICE.id).toString('base64url'));
    const out = await strategy.verify(await login(bob), ctx());
    assert.deepStrictEqual(out, { ok: false, reason: 'invalid_credentials' }, 'a user handle that is not the owner’s');
  });

  it('the signed bytes are deterministic for a fixed challenge', () => {
    const a = authenticator('alice').get({ challenge: FIXED_CHALLENGE, rpId: RP_ID }, ORIGIN);
    const b = authenticator('alice').get({ challenge: FIXED_CHALLENGE, rpId: RP_ID }, ORIGIN);
    assert.deepStrictEqual(a, b);
  });

  it('an unknown credential id fails invalid_credentials through the same verification as a known one', async () => {
    await seed(alice);
    const stranger = authenticator('stranger');
    stranger.bindUser(Buffer.from(ALICE.id).toString('base64url'));
    const unknown = await login(stranger);
    assert.deepStrictEqual(await strategy.verify(unknown, ctx()), { ok: false, reason: 'invalid_credentials' });
    assert.strictEqual(verifierCalls, 1, 'the unknown credential ran the signature check');
    const known = await login(alice);
    assert.ok((await strategy.verify(known, ctx())).ok);
    assert.strictEqual(verifierCalls, 2, 'the known credential ran it once as well');
    const reused: Credentials = { ...unknown, kind: 'webauthn', response: alice.get({ challenge: FIXED_CHALLENGE, rpId: RP_ID }, ORIGIN) };
    assert.deepStrictEqual(await strategy.verify(reused, ctx()), { ok: false, reason: 'invalid_credentials' }, 'the unknown attempt used its challenge up');
  });

  it('an expired challenge fails', async () => {
    await seed(alice);
    const c = await login(alice);
    const out = await strategy.verify(c, ctx({ now: new Date(START.getTime() + 301_000) }));
    assert.strictEqual(out.ok, false);
    assert.strictEqual(verifierCalls, 0);
  });

  it('a challenge is single use and a replayed assertion fails', async () => {
    await seed(alice);
    const c = await login(alice);
    assert.ok((await strategy.verify(c, ctx())).ok);
    assert.deepStrictEqual(await strategy.verify(c, ctx()), { ok: false, reason: 'invalid_credentials' });
  });

  it('an authenticator behind on its counter fails', async () => {
    await seed(alice);
    assert.ok((await strategy.verify(await login(alice), ctx())).ok);
    const clone = authenticator('alice');
    clone.bindUser(Buffer.from(ALICE.id).toString('base64url'));
    assert.deepStrictEqual(await strategy.verify(await login(clone), ctx()), { ok: false, reason: 'invalid_credentials' });
  });

  it('an assertion from an origin not in origins fails', async () => {
    await seed(alice);
    assert.deepStrictEqual(await strategy.verify(await login(alice, { origin: 'https://evil.example.net' }), ctx()), { ok: false, reason: 'invalid_credentials' });
  });

  it('a registration or MFA challenge does not log in', async () => {
    await seed(alice);
    for (const purpose of ['register', 'mfa'] as const) {
      assert.deepStrictEqual(await strategy.verify(await login(alice, { challenge: { purpose, identity: ALICE } }), ctx()), { ok: false, reason: 'invalid_credentials' }, purpose);
    }
  });

  it('malformed credentials fail without a throw', async () => {
    for (const c of [{ kind: 'webauthn' }, { kind: 'webauthn', challengeId: 1, response: {} }, { kind: 'webauthn', challengeId: 'x', response: 'nope' }, { kind: 'webauthn', challengeId: 'x', response: { id: 5 } }] as Credentials[]) {
      assert.deepStrictEqual(await strategy.verify(c, ctx()), { ok: false, reason: 'invalid_credentials' }, JSON.stringify(c));
    }
  });

  it('counts an attempt against the credential id', async () => {
    const c = await login(alice);
    assert.deepStrictEqual(strategy.throttleKeys(c, ctx()), [{ kind: 'account', value: `webauthn:${alice.credentialId}` }]);
    assert.deepStrictEqual(strategy.throttleKeys({ kind: 'webauthn' }, ctx()), []);
  });
});
