import assert from 'node:assert/strict';
// The authn action names of HookActions come with the root entry, not with /contracts.
import type {} from '@spinajs/authn';
import type { AuthenticationResult, IdentityRef, SessionHandle, SessionIssuer } from '@spinajs/authn/contracts';
import { RecordingActionHook, mutatingHook, refusingHook } from '@spinajs/hooks/testing';
import { ALICE, BOB, SPOOF_IP, auth, expectFailure, expectMfaRequired, expectSuccess, pw, seedUser } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule, CaseKit, HarnessWith } from './types.js';

const CODE = 'kit-refused';
const REASON = `hook:${CODE}`;

const phases = (r: RecordingActionHook, action?: string): string[] => r.calls.filter((c) => action === undefined || c.action === action).map((c) => c.phase);

const failureReasons = (h: HarnessWith<'events'>, type: string): (string | undefined)[] =>
  h.events
    .all()
    .filter((e) => e.type === type && e.outcome === 'failure')
    .map((e) => e.reason);

/** ALICE logged in with her password: an active aal1 session. */
async function aliceSession(h: HarnessWith<'service' | 'seed'>, k: CaseKit): Promise<{ a: IdentityRef; session: SessionHandle }> {
  const a = await seedUser(h, ALICE);
  const r = await auth(h, k, pw(ALICE.login, ALICE.password));
  expectSuccess(r);
  assert.ok(r.session, 'an interactive login issues a session');
  return { a, session: r.session };
}

/** ALICE enrolled in MFA and past her password: a pending session. */
async function alicePending(h: HarnessWith<'service' | 'seed' | 'mfa'>, k: CaseKit): Promise<{ a: IdentityRef; pending: SessionHandle }> {
  const a = await seedUser(h, ALICE);
  await h.mfa.enrol(a);
  const r = await auth(h, k, pw(ALICE.login, ALICE.password));
  expectMfaRequired(r);
  return { a, pending: r.pending };
}

/** ALICE with MFA, logged in and elevated: an aal2, fresh session that can impersonate BOB. */
async function adminSession(h: HarnessWith<'service' | 'seed' | 'mfa'>, k: CaseKit): Promise<{ a: IdentityRef; b: IdentityRef; session: SessionHandle }> {
  const { a, pending } = await alicePending(h, k);
  const s = await h.service.completeMfa(pending, h.mfa.step.name, await h.mfa.code(a), k.ctx());
  expectSuccess(s);
  assert.ok(s.session, 'completeMfa returns the session');
  const b = await seedUser(h, BOB);
  return { a, b, session: s.session };
}

/** Runs `run` while the lane's SessionIssuer fails to issue. */
async function withIssueFailing<T>(sessions: SessionIssuer, run: () => Promise<T>): Promise<T> {
  const target = sessions as unknown as { issue: SessionIssuer['issue'] };
  const own = Object.prototype.hasOwnProperty.call(target, 'issue');
  const original = target.issue;
  target.issue = async () => {
    throw new Error('kit session store down');
  };
  try {
    return await run();
  } finally {
    if (own) target.issue = original;
    else delete (target as { issue?: unknown }).issue;
  }
}

const IMPERSONATION = { authn: { impersonation: { requireMfa: true, requirePassword: true } } };

export const A37: AuthnRule = defineRule('A37', 'action hooks run around authn actions, narrow them and never widen them', [
  defineCase({
    name: 'A37 authn.login: before and after run once, in order, and the input carries no identity',
    facet: 'A37/core',
    needs: ['service', 'seed', 'hooks'],
    async run(h, k) {
      const recorder = new RecordingActionHook(['authn.login']);
      h.hooks.add(recorder);
      await seedUser(h, ALICE);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectSuccess(r);
      assert.deepStrictEqual(phases(recorder), ['before', 'after']);
      const input = recorder.calls[0].input as Record<string, unknown>;
      assert.deepStrictEqual(Object.keys(input).sort(), ['credentials', 'ctx']);
      assert.strictEqual((recorder.calls[1].output as AuthenticationResult).status, 'success');
    },
  }),
  defineCase({
    name: 'A37 authn.login refused: invalid_credentials, audited hook:<code>, nothing verified',
    facet: 'A37/core',
    needs: ['service', 'seed', 'hooks', 'events', 'spy'],
    async run(h, k) {
      h.hooks.add(refusingHook('authn.login', CODE));
      await seedUser(h, ALICE);
      const verified = h.spy.verifyCalls();
      expectFailure(await auth(h, k, pw(ALICE.login, ALICE.password)), 'invalid_credentials');
      assert.strictEqual(h.spy.verifyCalls(), verified, 'no strategy verifies');
      assert.deepStrictEqual(failureReasons(h, 'login'), [REASON]);
    },
  }),
  defineCase({
    name: 'A37 authn.login: a changed ctx does not reach the action',
    facet: 'A37/core',
    needs: ['service', 'seed', 'hooks', 'events'],
    async run(h, k) {
      h.hooks.add(mutatingHook('authn.login', { ctx: k.ctx({ ip: SPOOF_IP }) }));
      await seedUser(h, ALICE);
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)));
      const login = h.events.all().find((e) => e.type === 'login' && e.outcome === 'success');
      assert.ok(login, 'a login success event');
      assert.notStrictEqual(login.ip, SPOOF_IP, 'the event carries the request ip');
    },
  }),
  defineCase({
    name: 'A37 authn.login.identified: before and after run once, in order, with the identity, strategy and method',
    facet: 'A37/core',
    needs: ['service', 'seed', 'hooks'],
    async run(h, k) {
      const recorder = new RecordingActionHook(['authn.login.identified']);
      h.hooks.add(recorder);
      const a = await seedUser(h, ALICE);
      expectSuccess(await auth(h, k, pw(ALICE.login, ALICE.password)));
      assert.deepStrictEqual(phases(recorder), ['before', 'after']);
      const input = recorder.calls[0].input as Record<string, unknown>;
      assert.deepStrictEqual({ type: (input.identity as IdentityRef).type, id: (input.identity as IdentityRef).id }, { type: a.type, id: a.id });
      assert.strictEqual(input.method, 'password');
      assert.strictEqual(typeof input.strategy, 'string');
      assert.strictEqual(input.external, undefined);
    },
  }),
  defineCase({
    name: 'A37 authn.login.identified: failed hooks see an error of the action, which answers invalid_credentials',
    facet: 'A37/core',
    needs: ['service', 'seed', 'hooks', 'sessions'],
    async run(h, k) {
      const recorder = new RecordingActionHook(['authn.login', 'authn.login.identified']);
      h.hooks.add(recorder);
      await seedUser(h, ALICE);
      const r = await withIssueFailing(h.sessions, () => auth(h, k, pw(ALICE.login, ALICE.password)));
      expectFailure(r, 'invalid_credentials');
      assert.deepStrictEqual(phases(recorder, 'authn.login.identified'), ['before', 'failed']);
      assert.deepStrictEqual(phases(recorder, 'authn.login'), ['before', 'after'], 'the login answers a failure, an output');
      const failed = recorder.calls.find((c) => c.phase === 'failed');
      assert.ok(failed?.error instanceof Error && failed.error.message === 'kit session store down');
    },
  }),
  defineCase({
    name: 'A37 authn.login.identified refused: invalid_credentials, audited hook:<code>, no session',
    facet: 'A37/core',
    needs: ['service', 'seed', 'hooks', 'events'],
    async run(h, k) {
      h.hooks.add(refusingHook('authn.login.identified', CODE));
      await seedUser(h, ALICE);
      expectFailure(await auth(h, k, pw(ALICE.login, ALICE.password)), 'invalid_credentials');
      assert.deepStrictEqual(failureReasons(h, 'login'), [REASON]);
      assert.ok(!h.events.all().some((e) => e.type === 'session.issue' || e.outcome === 'success'), 'no session, no success');
    },
  }),
  defineCase({
    name: 'A37 authn.login.identified: a changed identity does not reach the action',
    facet: 'A37/core',
    needs: ['service', 'seed', 'hooks'],
    async run(h, k) {
      const b = await seedUser(h, BOB);
      h.hooks.add(mutatingHook('authn.login.identified', { identity: b }));
      const a = await seedUser(h, ALICE);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectSuccess(r);
      assert.strictEqual(r.identity.id, a.id);
    },
  }),
  defineCase({
    name: 'A37 authn.mfa.verify: before and after run once, in order, around completeMfa',
    facet: 'A37/core',
    needs: ['service', 'seed', 'hooks', 'mfa'],
    async run(h, k) {
      const recorder = new RecordingActionHook(['authn.mfa.verify']);
      h.hooks.add(recorder);
      const { a, pending } = await alicePending(h, k);
      expectSuccess(await h.service.completeMfa(pending, h.mfa.step.name, await h.mfa.code(a), k.ctx()));
      assert.deepStrictEqual(phases(recorder), ['before', 'after']);
      assert.deepStrictEqual(Object.keys(recorder.calls[0].input as object).sort(), ['ctx', 'pending', 'response', 'step']);
    },
  }),
  defineCase({
    name: 'A37 authn.mfa.verify refused: the answer of a wrong code, audited hook:<code>, still pending',
    facet: 'A37/core',
    needs: ['service', 'seed', 'hooks', 'mfa', 'events', 'sessions'],
    async run(h, k) {
      h.hooks.add(refusingHook('authn.mfa.verify', CODE));
      const { a, pending } = await alicePending(h, k);
      expectFailure(await h.service.completeMfa(pending, h.mfa.step.name, await h.mfa.code(a), k.ctx()), 'invalid_credentials');
      assert.deepStrictEqual(failureReasons(h, 'mfa.verify'), [REASON]);
      assert.strictEqual((await h.sessions.restore(pending.id))?.handle.state, 'pending');
    },
  }),
  defineCase({
    name: 'A37 authn.mfa.verify: a changed response does not reach the step',
    facet: 'A37/core',
    needs: ['service', 'seed', 'hooks', 'mfa'],
    async run(h, k) {
      h.hooks.add(mutatingHook('authn.mfa.verify', { response: 'kit-wrong-code' }));
      const { a, pending } = await alicePending(h, k);
      expectSuccess(await h.service.completeMfa(pending, h.mfa.step.name, await h.mfa.code(a), k.ctx()));
    },
  }),
  defineCase({
    name: 'A37 authn.reauth refused: false, audited hook:<code>',
    facet: 'A37/core',
    needs: ['service', 'seed', 'hooks', 'events'],
    async run(h, k) {
      h.hooks.add(refusingHook('authn.reauth', CODE));
      const { session } = await aliceSession(h, k);
      assert.strictEqual(await h.service.reauthenticate(session, pw(ALICE.login, ALICE.password), k.ctx({ purpose: 'reauth', session })), false);
      assert.deepStrictEqual(failureReasons(h, 'reauth'), [REASON]);
    },
  }),
  defineCase({
    name: 'A37 authn.reauth: changed credentials do not reach the action',
    facet: 'A37/core',
    needs: ['service', 'seed', 'hooks'],
    async run(h, k) {
      h.hooks.add(mutatingHook('authn.reauth', { credentials: pw(ALICE.login, ALICE.password) }));
      const { session } = await aliceSession(h, k);
      assert.strictEqual(await h.service.reauthenticate(session, pw(ALICE.login, 'Wrong-Pass-9876'), k.ctx({ purpose: 'reauth', session })), false);
    },
  }),
  defineCase({
    name: 'A37 authn.session.stepUp refused: the answer of a wrong code, no reissue',
    facet: 'A37/core',
    needs: ['service', 'seed', 'hooks', 'mfa', 'events', 'sessions'],
    async run(h, k) {
      h.hooks.add(refusingHook('authn.session.stepUp', CODE));
      const { a, session } = await aliceSession(h, k);
      await h.mfa.enrol(a);
      expectFailure(await h.service.stepUp(session, h.mfa.step.name, await h.mfa.code(a), k.ctx()), 'invalid_credentials');
      assert.deepStrictEqual(failureReasons(h, 'mfa.verify'), [REASON]);
      const kept = await h.sessions.restore(session.id);
      assert.ok(kept, 'the session keeps its id');
      assert.strictEqual(kept.facts.assurance, 'aal1');
    },
  }),
  defineCase({
    name: 'A37 authn.impersonation.start refused: { ok: false }, audited hook:<code>',
    facet: 'A37/core',
    needs: ['impersonation', 'service', 'seed', 'mfa', 'guard', 'hooks', 'events', 'sessions'],
    config: IMPERSONATION,
    async run(h, k) {
      h.hooks.add(refusingHook('authn.impersonation.start', CODE));
      const { b, session } = await adminSession(h, k);
      assert.deepStrictEqual(await h.impersonation.start(session, b, k.ctx()), { ok: false });
      assert.deepStrictEqual(failureReasons(h, 'impersonation.start'), [REASON]);
      assert.strictEqual((await h.sessions.restore(session.id))?.handle.state, 'active', 'the actor keeps its session');
    },
  }),
  defineCase({
    name: 'A37 authn.impersonation.stop is not refusable: a refusing hook does not keep the impersonation',
    facet: 'A37/core',
    needs: ['impersonation', 'service', 'seed', 'mfa', 'guard', 'hooks', 'sessions'],
    config: IMPERSONATION,
    async run(h, k) {
      const recorder = new RecordingActionHook(['authn.impersonation.stop']);
      h.hooks.add(refusingHook('authn.impersonation.stop', CODE), recorder);
      const { a, b, session } = await adminSession(h, k);
      const started = await h.impersonation.start(session, b, k.ctx());
      assert.ok(started.ok, 'impersonation starts');
      const own = await h.impersonation.stop(started.session, k.ctx());
      assert.ok(own, 'the impersonator gets its own session');
      assert.strictEqual((await h.sessions.restore(own.id))?.identity.id, a.id);
      assert.strictEqual(await h.sessions.restore(started.session.id), null, 'the impersonation session ends');
      assert.deepStrictEqual(phases(recorder), ['before', 'after']);
    },
  }),
  defineCase({
    name: 'A37 authn.link refused: { ok: false }, nothing linked, audited hook:<code>',
    facet: 'A37/flow',
    needs: ['accountLinks', 'links', 'service', 'seed', 'hooks', 'events'],
    async run(h, k) {
      h.hooks.add(refusingHook('authn.link', CODE));
      const { session } = await aliceSession(h, k);
      assert.deepStrictEqual(await h.accountLinks.link(session, { provider: 'kit-g', subject: 'g-new' }, k.ctx({ purpose: 'link', session })), { ok: false });
      assert.strictEqual(await h.links.find('kit-g', 'g-new'), null);
      assert.deepStrictEqual(failureReasons(h, 'identity.link'), [REASON]);
    },
  }),
  defineCase({
    name: 'A37 authn.unlink refused: { ok: false }, the link stays, audited hook:<code>',
    facet: 'A37/flow',
    needs: ['accountLinks', 'links', 'service', 'seed', 'hooks', 'events'],
    async run(h, k) {
      h.hooks.add(refusingHook('authn.unlink', CODE));
      const { a, session } = await aliceSession(h, k);
      const link = await h.links.link(a, { provider: 'kit-g', subject: 'g-old' });
      assert.deepStrictEqual(await h.accountLinks.unlink(session, link.id, k.ctx({ purpose: 'link', session })), { ok: false });
      assert.strictEqual((await h.links.find('kit-g', 'g-old'))?.id, link.id);
      assert.deepStrictEqual(failureReasons(h, 'identity.unlink'), [REASON]);
    },
  }),
  defineCase({
    name: 'A37 authn.link and authn.unlink: before and after run once each, in order',
    facet: 'A37/flow',
    needs: ['accountLinks', 'links', 'service', 'seed', 'hooks'],
    async run(h, k) {
      const recorder = new RecordingActionHook(['authn.link', 'authn.unlink']);
      h.hooks.add(recorder);
      const { session } = await aliceSession(h, k);
      const r = await h.accountLinks.link(session, { provider: 'kit-g', subject: 'g-new' }, k.ctx({ purpose: 'link', session }));
      assert.ok(r.ok, 'the link is made');
      assert.deepStrictEqual(await h.accountLinks.unlink(session, r.link.id, k.ctx({ purpose: 'link', session })), { ok: true });
      assert.deepStrictEqual(
        recorder.calls.map((c) => `${c.phase} ${c.action}`),
        ['before authn.link', 'after authn.link', 'before authn.unlink', 'after authn.unlink'],
      );
    },
  }),
]);
