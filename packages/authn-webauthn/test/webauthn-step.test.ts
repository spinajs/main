import 'mocha';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FakeClock } from '@spinajs/authn-testing';

import { MemoryWebAuthnChallengeStore } from '../src/challenge.js';
import { MemoryWebAuthnCredentialStore } from '../src/store/index.js';
import { MemoryWebAuthnRecoveryCodeStore, WebAuthnInvalidResponse, WebAuthnMfaStep } from '../src/step/index.js';
import { ALICE, BOB, EVIL_ORIGIN, ORIGIN, RP_ID, START, authenticator, ceremonyOf, webauthnOptions } from './support/fixtures.js';
import type { SoftAuthenticator } from '@spinajs/authn-testing';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe('WebAuthnMfaStep', function () {
  this.timeout(30000);
  let clock: FakeClock;
  let credentials: MemoryWebAuthnCredentialStore;
  let recoveryCodes: MemoryWebAuthnRecoveryCodeStore;
  let step: WebAuthnMfaStep;
  let key: SoftAuthenticator;

  beforeEach(() => {
    clock = new FakeClock(START);
    clock.install();
    credentials = new MemoryWebAuthnCredentialStore();
    recoveryCodes = new MemoryWebAuthnRecoveryCodeStore();
    step = new WebAuthnMfaStep({ credentials, challenges: new MemoryWebAuthnChallengeStore(), recoveryCodes, options: webauthnOptions(), identities: null });
    key = authenticator('alice');
  });

  afterEach(() => {
    clock.uninstall();
  });

  /** Begins an enrolment and answers it with the authenticator, as from `origin`. */
  async function attest(origin = ORIGIN): Promise<string> {
    const { challengeId, options } = ceremonyOf((await step.beginEnrolment(ALICE)).provisioning);
    return JSON.stringify({ challengeId, response: key.create(options, origin) });
  }

  async function enrol(): Promise<readonly string[]> {
    const { recoveryCodes: codes } = await step.confirmEnrolment(ALICE, await attest());
    return codes ?? [];
  }

  async function assertion(origin = ORIGIN): Promise<string> {
    const { challengeId, options } = await step.challenge(ALICE);
    return JSON.stringify({ challengeId, response: key.get(options as { challenge: string; rpId?: string }, origin) });
  }

  it('is the webauthn step and keeps no secret', () => {
    assert.strictEqual(step.name, 'webauthn');
    assert.strictEqual(step.storesSecrets, false);
  });

  it('beginEnrolment returns JSON registration options with rp.id from config', async () => {
    const { challengeId, options } = ceremonyOf((await step.beginEnrolment(ALICE)).provisioning);
    assert.ok(challengeId.length > 0);
    assert.strictEqual(options.rp.id, RP_ID);
    assert.strictEqual(options.rp.name, 'Kit App');
    assert.strictEqual(Buffer.from(options.user.id, 'base64url').toString('utf8'), ALICE.id);
    assert.strictEqual(options.attestation, 'none');
    assert.ok(Buffer.from(options.challenge, 'base64url').length >= 16, 'a challenge of 128 bits or more');
  });

  it('the registration challenge is single use', async () => {
    const response = await attest();
    await step.confirmEnrolment(ALICE, response);
    await assert.rejects(step.confirmEnrolment(ALICE, response), WebAuthnInvalidResponse);
    assert.strictEqual((await credentials.listFor(ALICE)).length, 1);
  });

  it('confirmEnrolment with the fixture attestation stores the credential and returns recovery codes', async () => {
    const codes = await enrol();
    const stored = await credentials.listFor(ALICE);
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].credentialId, key.credentialId);
    assert.deepStrictEqual(stored[0].identity, ALICE);
    assert.deepStrictEqual([...stored[0].publicKey], [...key.cosePublicKey()]);
    assert.strictEqual(codes.length, 10);
    assert.strictEqual(new Set(codes).size, 10);
    assert.strictEqual(await step.enrolled(ALICE), true);
    assert.strictEqual(await step.enrolled(BOB), false);
  });

  it('recovery codes are stored as SHA-256 only', async () => {
    const codes = await enrol();
    const hashes = recoveryCodes.hashes(ALICE);
    assert.strictEqual(hashes.length, codes.length);
    for (const code of codes) {
      assert.ok(!hashes.some((h) => h.includes(code) || h.includes(code.replace(/-/g, ''))));
      assert.ok(hashes.includes(sha256(code.replace(/-/g, ''))));
    }
  });

  it('confirmEnrolment refuses another identity’s challenge', async () => {
    const response = await attest();
    await assert.rejects(step.confirmEnrolment(BOB, response), WebAuthnInvalidResponse);
    assert.deepStrictEqual(await credentials.listFor(BOB), []);
  });

  it('confirmEnrolment refuses an attestation from an origin not in origins', async () => {
    await assert.rejects(step.confirmEnrolment(ALICE, await attest(EVIL_ORIGIN)), WebAuthnInvalidResponse);
    assert.strictEqual(await step.enrolled(ALICE), false);
  });

  it('confirmEnrolment refuses a malformed response', async () => {
    for (const bad of ['', 'not json', '{}', JSON.stringify({ challengeId: 'x', response: {} })]) {
      await assert.rejects(step.confirmEnrolment(ALICE, bad), WebAuthnInvalidResponse, JSON.stringify(bad));
    }
  });

  it('verify with the fixture assertion is true once', async () => {
    await enrol();
    const response = await assertion();
    assert.strictEqual(await step.verify(ALICE, response), true);
    assert.strictEqual(await step.verify(ALICE, response), false, 'the same assertion a second time');
  });

  it('replaying an assertion whose counter did not increase is false', async () => {
    await enrol();
    const first = await assertion();
    assert.strictEqual(await step.verify(ALICE, first), true);
    const stale = authenticator('alice');
    stale.bindUser(Buffer.from(ALICE.id).toString('base64url'));
    const { challengeId, options } = await step.challenge(ALICE);
    assert.strictEqual(await step.verify(ALICE, JSON.stringify({ challengeId, response: stale.get(options as { challenge: string }, ORIGIN) })), false, 'a cloned authenticator behind on its counter');
  });

  it('verify is false for an assertion from an origin not in origins', async () => {
    await enrol();
    assert.strictEqual(await step.verify(ALICE, await assertion(EVIL_ORIGIN)), false);
  });

  it('verify is false for an expired challenge', async () => {
    await enrol();
    const response = await assertion();
    clock.tick(301_000);
    assert.strictEqual(await step.verify(ALICE, response), false);
  });

  it('verify is false for another identity, a malformed response and a recovery code', async () => {
    const codes = await enrol();
    assert.strictEqual(await step.verify(BOB, await assertion()), false);
    for (const bad of ['', 'nope', '{}', codes[0]]) assert.strictEqual(await step.verify(ALICE, bad), false, JSON.stringify(bad));
  });

  it('the MFA challenge lists only the identity’s credentials', async () => {
    await enrol();
    const { options } = await step.challenge(ALICE);
    assert.strictEqual(options.rpId, RP_ID);
    assert.deepStrictEqual(
      (options.allowCredentials as { id: string }[]).map((c) => c.id),
      [key.credentialId],
    );
  });

  it('recovery codes are single use and voided on regeneration', async () => {
    const [c1, c2] = await enrol();
    assert.strictEqual(await step.verifyRecovery(ALICE, c1), true);
    assert.strictEqual(await step.verifyRecovery(ALICE, c1), false);
    const fresh = await step.regenerateRecoveryCodes(ALICE);
    assert.strictEqual(await step.verifyRecovery(ALICE, c2), false);
    assert.strictEqual(await step.verifyRecovery(ALICE, fresh[0]), true);
  });

  it('disable removes every credential and the recovery codes', async () => {
    const [code] = await enrol();
    await step.disable(ALICE);
    assert.strictEqual(await step.enrolled(ALICE), false);
    assert.deepStrictEqual(await credentials.listFor(ALICE), []);
    assert.strictEqual(await step.verifyRecovery(ALICE, code), false);
  });
});
