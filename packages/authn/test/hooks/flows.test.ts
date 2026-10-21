import assert from 'node:assert/strict';
import 'mocha';
import * as sinon from 'sinon';
import { fakeHash } from '@spinajs/authn-testing';
import type { Configuration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';
import type { ActionHook } from '@spinajs/hooks';
import { RecordingActionHook, mutatingHook, refusingHook } from '@spinajs/hooks/testing';

import { AccountLinkService, AuthnImpersonationService, MemoryAuthnThrottle } from '../../src/index.js';
import type { AuthnContext, AuthnEvent, AuthnFacts, Credentials, ExternalSubject, IdentityRef, SessionHandle, ThrottleFlow, ThrottleKey } from '../../src/index.js';
import { buildCore, pinConfiguration, useHarnessLog } from '../behaviour/harness.js';
import type { CoreOptions, CoreParts } from '../behaviour/harness.js';
import { TestLog } from '../audit/test-log.js';

const SECOND = 1000;
const T0 = new Date('2026-10-03T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const IP = '192.0.2.10';
const ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' };
const BOB = { login: 'bob@example.test', password: 'Bob-Pass-2345x' };
const G1: ExternalSubject = { provider: 'kit-g', subject: 'g-alice' };
const INVALID = { status: 'failure', reason: 'invalid_credentials' };

class RecordingThrottle extends MemoryAuthnThrottle {
  readonly attempts: { flow: ThrottleFlow }[] = [];
  readonly succeeds: { flow: ThrottleFlow }[] = [];

  async attempt(keys: readonly ThrottleKey[], flow: ThrottleFlow, ctx: AuthnContext) {
    this.attempts.push({ flow });
    return super.attempt(keys, flow, ctx);
  }

  async succeed(keys: readonly ThrottleKey[], flow: ThrottleFlow) {
    this.succeeds.push({ flow });
    return super.succeed(keys, flow);
  }
}

const ctx = (over: Partial<AuthnContext> = {}): AuthnContext => ({ now: new Date(), ip: IP, purpose: 'login', ...over });
const pw = (login: string, password: string): Credentials => ({ kind: 'password', login, password });

const failuresOf = (events: readonly AuthnEvent[], type: AuthnEvent['type']): (string | undefined)[] => events.filter((e) => e.type === type && e.outcome === 'failure').map((e) => e.reason);

describe('action hooks: authn flows', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;
  let throttle: RecordingThrottle | undefined;

  afterEach(async () => {
    sinon.restore();
    await parts?.dispose();
    parts = undefined;
    throttle = undefined;
  });

  async function boot(hooks: readonly ActionHook[], opts: CoreOptions = {}): Promise<CoreParts> {
    parts = await buildCore({}, { throttle: (_c: Configuration, k: IContainer) => (throttle = pinConfiguration(new RecordingThrottle(), k)), hooks, ...opts });
    return parts;
  }

  const seed = async (p: CoreParts, u: { login: string; password: string } = ALICE): Promise<IdentityRef> => {
    const id = p.identities.add({ login: u.login, email: u.login });
    await p.passwords.set(id, fakeHash(u.password));
    return id;
  };

  /** Alice logged in with the password: an active aal1 session. */
  async function aliceSession(p: CoreParts): Promise<{ a: IdentityRef; session: SessionHandle }> {
    const a = await seed(p);
    const r = await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx());
    assert.strictEqual(r.status, 'success', JSON.stringify(r));
    return { a, session: r.session! };
  }

  describe('authn.mfa.verify', () => {
    async function pendingAlice(p: CoreParts): Promise<{ a: IdentityRef; pending: SessionHandle }> {
      const a = await seed(p);
      p.step.enrol(a);
      const r = await p.service.authenticate(pw(ALICE.login, ALICE.password), ctx());
      assert.strictEqual(r.status, 'mfa_required', JSON.stringify(r));
      return { a, pending: r.pending };
    }

    it('a refusal gives the same result as a wrong code: counted, still pending, audited hook:<code>', async () => {
      const p = await boot([refusingHook('authn.mfa.verify', 'kit-mfa-locked')]);
      const { a, pending } = await pendingAlice(p);
      const refused = await p.service.completeMfa(pending, p.step.name, p.step.nextCode(a), ctx());
      assert.deepStrictEqual(refused, INVALID, 'the answer of a wrong code');
      assert.strictEqual(p.step.verifyCalls.length, 0, 'the step verifies nothing');
      assert.strictEqual(throttle!.attempts.filter((x) => x.flow === 'mfa').length, 1, 'the attempt counts, as a wrong code does');
      assert.deepStrictEqual(throttle!.succeeds.filter((x) => x.flow === 'mfa'), []);
      assert.strictEqual((await p.sessions.restore(pending.id))?.handle.state, 'pending');
      assert.deepStrictEqual(failuresOf(p.events.all(), 'mfa.verify'), ['hook:kit-mfa-locked']);
    });

    it('runs before and after once with the pending session, the step and the context', async () => {
      const recorder = new RecordingActionHook(['authn.mfa.verify']);
      const p = await boot([recorder]);
      const { a, pending } = await pendingAlice(p);
      const c = ctx();
      const done = await p.service.completeMfa(pending, p.step.name, p.step.nextCode(a), c);
      assert.strictEqual(done.status, 'success');
      assert.deepStrictEqual(
        recorder.calls.map((x) => x.phase),
        ['before', 'after'],
      );
      const input = recorder.calls[0].input as Record<string, unknown>;
      assert.deepStrictEqual(Object.keys(input).sort(), ['ctx', 'pending', 'response', 'step']);
      assert.deepStrictEqual(input.pending, pending);
      assert.strictEqual(input.step, p.step.name);
      assert.strictEqual(recorder.calls[1].output, done);
    });

    it('a changed response does not reach the step', async () => {
      const p = await boot([mutatingHook('authn.mfa.verify', { response: 'wrong-code-123' })]);
      const { a, pending } = await pendingAlice(p);
      const code = p.step.nextCode(a);
      assert.strictEqual((await p.service.completeMfa(pending, p.step.name, code, ctx())).status, 'success');
      assert.deepStrictEqual(
        p.step.verifyCalls.map((c) => c.response),
        [code],
      );
    });
  });

  describe('authn.reauth', () => {
    it('a refusal returns false and audits reauth with hook:<code>, verifying nothing', async () => {
      const p = await boot([refusingHook('authn.reauth', 'kit-reauth-off')]);
      const { session } = await aliceSession(p);
      const local = p.strategies.find((s) => s.name === 'local')!.instance as unknown as { verifyCalls: unknown[] };
      const before = local.verifyCalls.length;
      assert.strictEqual(await p.service.reauthenticate(session, pw(ALICE.login, ALICE.password), ctx({ purpose: 'reauth', session })), false);
      assert.strictEqual(local.verifyCalls.length, before);
      assert.deepStrictEqual(failuresOf(p.events.all(), 'reauth'), ['hook:kit-reauth-off']);
    });

    it('changed credentials do not reach the strategy', async () => {
      const p = await boot([mutatingHook('authn.reauth', { credentials: pw(ALICE.login, ALICE.password) })]);
      const { session } = await aliceSession(p);
      assert.strictEqual(await p.service.reauthenticate(session, pw(ALICE.login, 'Wrong-Pass-9876'), ctx({ purpose: 'reauth', session })), false);
    });
  });

  describe('authn.session.stepUp', () => {
    it('a refusal gives the same failure as a wrong code, and no reissue happens', async () => {
      const p = await boot([refusingHook('authn.session.stepUp', 'kit-no-step-up')]);
      const { a, session } = await aliceSession(p);
      p.step.enrol(a);
      const reissue = sinon.spy(p.sessions, 'reissue');
      const refused = await p.service.stepUp(session, p.step.name, p.step.nextCode(a), ctx());
      assert.deepStrictEqual(refused, INVALID, 'the answer of a wrong code');
      assert.strictEqual(reissue.callCount, 0, 'no reissue');
      assert.strictEqual(p.step.verifyCalls.length, 0, 'the step verifies nothing');
      assert.strictEqual((await p.sessions.restore(session.id))?.facts.assurance, 'aal1', 'the session is unchanged');
      assert.deepStrictEqual(failuresOf(p.events.all(), 'mfa.verify'), ['hook:kit-no-step-up']);
    });

    it('runs before and after once around a step-up', async () => {
      const recorder = new RecordingActionHook(['authn.session.stepUp']);
      const p = await boot([recorder]);
      const { a, session } = await aliceSession(p);
      p.step.enrol(a);
      const r = await p.service.stepUp(session, p.step.name, p.step.nextCode(a), ctx());
      assert.strictEqual(r.status, 'success');
      assert.deepStrictEqual(
        recorder.calls.map((x) => x.phase),
        ['before', 'after'],
      );
      assert.deepStrictEqual(Object.keys(recorder.calls[0].input as object).sort(), ['ctx', 'response', 'session', 'step']);
    });
  });

  describe('impersonation', () => {
    const ADMIN: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['fake'], authenticatedAt: T0 };
    const ictx = (now: Date = at(10 * SECOND)): AuthnContext => ({ now, ip: IP, purpose: 'login' });

    async function bootImpersonation(hooks: readonly ActionHook[]) {
      const p = await boot(hooks, { raw: { authn: { freshAuth: { maxAgeSeconds: 300 } } } });
      const a = await seed(p);
      const b = await seed(p, BOB);
      const admin = await p.sessions.issue(a, ADMIN);
      return { p, a, b, admin, svc: await p.child.resolve(AuthnImpersonationService) };
    }

    it('authn.impersonation.start: a refusal returns { ok: false }, audits impersonation.start with hook:<code>, and keeps the actor session', async () => {
      const { p, b, admin, svc } = await bootImpersonation([refusingHook('authn.impersonation.start', 'kit-no-impersonation')]);
      assert.deepStrictEqual(await svc.start(admin, b, ictx()), { ok: false });
      assert.deepStrictEqual(failuresOf(p.events.all(), 'impersonation.start'), ['hook:kit-no-impersonation']);
      assert.strictEqual((await p.sessions.restore(admin.id))?.handle.state, 'active', 'the actor session stays');
      assert.deepStrictEqual(await p.sessions.storage.storedKeys().then((k) => k.length), 1, 'no target session');
    });

    it('authn.impersonation.start: the input is the session, the target and the context', async () => {
      const recorder = new RecordingActionHook(['authn.impersonation.start']);
      const { b, admin, svc } = await bootImpersonation([recorder]);
      const r = await svc.start(admin, b, ictx());
      assert.ok(r.ok);
      assert.deepStrictEqual(
        recorder.calls.map((x) => x.phase),
        ['before', 'after'],
      );
      const input = recorder.calls[0].input as Record<string, unknown>;
      assert.deepStrictEqual(Object.keys(input).sort(), ['ctx', 'session', 'target']);
      assert.deepStrictEqual(input.target, b);
    });

    it('authn.impersonation.stop: a refusing hook is logged and the impersonation still ends', async () => {
      const { p, a, b, admin, svc } = await bootImpersonation([refusingHook('authn.impersonation.stop', 'kit-stay')]);
      const started = await svc.start(admin, b, ictx());
      assert.ok(started.ok);
      const own = await svc.stop(started.session, ictx(at(20 * SECOND)));
      assert.ok(own, 'the impersonator gets its own session back');
      assert.deepStrictEqual((await p.sessions.restore(own.id))?.identity, a);
      assert.strictEqual(await p.sessions.restore(started.session.id), null, 'the impersonation session is gone');
      assert.ok(p.events.ofType('impersonation.end').some((e) => e.outcome === 'success'));
      assert.ok(
        TestLog.entries.some((e) => e.logger === 'hooks' && e.level === 'warn' && e.message.includes('authn.impersonation.stop')),
        JSON.stringify(TestLog.entries),
      );
    });
  });

  describe('account linking', () => {
    const lctx = (session: SessionHandle, now: Date = new Date()): AuthnContext => ({ now, session, ip: IP, purpose: 'link' });

    function spyLinks(p: CoreParts) {
      return ['find', 'list', 'link', 'unlink'].map((m) => sinon.spy(p.links, m as 'find'));
    }

    it('authn.link: a refusal returns { ok: false } and never touches the IdentityLinkStore', async () => {
      const p = await boot([refusingHook('authn.link', 'kit-no-link')]);
      const { session } = await aliceSession(p);
      const svc = await p.child.resolve(AccountLinkService);
      const spies = spyLinks(p);
      assert.deepStrictEqual(await svc.link(session, G1, lctx(session)), { ok: false });
      for (const s of spies) assert.strictEqual(s.callCount, 0);
      assert.strictEqual(p.links.links.length, 0);
      assert.deepStrictEqual(failuresOf(p.events.all(), 'identity.link'), ['hook:kit-no-link']);
    });

    it('authn.unlink: a refusal returns { ok: false } and never touches the IdentityLinkStore', async () => {
      const p = await boot([refusingHook('authn.unlink', 'kit-no-unlink')]);
      const { a, session } = await aliceSession(p);
      const link = await p.links.link(a, G1);
      const svc = await p.child.resolve(AccountLinkService);
      const spies = spyLinks(p);
      assert.deepStrictEqual(await svc.unlink(session, link.id, lctx(session)), { ok: false });
      for (const s of spies) assert.strictEqual(s.callCount, 0);
      assert.strictEqual(p.links.links.length, 1);
      assert.deepStrictEqual(failuresOf(p.events.all(), 'identity.unlink'), ['hook:kit-no-unlink']);
    });

    it('authn.link and authn.unlink run before and after once each', async () => {
      const recorder = new RecordingActionHook(['authn.link', 'authn.unlink']);
      const p = await boot([recorder]);
      const { session } = await aliceSession(p);
      const svc = await p.child.resolve(AccountLinkService);
      const r = await svc.link(session, G1, lctx(session));
      assert.ok(r.ok);
      assert.deepStrictEqual((await svc.unlink(session, r.link.id, lctx(session))).ok, true);
      assert.deepStrictEqual(
        recorder.calls.map((x) => `${x.phase} ${x.action}`),
        ['before authn.link', 'after authn.link', 'before authn.unlink', 'after authn.unlink'],
      );
      assert.deepStrictEqual(Object.keys(recorder.calls[0].input as object).sort(), ['ctx', 'external', 'session']);
      assert.deepStrictEqual(Object.keys(recorder.calls[2].input as object).sort(), ['ctx', 'linkId', 'session']);
    });
  });
});
