import 'mocha';
import assert from 'node:assert/strict';
import type { AuthnContext } from '@spinajs/authn/contracts';
import { FakeClock, RecordingEventSink } from '@spinajs/authn-testing';
import type { SoftAuthenticator } from '@spinajs/authn-testing';

import { MemoryWebAuthnChallengeStore } from '../src/challenge.js';
import { MemoryWebAuthnCredentialStore } from '../src/store/index.js';
import { WebAuthnPasskeyService } from '../src/service/index.js';
import { PasskeyStrategy } from '../src/strategy/index.js';
import { ALICE, BOB, EVIL_ORIGIN, ORIGIN, RP_ID, START, authenticator, webauthnOptions } from './support/fixtures.js';

describe('WebAuthnPasskeyService', function () {
  this.timeout(30000);
  let clock: FakeClock;
  let credentials: MemoryWebAuthnCredentialStore;
  let challenges: MemoryWebAuthnChallengeStore;
  let events: RecordingEventSink;
  let service: WebAuthnPasskeyService;
  let key: SoftAuthenticator;

  const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => clock.ctx({ purpose: 'request', ...over });

  async function register(origin = ORIGIN, name?: string) {
    const { challengeId, options } = await service.registrationOptions(ALICE, ctx());
    return service.register(ALICE, { challengeId, response: key.create(options as never, origin), ...(name !== undefined ? { name } : {}) }, ctx());
  }

  beforeEach(() => {
    clock = new FakeClock(START);
    clock.install();
    credentials = new MemoryWebAuthnCredentialStore();
    challenges = new MemoryWebAuthnChallengeStore();
    events = new RecordingEventSink();
    service = new WebAuthnPasskeyService({ credentials, challenges, options: webauthnOptions(), identities: null, sinks: [events] });
    key = authenticator('alice');
  });

  afterEach(() => {
    clock.uninstall();
  });

  it('registration options ask for a discoverable credential of the identity on the configured relying party', async () => {
    const { challengeId, options } = await service.registrationOptions(ALICE, ctx());
    const o = options as { rp: { id: string }; user: { id: string }; authenticatorSelection: { residentKey: string; userVerification: string }; challenge: string };
    assert.ok(challengeId.length > 0);
    assert.strictEqual(o.rp.id, RP_ID);
    assert.strictEqual(Buffer.from(o.user.id, 'base64url').toString('utf8'), ALICE.id);
    assert.strictEqual(o.authenticatorSelection.residentKey, 'required');
    assert.strictEqual(o.authenticatorSelection.userVerification, 'preferred');
  });

  it('register stores the passkey and lists it, never the public key', async () => {
    const r = await register(ORIGIN, 'Laptop');
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.passkey.id, key.credentialId);
    assert.strictEqual(r.passkey.name, 'Laptop');
    const listed = await service.list(ALICE);
    assert.deepStrictEqual(
      listed.map((p) => p.id),
      [key.credentialId],
    );
    assert.ok(!('publicKey' in listed[0]));
    assert.deepStrictEqual(await service.list(BOB), []);
    assert.ok(events.all().some((e) => e.type === 'passkey.register' && e.outcome === 'success' && e.identity?.id === ALICE.id));
  });

  it('a registered passkey logs in through PasskeyStrategy', async () => {
    assert.ok((await register()).ok);
    const strategy = new PasskeyStrategy({ credentials, challenges, options: webauthnOptions() });
    const { challengeId, options } = await service.challenge(ctx({ purpose: 'login' }));
    const out = await strategy.verify({ kind: 'webauthn', challengeId, response: key.get(options as never, ORIGIN) }, ctx({ purpose: 'login' }));
    assert.ok(out.ok, JSON.stringify(out));
    assert.deepStrictEqual(out.ok && out.identity, ALICE);
  });

  it('a login challenge allows any discoverable credential', async () => {
    const { options } = await service.challenge(ctx({ purpose: 'login' }));
    const o = options as { rpId: string; allowCredentials?: unknown[]; userVerification: string };
    assert.strictEqual(o.rpId, RP_ID);
    assert.deepStrictEqual(o.allowCredentials ?? [], []);
  });

  it('an MFA challenge allows only the identity’s credentials', async () => {
    assert.ok((await register()).ok);
    const { options } = await service.challenge(ctx(), ALICE);
    assert.deepStrictEqual(
      (options as { allowCredentials: { id: string }[] }).allowCredentials.map((c) => c.id),
      [key.credentialId],
    );
  });

  it('register refuses a used challenge, another identity’s challenge and a foreign origin', async () => {
    const { challengeId, options } = await service.registrationOptions(ALICE, ctx());
    const response = key.create(options as never, ORIGIN);
    assert.deepStrictEqual(await service.register(BOB, { challengeId, response }, ctx()), { ok: false, code: 'invalid_response' });
    assert.deepStrictEqual(await service.register(ALICE, { challengeId, response }, ctx()), { ok: false, code: 'invalid_response' }, 'the refused attempt used the challenge up');
    assert.deepStrictEqual(await register(EVIL_ORIGIN), { ok: false, code: 'invalid_response' });
    assert.deepStrictEqual(await service.list(ALICE), []);
    assert.ok(events.all().some((e) => e.type === 'passkey.register' && e.outcome === 'failure'));
  });

  it('register refuses an expired challenge', async () => {
    const { challengeId, options } = await service.registrationOptions(ALICE, ctx());
    const response = key.create(options as never, ORIGIN);
    clock.tick(301_000);
    assert.deepStrictEqual(await service.register(ALICE, { challengeId, response }, ctx()), { ok: false, code: 'invalid_response' });
  });

  it('register refuses a credential that is registered already', async () => {
    assert.ok((await register()).ok);
    assert.deepStrictEqual(await register(), { ok: false, code: 'duplicate' });
    assert.strictEqual((await service.list(ALICE)).length, 1);
  });

  it('register refuses malformed input', async () => {
    const { challengeId } = await service.registrationOptions(ALICE, ctx());
    for (const response of [null, 'x', {}, { id: 'a', response: {} }]) {
      assert.deepStrictEqual(await service.register(ALICE, { challengeId, response }, ctx()), { ok: false, code: 'invalid_response' }, JSON.stringify(response));
    }
  });

  it('remove deletes only the identity’s own passkey', async () => {
    assert.ok((await register()).ok);
    assert.strictEqual(await service.remove(BOB, key.credentialId, ctx()), false);
    assert.strictEqual((await service.list(ALICE)).length, 1);
    assert.strictEqual(await service.remove(ALICE, key.credentialId, ctx()), true);
    assert.deepStrictEqual(await service.list(ALICE), []);
    assert.strictEqual(await service.remove(ALICE, key.credentialId, ctx()), false);
    assert.ok(events.all().some((e) => e.type === 'passkey.remove' && e.outcome === 'success'));
  });

  it('no event carries the public key, the attestation or the challenge', async () => {
    const { challengeId, options } = await service.registrationOptions(ALICE, ctx());
    const response = key.create(options as never, ORIGIN);
    await service.register(ALICE, { challengeId, response }, ctx());
    const seen = JSON.stringify(events.all());
    for (const secret of [(options as { challenge: string }).challenge, challengeId, response.response.attestationObject, Buffer.from(key.cosePublicKey()).toString('base64url')]) {
      assert.ok(!seen.includes(secret));
    }
  });
});
