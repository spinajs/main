import assert from 'node:assert/strict';
import type { AuthenticationResult, IdentityRef } from '@spinajs/authn/contracts';
import type { Harness } from '../harness/ports.js';
import { base32Decode, parseOtpauth, totpFromProvisioning } from '../helpers/index.js';
import { ALICE, auth, expectFail, expectMfaRequired, expectSuccess, expectThrottled, in4xx, pw, routes, seedUser, send, throttleParams } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit } from './types.js';

type Pending = Extract<AuthenticationResult, { status: 'mfa_required' }>;
type WithMfa = Harness & Required<Pick<Harness, 'service' | 'seed' | 'mfa'>>;
type WithStep = Harness & Required<Pick<Harness, 'mfa' | 'seed'>>;

const FRESH_300 = { authn: { freshAuth: { maxAgeSeconds: 300 } } };
const SECOND = 1000;

const is2xx = (status: number): boolean => status >= 200 && status < 300;

/** ALICE enrolled and logged in: a pending session. */
async function pendingLogin(h: WithMfa, k: CaseKit): Promise<{ a: IdentityRef; r: Pending }> {
  const a = await seedUser(h, ALICE);
  await h.mfa.enrol(a);
  const r = await auth(h, k, pw(ALICE.login, ALICE.password));
  expectMfaRequired(r);
  return { a, r };
}

/** Begins and confirms an enrolment with a code computed from the provisioning URI. */
async function enrolWithTotp(h: WithStep, k: CaseKit, a: IdentityRef) {
  const { provisioning } = await h.mfa.step.beginEnrolment(a);
  const confirmed = await h.mfa.step.confirmEnrolment(a, totpFromProvisioning(provisioning, k.clock.now()));
  return { provisioning, confirmed };
}

const FRESH_ROWS = [
  { label: 'fresh', staleSeconds: 0, accepted: true },
  { label: 'stale', staleSeconds: 301, accepted: false },
] as const;

const DISABLE_ROWS = [
  { label: 'fresh and a valid code', staleSeconds: 0, valid: true, disabled: true },
  { label: 'fresh and a wrong code', staleSeconds: 0, valid: false, disabled: false },
  { label: 'stale and a valid code', staleSeconds: 301, valid: true, disabled: false },
] as const;

export const A10: AuthnRule = defineRule('A10', 'MFA codes are throttled, single use and kept secret', [
  defineCase({
    name: 'A10 a code is accepted once',
    facet: 'A10/step',
    needs: ['mfa', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      await h.mfa.enrol(a);
      k.clock.tick(30 * SECOND);
      const c = await h.mfa.code(a);
      assert.strictEqual(await h.mfa.step.verify(a, c), true);
      assert.strictEqual(await h.mfa.step.verify(a, c), false, 'the same code a second time');
    },
  }),
  defineCase({
    name: 'A10 a wrong code fails',
    facet: 'A10/step',
    needs: ['mfa', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      await h.mfa.enrol(a);
      assert.strictEqual(await h.mfa.step.verify(a, 'kit-wrong'), false);
    },
  }),
  defineCase({
    name: 'A10 recovery codes are single use and voided on regeneration',
    facet: 'A10/step',
    needs: ['mfa', 'mfa.recovery', 'seed'],
    async run(h) {
      const step = h.mfa.step;
      const a = await seedUser(h, ALICE);
      await h.mfa.enrol(a);
      const [c1, c2] = await step.regenerateRecoveryCodes!(a);
      assert.strictEqual(await step.verifyRecovery!(a, c1), true);
      assert.strictEqual(await step.verifyRecovery!(a, c1), false, 'a recovery code a second time');
      const fresh = await step.regenerateRecoveryCodes!(a);
      assert.strictEqual(await step.verifyRecovery!(a, c2), false, 'an older code after regeneration');
      assert.strictEqual(await step.verifyRecovery!(a, fresh[0]), true);
    },
  }),
  defineCase({
    name: 'A10 verify takes step codes only, never a recovery code',
    facet: 'A10/step',
    needs: ['mfa', 'mfa.recovery', 'seed'],
    async run(h) {
      const step = h.mfa.step;
      const a = await seedUser(h, ALICE);
      await h.mfa.enrol(a);
      const [c1] = await step.regenerateRecoveryCodes!(a);
      assert.strictEqual(await step.verify(a, c1), false);
      assert.strictEqual(await step.verifyRecovery!(a, c1), true, 'the failed verify did not use the code up');
    },
  }),
  defineCase({
    name: 'A10 disable removes the enrolment',
    facet: 'A10/step',
    needs: ['mfa', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      await h.mfa.enrol(a);
      k.clock.tick(30 * SECOND);
      const c = await h.mfa.code(a);
      await h.mfa.step.disable(a);
      assert.strictEqual(await h.mfa.step.enrolled(a), false);
      assert.strictEqual(await h.mfa.step.verify(a, c), false);
    },
  }),
  defineCase({
    name: 'A10 enrolment confirms with a TOTP code and returns the recovery codes',
    facet: 'A10/totp',
    needs: ['mfa', 'seed', 'fakeDate'],
    config: { authn: { mfa: { totp: { recoveryCodes: 10 } } } },
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const { confirmed } = await enrolWithTotp(h, k, a);
      assert.strictEqual(confirmed.recoveryCodes?.length, 10);
      assert.strictEqual(await h.mfa.step.enrolled(a), true);
    },
  }),
  defineCase({
    name: 'A10 SR-15 a code from an older time step is refused after a newer one',
    facet: 'A10/totp',
    needs: ['mfa', 'seed', 'fakeDate'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const { provisioning } = await enrolWithTotp(h, k, a);
      k.clock.tick(60 * SECOND);
      const now = k.clock.now();
      const cNew = totpFromProvisioning(provisioning, now);
      const cOld = totpFromProvisioning(provisioning, new Date(now.getTime() - 30 * SECOND));
      assert.strictEqual(await h.mfa.step.verify(a, cNew), true);
      assert.strictEqual(await h.mfa.step.verify(a, cOld), false, 'a code of an earlier time step');
    },
  }),
  defineCase({
    name: 'A10 SR-09 TOTP secret encrypted at rest',
    facet: 'A10/totp',
    needs: ['mfa', 'mfaStorage', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      const { provisioning } = await h.mfa.step.beginEnrolment(a);
      const { secret } = parseOtpauth(provisioning);
      const stored = await h.mfaStorage.storedSecret(a);
      assert.ok(stored, 'the lane stores the secret');
      const raw = base32Decode(secret);
      assert.ok(!stored.toUpperCase().includes(secret.toUpperCase()), 'no base32 secret in storage');
      assert.ok(!stored.includes(raw.toString('hex')), 'no hex secret in storage');
      assert.ok(!stored.includes(raw.toString('base64')), 'no base64 secret in storage');
    },
  }),
  defineCase({
    name: 'A10 recovery codes are stored hashed',
    facet: 'A10/totp',
    needs: ['mfa', 'mfaStorage', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const { confirmed } = await enrolWithTotp(h, k, a);
      const codes = confirmed.recoveryCodes ?? [];
      assert.ok(codes.length > 0, 'confirmation returns recovery codes');
      const stored = await h.mfaStorage.storedRecoveryCodes(a);
      assert.strictEqual(stored.length, codes.length);
      for (const code of codes) {
        assert.ok(!stored.some((s) => s.includes(code)), 'no stored value holds a recovery code');
      }
    },
  }),
  defineCase({
    name: 'A10 TOTP codes count into the throttle',
    facet: 'A10/core',
    needs: ['service', 'seed', 'mfa'],
    async run(h, k) {
      const p = throttleParams(k.config);
      const { a, r } = await pendingLogin(h, k);
      for (let i = 0; i < p.mfa.account!.free; i++) {
        expectFail(await h.service.completeMfa(r.pending, h.mfa.step.name, '000000-wrong', k.ctx()), `wrong code ${i + 1}`);
      }
      expectThrottled(await h.service.completeMfa(r.pending, h.mfa.step.name, await h.mfa.code(a), k.ctx()), 1);
      k.clock.tick(SECOND);
      expectSuccess(await h.service.completeMfa(r.pending, h.mfa.step.name, await h.mfa.code(a), k.ctx()));
    },
  }),
  defineCase({
    name: 'A10 a recovery code completes a pending login once',
    facet: 'A10/core',
    needs: ['service', 'seed', 'mfa', 'mfa.recovery', 'sessions'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      await h.mfa.enrol(a);
      const [c1] = await h.mfa.step.regenerateRecoveryCodes!(a);
      const r1 = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectMfaRequired(r1);
      const s = await h.service.completeMfa(r1.pending, 'recovery', c1, k.ctx());
      expectSuccess(s);
      assert.strictEqual(s.facts.assurance, 'aal2');
      const r2 = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectMfaRequired(r2);
      expectFail(await h.service.completeMfa(r2.pending, 'recovery', c1, k.ctx()), 'a used recovery code');
      assert.strictEqual((await h.sessions.restore(r2.pending.id))?.handle.state, 'pending');
    },
  }),
  defineCase({
    name: 'A10 a step code is not accepted as a recovery code',
    facet: 'A10/core',
    needs: ['service', 'seed', 'mfa', 'mfa.recovery'],
    async run(h, k) {
      const { a, r } = await pendingLogin(h, k);
      expectFail(await h.service.completeMfa(r.pending, 'recovery', await h.mfa.code(a), k.ctx()));
    },
  }),
  table(FRESH_ROWS, (row) =>
    defineCase({
      name: `A10 enrolment needs fresh auth: ${row.label}`,
      facet: 'A10/http',
      needs: ['http', 'http.routes.login', 'http.routes.mfaEnrol', 'seed', 'fakeDate'],
      config: FRESH_300,
      async run(h, k) {
        await seedUser(h, ALICE);
        const jar = k.jar();
        await send(h, routes(h).login(ALICE.login, ALICE.password), jar);
        k.clock.tick(row.staleSeconds * SECOND);
        const { status } = await send(h, routes(h).mfaEnrol(), jar);
        assert.ok(row.accepted ? is2xx(status) : in4xx(status), `enrolment answered ${status}`);
      },
    }),
  ),
  table(DISABLE_ROWS, (row) =>
    defineCase({
      name: `A10 disabling needs fresh auth and a valid code: ${row.label}`,
      facet: 'A10/http',
      needs: ['http', 'http.routes.login', 'http.routes.mfaVerify', 'http.routes.mfaDisable', 'seed', 'mfa', 'fakeDate'],
      config: FRESH_300,
      async run(h, k) {
        const a = await seedUser(h, ALICE);
        await h.mfa.enrol(a);
        const jar = k.jar();
        await send(h, routes(h).login(ALICE.login, ALICE.password), jar);
        k.clock.tick(30 * SECOND);
        const verified = await send(h, routes(h).mfaVerify(await h.mfa.code(a)), jar);
        assert.strictEqual(verified.status, 200, 'MFA completion');
        k.clock.tick((row.staleSeconds + 30) * SECOND);
        const { status } = await send(h, routes(h).mfaDisable(row.valid ? await h.mfa.code(a) : 'kit-wrong'), jar);
        assert.ok(row.disabled ? is2xx(status) : in4xx(status), `disable answered ${status}`);
        assert.strictEqual(await h.mfa.step.enrolled(a), !row.disabled);
      },
    }),
  ),
]);
