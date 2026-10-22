import assert from 'node:assert/strict';
import { ActionRefused } from '@spinajs/hooks';
import type { AuthnEventType, IdentityRef, KeyOwner, KeyRegistration, PrincipalRef, TokenCreateOptions } from '@spinajs/authn/contracts';
import { generateKeyPair } from '../helpers/index.js';
import type { FlowHookCall, FlowHooksPort } from '../harness/ports.js';
import { ALICE, BOB, NEW_PW, auth, expectFail, expectSuccess, factsAal1, pw, seedUser, storedHash } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule, CaseKit, HarnessWith } from './types.js';

const CODE = 'kit-no';
const ADMIN: PrincipalRef = { type: 'user', id: 'kit-admin' };
const SERVICE_OWNER: KeyOwner & { type: 'service' } = { type: 'service', id: 'kit-svc' };
const DAY = 86_400_000;
const MAX_TTL_DAYS = 90;

const phases = (hooks: FlowHooksPort, action: string): string[] => hooks.calls(action).map((c) => c.phase);

const afterOutput = (hooks: FlowHooksPort, action: string): unknown => hooks.calls(action).find((c) => c.phase === 'after')?.output;

/** Every value a call carries, as text; a secret in an input or an output shows up here. */
function textOf(calls: readonly FlowHookCall[]): string {
  return JSON.stringify(calls, (_k, v: unknown) => (v instanceof Date ? v.toISOString() : v instanceof Error ? v.name : v));
}

function refusedWith(code: string): (err: unknown) => boolean {
  return (err) => err instanceof ActionRefused && err.code === code;
}

const audited = (h: HarnessWith<'events'>, type: AuthnEventType, reason: string): boolean => h.events.all().some((e) => e.type === type && e.outcome === 'failure' && e.reason === reason);

const LOCAL_NEEDS = ['password', 'seed', 'flowHooks'] as const;

async function changeSetup(h: HarnessWith<'password' | 'seed' | 'sessions'>, k: CaseKit) {
  const a = await seedUser(h, ALICE);
  const session = await h.sessions.issue(a, factsAal1(k));
  return { a, change: () => h.password.change(a, ALICE.password, NEW_PW, session, k.ctx({ purpose: 'reauth' })) };
}

const after = (k: CaseKit, ms: number): Date => new Date(k.clock.now().getTime() + ms);

const pat = (k: CaseKit, over: Partial<TokenCreateOptions> = {}): TokenCreateOptions => ({ name: 'kit', kind: 'pat', expiresAt: after(k, DAY), ...over }) as TokenCreateOptions;

async function mint(h: HarnessWith<'tokens'>, k: CaseKit, owner: IdentityRef) {
  const t = await h.tokens.create(owner, pat(k), k.ctx());
  assert.ok(t.ok, `the token is minted: ${JSON.stringify(t)}`);
  return t;
}

const serviceKey = (): { reg: KeyRegistration; kid: string } => {
  const kp = generateKeyPair('EdDSA');
  return { reg: { owner: SERVICE_OWNER, actor: ADMIN, jwk: kp.publicJwk, kid: kp.kid }, kid: kp.kid };
};

export const A38: AuthnRule = defineRule('A38', 'action hooks run around the password, token and key flows, and a refusal gives the answer the flow documents', [
  defineCase({
    name: 'A38 authn.password.change runs before and after once, in order, and its input holds no password',
    facet: 'A38/local',
    needs: [...LOCAL_NEEDS, 'sessions'],
    async run(h, k) {
      const { change } = await changeSetup(h, k);
      assert.strictEqual((await change()).status, 'changed');
      assert.deepStrictEqual(phases(h.flowHooks, 'authn.password.change'), ['before', 'after']);
      assert.deepStrictEqual(afterOutput(h.flowHooks, 'authn.password.change'), { status: 'changed' }, 'the after hook sees the status, not the rotated session');
      const calls = h.flowHooks.calls('authn.password.change');
      assert.deepStrictEqual(Object.keys(calls[0].input).sort(), ['ctx', 'id', 'session']);
      assert.ok(!textOf(calls).includes(ALICE.password) && !textOf(calls).includes(NEW_PW), 'no password reaches a hook');
    },
  }),
  defineCase({
    name: 'A38 a refused password change answers refused, stores no hash and audits hook:<code>',
    facet: 'A38/local',
    needs: [...LOCAL_NEEDS, 'sessions', 'passwordStore', 'events', 'service'],
    async run(h, k) {
      const { a, change } = await changeSetup(h, k);
      const stored = await storedHash(h, a);
      h.flowHooks.refuse('authn.password.change', CODE);
      assert.deepStrictEqual({ ...(await change()) }, { status: 'refused', code: CODE });
      assert.strictEqual(await storedHash(h, a), stored, 'no hash is stored');
      assert.deepStrictEqual(phases(h.flowHooks, 'authn.password.change'), ['before'], 'a refused action has no after');
      assert.ok(audited(h, 'password.change', `hook:${CODE}`), 'audited as hook:<code>');
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)), 'the old password still logs in');
    },
  }),
  defineCase({
    name: 'A38 a failing hook on a password change answers refused with hook_error',
    facet: 'A38/local',
    needs: [...LOCAL_NEEDS, 'sessions', 'passwordStore', 'events'],
    async run(h, k) {
      const { a, change } = await changeSetup(h, k);
      const stored = await storedHash(h, a);
      h.flowHooks.fail('authn.password.change');
      assert.deepStrictEqual({ ...(await change()) }, { status: 'refused', code: 'hook_error' });
      assert.strictEqual(await storedHash(h, a), stored);
      assert.ok(audited(h, 'password.change', 'hook_error'), 'audited as hook_error');
    },
  }),
  defineCase({
    name: 'A38 authn.password.set: a refusal answers refused and stores no hash; after sees status set',
    facet: 'A38/local',
    needs: [...LOCAL_NEEDS, 'passwordStore'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const stored = await storedHash(h, a);
      h.flowHooks.refuse('authn.password.set', CODE);
      assert.deepStrictEqual({ ...(await h.password.set(a, NEW_PW, k.ctx({ purpose: 'request' }), { actor: ADMIN })) }, { status: 'refused', code: CODE });
      assert.strictEqual(await storedHash(h, a), stored, 'no hash is stored');
      h.flowHooks.reset();
      assert.strictEqual((await h.password.set(a, NEW_PW, k.ctx({ purpose: 'request' }), { actor: ADMIN })).status, 'set');
      assert.deepStrictEqual(phases(h.flowHooks, 'authn.password.set'), ['before', 'after']);
      assert.deepStrictEqual(afterOutput(h.flowHooks, 'authn.password.set'), { status: 'set' });
      assert.ok(!textOf(h.flowHooks.calls()).includes(NEW_PW), 'no password reaches a hook');
    },
  }),
  defineCase({
    name: 'A38 a refused reset request answers accepted, mails nothing and audits hook:<code>',
    facet: 'A38/local',
    needs: [...LOCAL_NEEDS, 'outbox', 'events'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      h.flowHooks.refuse('authn.password.reset.request', CODE);
      assert.deepStrictEqual({ ...(await h.password.requestReset(ALICE.login, k.ctx({ purpose: 'login' }))) }, { status: 'accepted' }, 'the same answer as for any login');
      assert.strictEqual(await h.outbox.sent(a, 'reset'), 0, 'no mail');
      assert.ok(audited(h, 'password.reset.request', `hook:${CODE}`));
      assert.deepStrictEqual(Object.keys(h.flowHooks.calls('authn.password.reset.request')[0].input).sort(), ['ctx', 'login'], 'the input names no identity');
    },
  }),
  defineCase({
    name: 'A38 a change to a key the reset request does not declare mutable does not reach it',
    facet: 'A38/local',
    needs: [...LOCAL_NEEDS, 'outbox'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const b = await seedUser(h, BOB);
      h.flowHooks.mutate('authn.password.reset.request', { login: BOB.login });
      assert.deepStrictEqual({ ...(await h.password.requestReset(ALICE.login, k.ctx({ purpose: 'login' }))) }, { status: 'accepted' });
      assert.strictEqual(await h.outbox.sent(a, 'reset'), 1, 'the mail goes to the login the caller asked for');
      assert.strictEqual(await h.outbox.sent(b, 'reset'), 0);
    },
  }),
  defineCase({
    name: 'A38 a refused reset redemption answers refused and does not spend the secret; after sees status reset with its purpose',
    facet: 'A38/local',
    needs: [...LOCAL_NEEDS, 'outbox', 'service'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      await h.password.requestReset(ALICE.login, k.ctx({ purpose: 'login' }));
      const secret = await h.outbox.secretFor(a, 'reset');
      assert.ok(secret, 'the reset mail holds a secret');
      h.flowHooks.refuse('authn.password.reset.redeem', CODE);
      assert.deepStrictEqual({ ...(await h.password.redeemReset(ALICE.login, secret, NEW_PW, k.ctx({ purpose: 'login' }))) }, { status: 'refused', code: CODE });
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)), 'the password is unchanged');
      h.flowHooks.reset();
      assert.deepStrictEqual({ ...(await h.password.redeemReset(ALICE.login, secret, NEW_PW, k.ctx({ purpose: 'login' }))) }, { status: 'reset', purpose: 'reset' }, 'the secret was not spent');
      assert.deepStrictEqual(afterOutput(h.flowHooks, 'authn.password.reset.redeem'), { status: 'reset', purpose: 'reset' });
      assert.ok(!textOf(h.flowHooks.calls()).includes(secret) && !textOf(h.flowHooks.calls()).includes(NEW_PW), 'neither the secret nor the password reaches a hook');
    },
  }),
  defineCase({
    name: 'A38 a refused invite throws ActionRefused and mails nothing',
    facet: 'A38/local',
    needs: [...LOCAL_NEEDS, 'outbox'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      h.flowHooks.refuse('authn.password.invite', CODE);
      await assert.rejects(h.password.invite(a, k.ctx({ purpose: 'request' }), { actor: ADMIN }), refusedWith(CODE));
      assert.strictEqual(await h.outbox.sent(a, 'invite'), 0);
    },
  }),
  defineCase({
    name: 'A38 a refused admin expiry throws ActionRefused and expires nothing; an aged expiry completes although refused',
    facet: 'A38/local',
    needs: [...LOCAL_NEEDS, 'service', 'events'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      h.flowHooks.refuse('authn.password.expire', CODE);
      await assert.rejects(h.password.expire(a, { cause: 'admin', actor: ADMIN, sendReset: false }, k.ctx({ purpose: 'request' })), refusedWith(CODE));
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)), 'the refused admin expiry expired nothing');
      assert.ok(audited(h, 'password.change', `hook:${CODE}`), 'audited as hook:<code>');
      await h.password.expire(a, { cause: 'aged' }, k.ctx({ purpose: 'request' }));
      expectFail(await auth(h, k, pw(ALICE.login, ALICE.password)), 'the aged expiry is not refusable');
    },
  }),
  defineCase({
    name: 'A38 a refused verification request answers accepted and mails nothing; a refused verification answers invalid and does not spend the secret',
    facet: 'A38/local',
    needs: [...LOCAL_NEEDS, 'outbox'],
    async run(h, k) {
      const a = await seedUser(h, ALICE, { addressVerified: false });
      // Another identity: the refused request already counted in the throttle, which runs before the hooks.
      const b = await seedUser(h, BOB, { addressVerified: false });
      const p = h.password as Required<typeof h.password>;
      assert.strictEqual(typeof p.requestVerification, 'function', 'the PasswordService offers requestVerification');
      h.flowHooks.refuse('authn.address.verify.request', CODE);
      assert.deepStrictEqual({ ...(await p.requestVerification(b, k.ctx({ purpose: 'request' }))) }, { status: 'accepted' });
      assert.strictEqual(await h.outbox.sent(b, 'verify'), 0, 'no mail');
      h.flowHooks.reset();
      assert.deepStrictEqual({ ...(await p.requestVerification(a, k.ctx({ purpose: 'request' }))) }, { status: 'accepted' });
      const secret = await h.outbox.secretFor(a, 'verify');
      assert.ok(secret, 'the verify mail holds a secret');
      h.flowHooks.refuse('authn.address.verify', CODE);
      assert.deepStrictEqual({ ...(await p.redeemVerification(secret, k.ctx({ purpose: 'request' }))) }, { status: 'invalid' });
      h.flowHooks.reset();
      assert.deepStrictEqual({ ...(await p.redeemVerification(secret, k.ctx({ purpose: 'request' }))) }, { status: 'verified' }, 'the secret was not spent');
      assert.deepStrictEqual(Object.keys(h.flowHooks.calls('authn.address.verify')[0].input), ['ctx'], 'the input names no identity');
    },
  }),

  defineCase({
    name: 'A38 authn.token.create runs before and after once; no hook sees the plaintext',
    facet: 'A38/token',
    needs: ['tokens', 'seed', 'flowHooks'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const t = await mint(h, k, a);
      assert.deepStrictEqual(phases(h.flowHooks, 'authn.token.create'), ['before', 'after']);
      assert.ok(!textOf(h.flowHooks.calls()).includes(t.plaintext), 'the plaintext reaches no hook');
    },
  }),
  defineCase({
    name: 'A38 a refused token create throws ActionRefused and stores no token',
    facet: 'A38/token',
    needs: ['tokens', 'seed', 'flowHooks'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      h.flowHooks.refuse('authn.token.create', CODE);
      await assert.rejects(h.tokens.create(a, pat(k), k.ctx()), refusedWith(CODE));
      assert.strictEqual((await h.tokens.list(a)).length, 0);
    },
  }),
  defineCase({
    name: 'A38 a hook that raises the expiry past the cap or widens the scope is refused by the token service',
    facet: 'A38/token',
    needs: ['tokens', 'seed', 'flowHooks'],
    config: { authn: { token: { maxTtlDays: MAX_TTL_DAYS } } },
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const scoped = pat(k, { scope: { permissions: ['kit:read'] } });
      h.flowHooks.mutate('authn.token.create', (input) => ({ opts: { ...(input.opts as object), expiresAt: after(k, MAX_TTL_DAYS * DAY + 1000) } }));
      assert.deepStrictEqual({ ...(await h.tokens.create(a, scoped, k.ctx())) }, { ok: false, code: 'invalid_expiry' });
      h.flowHooks.reset();
      h.flowHooks.mutate('authn.token.create', (input) => ({ opts: { ...(input.opts as object), scope: { permissions: ['kit:read', 'kit:write'] } } }));
      assert.deepStrictEqual({ ...(await h.tokens.create(a, scoped, k.ctx())) }, { ok: false, code: 'invalid_scope' });
      h.flowHooks.reset();
      h.flowHooks.mutate('authn.token.create', (input) => ({ opts: { ...(input.opts as object), scope: undefined } }));
      assert.deepStrictEqual({ ...(await h.tokens.create(a, scoped, k.ctx())) }, { ok: false, code: 'invalid_scope' }, 'dropping the scope widens it');
      assert.strictEqual((await h.tokens.list(a)).length, 0, 'no token was stored');
    },
  }),
  defineCase({
    name: 'A38 a refused token revoke keeps the token valid',
    facet: 'A38/token',
    needs: ['tokens', 'seed', 'flowHooks'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const t = await mint(h, k, a);
      h.flowHooks.refuse('authn.token.revoke', CODE);
      await assert.rejects(h.tokens.revoke(a, t.record.id, k.ctx()), refusedWith(CODE));
      assert.strictEqual((await h.tokens.validate(t.plaintext, k.ctx())).ok, true, 'the token is still valid');
    },
  }),
  defineCase({
    name: 'A38 a refusing hook on authn.token.selfRevoke does not stop the revocation',
    facet: 'A38/token',
    needs: ['tokens', 'seed', 'flowHooks'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const t = await mint(h, k, a);
      h.flowHooks.refuse('authn.token.selfRevoke', CODE);
      assert.strictEqual(await h.tokens.revokeByPlaintext(t.plaintext, k.ctx()), true);
      assert.strictEqual((await h.tokens.validate(t.plaintext, k.ctx())).ok, false, 'the token is revoked');
      assert.ok(!textOf(h.flowHooks.calls()).includes(t.plaintext), 'the plaintext reaches no hook');
    },
  }),
  defineCase({
    name: 'A38 revokeAllFor runs no hook',
    facet: 'A38/token',
    needs: ['tokens', 'seed', 'flowHooks'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      await mint(h, k, a);
      h.flowHooks.reset();
      h.flowHooks.refuse('*', CODE);
      assert.strictEqual(await h.tokens.revokeAllFor(a, k.ctx()), 1);
      assert.deepStrictEqual(h.flowHooks.calls(), []);
    },
  }),
  defineCase({
    name: 'A38 a token create that throws runs the failed hooks once and rethrows',
    facet: 'A38/token',
    needs: ['tokens', 'flowHooks'],
    async run(h, k) {
      const unknown: IdentityRef = { type: 'user', id: 'kit-never-seeded' };
      await assert.rejects(h.tokens.create(unknown, pat(k), k.ctx()));
      assert.deepStrictEqual(phases(h.flowHooks, 'authn.token.create'), ['before', 'failed']);
    },
  }),

  defineCase({
    name: 'A38 authn.key.register: before and after run once; a refusal answers refused and stores no key',
    facet: 'A38/keys',
    needs: ['keys', 'flowHooks'],
    async run(h, k) {
      const refused = serviceKey();
      h.flowHooks.refuse('authn.key.register', CODE);
      assert.deepStrictEqual({ ...(await h.keys.register(refused.reg, k.ctx())) }, { ok: false, code: 'refused', refusal: CODE });
      assert.strictEqual(await h.keys.byId(refused.kid), null, 'no key is stored');
      h.flowHooks.reset();
      const ok = serviceKey();
      assert.strictEqual((await h.keys.register(ok.reg, k.ctx())).ok, true);
      assert.deepStrictEqual(phases(h.flowHooks, 'authn.key.register'), ['before', 'after']);
    },
  }),
  defineCase({
    name: 'A38 a refused key revoke answers false and the key stays usable',
    facet: 'A38/keys',
    needs: ['keys', 'flowHooks'],
    async run(h, k) {
      const key = serviceKey();
      assert.strictEqual((await h.keys.register(key.reg, k.ctx())).ok, true);
      h.flowHooks.refuse('authn.key.revoke', CODE);
      assert.strictEqual(await h.keys.revoke(SERVICE_OWNER, key.kid, k.ctx(), { actor: ADMIN }), false);
      assert.ok(!(await h.keys.byId(key.kid))?.revokedAt, 'the key is not revoked');
    },
  }),
]);
