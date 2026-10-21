import assert from 'node:assert/strict';
import type { Credentials, IdentityRef, PasswordService } from '@spinajs/authn/contracts';
import type { Harness } from '../harness/ports.js';
import { ALICE, BOB, NOBODY, auth, expectFailure, expectMfaRequired, expectSuccess, pw, seedUser } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule, CaseKit } from './types.js';

type WithMail = Harness & Required<Pick<Harness, 'password' | 'seed' | 'outbox'>>;
type WithStep = Harness & Required<Pick<Harness, 'mfa' | 'seed'>>;

const SIX_DIGITS = /^\d{6}$/;
const SHORT_TTL = { authn: { local: { emailCode: { ttlSeconds: 60 } } } };

const emailCode = (login: string, code: string): Credentials => ({ kind: 'email-code', login, code });
const otherThan = (code: string) => (code === '000000' ? '111111' : '000000');

function coding(p: PasswordService): Required<Pick<PasswordService, 'requestCode'>> {
  assert.strictEqual(typeof p.requestCode, 'function', 'the PasswordService offers requestCode');
  return p as Required<PasswordService>;
}

/** The code in the newest code mail to `a`. */
async function mailedCode(h: WithMail, a: IdentityRef): Promise<string> {
  const code = await h.outbox.secretFor(a, 'code');
  assert.ok(code !== null && SIX_DIGITS.test(code), 'the code mail holds a 6-digit code');
  return code;
}

/** requestCode for `login`, then the code its mail holds. */
async function requestAndTake(h: WithMail, k: CaseKit, login: string, a: IdentityRef): Promise<string> {
  assert.deepStrictEqual({ ...(await coding(h.password).requestCode(login, k.ctx({ purpose: 'request' }))) }, { status: 'accepted' });
  return mailedCode(h, a);
}

async function enrolled(h: WithStep, a: IdentityRef): Promise<string> {
  await h.mfa.enrol(a);
  const code = await h.mfa.code(a);
  assert.match(code, SIX_DIGITS);
  return code;
}

export const A36: AuthnRule = defineRule('A36', 'an email code is a second factor and a way to log in: 6 digits, single use, five tries, mailed to a verified address', [
  defineCase({
    name: 'A36 a code is accepted once',
    facet: 'A36/step',
    needs: ['mfa', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE, { addressVerified: true });
      const code = await enrolled(h, a);
      assert.strictEqual(await h.mfa.step.verify(a, code), true);
      assert.strictEqual(await h.mfa.step.verify(a, code), false, 'the same code a second time');
    },
  }),
  defineCase({
    name: 'A36 five wrong codes void the code',
    facet: 'A36/step',
    needs: ['mfa', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE, { addressVerified: true });
      const code = await enrolled(h, a);
      for (let i = 0; i < 5; i++) {
        assert.strictEqual(await h.mfa.step.verify(a, otherThan(code)), false, `wrong code ${i + 1}`);
      }
      assert.strictEqual(await h.mfa.step.verify(a, code), false, 'the right code after five wrong ones');
    },
  }),
  defineCase({
    name: 'A36 a code expires after authn.local.emailCode.ttlSeconds',
    facet: 'A36/step',
    needs: ['mfa', 'seed', 'fakeDate'],
    config: SHORT_TTL,
    async run(h, k) {
      const a = await seedUser(h, ALICE, { addressVerified: true });
      const code = await enrolled(h, a);
      k.clock.tick(61_000);
      assert.strictEqual(await h.mfa.step.verify(a, code), false);
    },
  }),
  defineCase({
    name: 'A36 enrolment needs a verified address',
    facet: 'A36/step',
    needs: ['mfa', 'seed'],
    async run(h) {
      const unverified = await seedUser(h, ALICE, { addressVerified: false });
      const untracked = await seedUser(h, BOB);
      for (const id of [unverified, untracked]) {
        await assert.rejects(h.mfa.step.beginEnrolment(id), 'begin is refused');
        assert.strictEqual(await h.mfa.step.enrolled(id), false);
      }
    },
  }),
  defineCase({
    name: 'A36 password login, challenge, code: the second factor elevates the session to aal2',
    facet: 'A36/local',
    needs: ['service', 'seed', 'mfa', 'outbox'],
    async run(h, k) {
      const a = await seedUser(h, ALICE, { addressVerified: true });
      await h.mfa.enrol(a);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectMfaRequired(r);
      assert.deepStrictEqual([...r.steps], ['email-code']);

      assert.strictEqual(typeof h.mfa.step.challenge, 'function', 'the step offers challenge');
      await h.mfa.step.challenge!(a, k.ctx({ purpose: 'login', session: r.pending }));
      const code = await mailedCode(h as WithMail, a);

      const done = await h.service.completeMfa(r.pending, 'email-code', code, k.ctx({ purpose: 'login', session: r.pending }));
      expectSuccess(done);
      assert.strictEqual(done.facts.assurance, 'aal2');
      assert.deepStrictEqual([...done.facts.mfa], ['email-code']);
    },
  }),
  defineCase({
    name: 'A36 a wrong code does not complete the pending login, and the code works afterwards',
    facet: 'A36/local',
    needs: ['service', 'seed', 'mfa', 'outbox'],
    async run(h, k) {
      const a = await seedUser(h, ALICE, { addressVerified: true });
      await h.mfa.enrol(a);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectMfaRequired(r);
      await h.mfa.step.challenge!(a, k.ctx({ purpose: 'login', session: r.pending }));
      const code = await mailedCode(h as WithMail, a);
      const ctx = k.ctx({ purpose: 'login', session: r.pending });
      expectFailure(await h.service.completeMfa(r.pending, 'email-code', otherThan(code), ctx), 'invalid_credentials');
      expectSuccess(await h.service.completeMfa(r.pending, 'email-code', code, ctx));
    },
  }),
  defineCase({
    name: 'A36 code login: request, mail, log in once with method email-code at aal1',
    facet: 'A36/local',
    needs: ['service', 'password', 'seed', 'outbox'],
    async run(h, k) {
      const a = await seedUser(h, ALICE, { addressVerified: true });
      const code = await requestAndTake(h, k, ALICE.login, a);
      const res = await auth(h, k, emailCode(ALICE.login, code));
      expectSuccess(res);
      assert.strictEqual(res.facts.method, 'email-code');
      assert.strictEqual(res.facts.assurance, 'aal1');
      assert.deepStrictEqual(res.identity, a);
      expectFailure(await auth(h, k, emailCode(ALICE.login, code)), 'invalid_credentials', 'the same code a second time');
    },
  }),
  defineCase({
    name: 'A36 code login: a wrong code, another login and an unknown login all fail the same way',
    facet: 'A36/local',
    needs: ['service', 'password', 'seed', 'outbox'],
    async run(h, k) {
      const a = await seedUser(h, ALICE, { addressVerified: true });
      await seedUser(h, BOB, { addressVerified: true });
      const code = await requestAndTake(h, k, ALICE.login, a);
      expectFailure(await auth(h, k, emailCode(ALICE.login, otherThan(code))), 'invalid_credentials');
      expectFailure(await auth(h, k, emailCode(BOB.login, code)), 'invalid_credentials', "alice's code on bob");
      expectFailure(await auth(h, k, emailCode(NOBODY, code)), 'invalid_credentials');
    },
  }),
  defineCase({
    name: 'A36 code request: an unknown login answers accepted and mails nothing',
    facet: 'A36/local',
    needs: ['password', 'seed', 'outbox'],
    async run(h, k) {
      const a = await seedUser(h, ALICE, { addressVerified: true });
      assert.deepStrictEqual({ ...(await coding(h.password).requestCode(NOBODY, k.ctx({ purpose: 'request' }))) }, { status: 'accepted' });
      assert.strictEqual(await h.outbox.secretFor(a, 'code'), null);
    },
  }),
  defineCase({
    name: 'A36 code request: an address the store reports unverified gets no code',
    facet: 'A36/local',
    needs: ['password', 'seed', 'outbox'],
    async run(h, k) {
      const a = await seedUser(h, ALICE, { addressVerified: false });
      assert.deepStrictEqual({ ...(await coding(h.password).requestCode(ALICE.login, k.ctx({ purpose: 'request' }))) }, { status: 'accepted' });
      assert.strictEqual(await h.outbox.secretFor(a, 'code'), null);
    },
  }),
]);
