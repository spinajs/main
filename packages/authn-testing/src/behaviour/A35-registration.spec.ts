import assert from 'node:assert/strict';
import type { IdentityRef, PasswordService } from '@spinajs/authn/contracts';
import type { ConfigOverrides } from '../harness/config.js';
import type { Harness } from '../harness/ports.js';
import { ALICE, BOB, auth, expectFailure, expectSuccess, pw, seedUser } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule, CaseKit } from './types.js';

type WithRegistrar = Harness & Required<Pick<Harness, 'registrar'>>;

const REQUIRE_VERIFIED: ConfigOverrides = { authn: { login: { requireVerifiedAddress: true } } };

const NEWCOMER = Object.freeze({ login: 'newcomer', email: 'newcomer@example.test', password: 'Newcomer-Pass-6789' });

type Mailing = Required<Pick<PasswordService, 'requestVerification' | 'redeemVerification' | 'notifyAccountExists'>>;

function mailing(p: PasswordService): Mailing {
  for (const method of ['requestVerification', 'redeemVerification', 'notifyAccountExists'] as const) {
    assert.strictEqual(typeof p[method], 'function', `the PasswordService offers ${method}`);
  }
  return p as Mailing;
}

const register = (h: WithRegistrar, k: CaseKit, over: Partial<{ login: string; email: string; password: string }> = {}) => h.registrar.register({ ...NEWCOMER, ...over }, k.ctx({ purpose: 'request' }));

async function created(h: WithRegistrar, k: CaseKit): Promise<IdentityRef> {
  const res = await register(h, k);
  assert.strictEqual(res.status, 'created');
  return res.id;
}

export const A35: AuthnRule = defineRule('A35', 'a stranger registers an account, a taken address answers like a new one, and the owner of a taken address is mailed', [
  defineCase({
    name: 'A35 register, verify the mailed address, login',
    facet: 'A35/local',
    needs: ['registrar', 'password', 'outbox', 'service'],
    config: REQUIRE_VERIFIED,
    async run(h, k) {
      const id = await created(h, k);
      expectFailure(await auth(h, k, pw(NEWCOMER.email, NEWCOMER.password)), 'unverified_address', 'before the address is verified');

      assert.deepStrictEqual({ ...(await mailing(h.password).requestVerification(id, k.ctx({ purpose: 'request' }))) }, { status: 'accepted' });
      const secret = await h.outbox.secretFor(id, 'verify');
      assert.ok(secret, 'the verify mail holds a secret');
      assert.deepStrictEqual({ ...(await mailing(h.password).redeemVerification(secret, k.ctx({ purpose: 'request' }))) }, { status: 'verified' });

      expectSuccess(await auth(h, k, pw(NEWCOMER.email, NEWCOMER.password)), 'after the address is verified');
    },
  }),
  defineCase({
    name: 'A35 registering with a taken email or login answers exists and changes nothing',
    facet: 'A35/local',
    needs: ['registrar', 'service', 'seed'],
    async run(h, k) {
      const owner = await seedUser(h, ALICE);
      const byEmail = await register(h, k, { email: ALICE.login, password: 'Intruder-Pass-1234' });
      assert.deepStrictEqual({ ...byEmail }, { status: 'exists', id: owner });
      const byLogin = await register(h, k, { login: ALICE.login, password: 'Intruder-Pass-1234' });
      assert.deepStrictEqual({ ...byLogin }, { status: 'exists', id: owner });

      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)), 'the owner keeps their password');
      expectFailure(await auth(h, k, pw(ALICE.login, 'Intruder-Pass-1234')), 'invalid_credentials');
    },
  }),
  defineCase({
    name: 'A35 a second registration of the same address finds the first',
    facet: 'A35/local',
    needs: ['registrar'],
    async run(h, k) {
      const first = await created(h, k);
      assert.deepStrictEqual({ ...(await register(h, k, { login: 'another' })) }, { status: 'exists', id: first });
    },
  }),
  defineCase({
    name: 'A35 the account-exists mail goes to the owner once and holds no secret',
    facet: 'A35/local',
    needs: ['password', 'outbox', 'seed', 'secretStorage'],
    async run(h, k) {
      const owner = await seedUser(h, BOB);
      await mailing(h.password).notifyAccountExists(owner, k.ctx({ purpose: 'request' }));
      assert.strictEqual(await h.outbox.sent(owner, 'account-exists'), 1);
      assert.deepStrictEqual(await h.secretStorage.rows(), [], 'no secret is issued for it');
      assert.strictEqual(await h.outbox.secretFor(owner, 'reset'), null);
    },
  }),
  defineCase({
    name: 'A35 the password policy sees the login and the email of the registration',
    facet: 'A35/local',
    needs: ['password'],
    async run(h) {
      const context = { login: NEWCOMER.login, email: NEWCOMER.email };
      assert.deepStrictEqual([...(await h.password.check('Newcomer-Pass-6789', context))], ['similar_to_identifier']);
      assert.deepStrictEqual([...(await h.password.check('Tulip-Harbour-81', context))], []);
    },
  }),
]);
