import assert from 'node:assert/strict';
import type { IdentityRef, PasswordService } from '@spinajs/authn/contracts';
import type { ConfigOverrides } from '../harness/config.js';
import type { Harness } from '../harness/ports.js';
import { ALICE, BOB, auth, expectFailure, expectSuccess, hasEvent, pw, seedUser } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule, CaseKit } from './types.js';

type WithVerify = Harness & Required<Pick<Harness, 'password' | 'seed' | 'outbox'>>;

const REQUIRE_VERIFIED: ConfigOverrides = { authn: { login: { requireVerifiedAddress: true } } };

function verifying(p: PasswordService): Required<Pick<PasswordService, 'requestVerification' | 'redeemVerification'>> {
  assert.strictEqual(typeof p.requestVerification, 'function', 'the PasswordService offers requestVerification');
  assert.strictEqual(typeof p.redeemVerification, 'function', 'the PasswordService offers redeemVerification');
  return p as Required<PasswordService>;
}

/** requestVerification for `a`, then the secret its verify mail holds. */
async function requestAndTake(h: WithVerify, k: CaseKit, a: IdentityRef): Promise<string> {
  assert.deepStrictEqual({ ...(await verifying(h.password).requestVerification(a, k.ctx({ purpose: 'request' }))) }, { status: 'accepted' });
  const secret = await h.outbox.secretFor(a, 'verify');
  assert.ok(secret, 'the verify mail holds a secret');
  return secret;
}

const redeem = (h: WithVerify, k: CaseKit, secret: string) => verifying(h.password).redeemVerification(secret, k.ctx({ purpose: 'request' }));

export const A32: AuthnRule = defineRule('A32', 'an address is verified by a single-use secret mailed to it, and a login can require it', [
  defineCase({
    name: 'A32 requireVerifiedAddress refuses a login only while the store reports the address unverified',
    facet: 'A32/core',
    needs: ['service', 'seed'],
    config: REQUIRE_VERIFIED,
    async run(h, k) {
      const a = await seedUser(h, ALICE, { addressVerified: false });
      await seedUser(h, BOB);
      expectFailure(await auth(h, k, pw(ALICE.login, ALICE.password)), 'unverified_address');
      expectSuccess(await auth(h, k, pw(BOB.login, BOB.password)), 'an address the store does not track is not refused');
      await h.seed.setStatus(a, { addressVerified: true });
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)));
    },
  }),
  defineCase({
    name: 'A32 requireVerifiedAddress never tells a wrong password that the address is unverified',
    facet: 'A32/core',
    needs: ['service', 'seed'],
    config: REQUIRE_VERIFIED,
    async run(h, k) {
      await seedUser(h, ALICE, { addressVerified: false });
      expectFailure(await auth(h, k, pw(ALICE.login, 'Wrong-Pass-9876')), 'invalid_credentials');
    },
  }),
  defineCase({
    name: 'A32 without requireVerifiedAddress an unverified address logs in',
    facet: 'A32/core',
    needs: ['service', 'seed'],
    async run(h, k) {
      await seedUser(h, ALICE, { addressVerified: false });
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)));
    },
  }),
  defineCase({
    name: 'A32 request, mail, redeem: a login that requireVerifiedAddress refused gets in after the redeem',
    facet: 'A32/local',
    needs: ['password', 'seed', 'outbox', 'service', 'events'],
    config: REQUIRE_VERIFIED,
    async run(h, k) {
      const a = await seedUser(h, ALICE, { addressVerified: false });
      expectFailure(await auth(h, k, pw(ALICE.login, ALICE.password)), 'unverified_address', 'before the redeem');
      const secret = await requestAndTake(h, k, a);
      assert.deepStrictEqual({ ...(await redeem(h, k, secret)) }, { status: 'verified' });
      assert.ok(hasEvent(h.events, 'address.verify', 'success'), 'the redeem is audited as address.verify');
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)), 'after the redeem');
    },
  }),
  defineCase({
    name: 'A32 a verify secret redeems once, and only as issued',
    facet: 'A32/local',
    needs: ['password', 'seed', 'outbox'],
    async run(h, k) {
      const a = await seedUser(h, ALICE, { addressVerified: false });
      const b = await seedUser(h, BOB, { addressVerified: false });
      const secret = await requestAndTake(h, k, a);
      assert.deepStrictEqual({ ...(await redeem(h, k, secret)) }, { status: 'verified' });
      assert.deepStrictEqual({ ...(await redeem(h, k, secret)) }, { status: 'invalid' }, 'a second redeem');
      const other = await requestAndTake(h, k, b);
      assert.notStrictEqual(other, secret);
      assert.deepStrictEqual({ ...(await redeem(h, k, `${other}x`)) }, { status: 'invalid' }, 'a changed secret');
    },
  }),
  defineCase({
    name: 'A32 a verify secret expires after authn.local.verify.ttlSeconds',
    facet: 'A32/local',
    needs: ['password', 'seed', 'outbox', 'fakeDate'],
    config: { authn: { local: { verify: { ttlSeconds: 60 } } } },
    async run(h, k) {
      const a = await seedUser(h, ALICE, { addressVerified: false });
      const secret = await requestAndTake(h, k, a);
      k.clock.tick(61_000);
      assert.deepStrictEqual({ ...(await redeem(h, k, secret)) }, { status: 'invalid' });
    },
  }),
  defineCase({
    name: 'A32 an address already verified gets no mail and the same answer',
    facet: 'A32/local',
    needs: ['password', 'seed', 'outbox'],
    async run(h, k) {
      const a = await seedUser(h, ALICE, { addressVerified: true });
      assert.deepStrictEqual({ ...(await verifying(h.password).requestVerification(a, k.ctx({ purpose: 'request' }))) }, { status: 'accepted' });
      assert.strictEqual(await h.outbox.secretFor(a, 'verify'), null);
    },
  }),
]);
