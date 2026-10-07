import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import 'mocha';
import { fakeHash } from '@spinajs/authn-testing';

import { FreshAuthCheck, AuthnImpersonationService, isFresh } from '../../src/index.js';
import type { AuthnContext, AuthnEvent, AuthnEventType, AuthnFacts, Credentials, IdentityRef, SessionHandle } from '../../src/index.js';
import { IMPERSONATION_BLOCK } from '../../src/impersonation/impersonation-service.js';
import { buildCore, useHarnessLog, violationPaths } from '../behaviour/harness.js';
import type { CoreOptions, CoreParts } from '../behaviour/harness.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const T0 = new Date('2026-10-03T10:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const IP = '192.0.2.10';
const ALICE = { login: 'alice@example.test', password: 'Alice-Pass-1234' };
const BOB = { login: 'bob@example.test', password: 'Bob-Pass-1234' };

const ctx = (now: Date = T0, over: Partial<AuthnContext> = {}): AuthnContext => ({ now, ip: IP, purpose: 'login', ...over });
const nonEmptyString = (v: unknown): boolean => typeof v === 'string' && v !== '';
const pw = (login: string, password: string): Credentials => ({ kind: 'password', login, password });

describe('AuthnImpersonationService', function () {
  this.timeout(30000);

  useHarnessLog();

  let parts: CoreParts | undefined;

  afterEach(async () => {
    await parts?.dispose();
    parts = undefined;
  });

  interface Booted {
    p: CoreParts;
    svc: AuthnImpersonationService;
    a: IdentityRef;
    b: IdentityRef;
  }

  async function boot(impersonation?: Record<string, unknown>, opts: CoreOptions = {}, authn: Record<string, unknown> = {}): Promise<Booted> {
    parts = await buildCore({}, { ...opts, raw: { authn: { ...authn, ...(impersonation ? { impersonation } : {}), freshAuth: { maxAgeSeconds: 300 } } } });
    const a = parts.identities.add({ login: ALICE.login });
    await parts.passwords.set(a, fakeHash(ALICE.password));
    const b = parts.identities.add({ login: BOB.login });
    await parts.passwords.set(b, fakeHash(BOB.password));
    return { p: parts, svc: await parts.child.resolve(AuthnImpersonationService), a, b };
  }

  const ADMIN: AuthnFacts = { method: 'password', strategy: 'local', assurance: 'aal2', mfa: ['fake'], authenticatedAt: T0 };

  const issue = (p: CoreParts, id: IdentityRef, over: Partial<AuthnFacts> = {}, pending = false): Promise<SessionHandle> => p.sessions.issue(id, { ...ADMIN, ...over }, pending ? { pending: { steps: ['fake'] } } : undefined);

  const events = (p: CoreParts, type: AuthnEventType): readonly AuthnEvent[] => p.events.ofType(type);

  const reasons = (p: CoreParts, type: AuthnEventType): (string | undefined)[] => events(p, type).map((e) => e.reason);

  async function started(b: Booted, now: Date = T0): Promise<{ admin: SessionHandle; imp: SessionHandle }> {
    const admin = await issue(b.p, b.a);
    const r = await b.svc.start(admin, b.b, ctx(now));
    assert.ok(r.ok, 'impersonation starts');
    return { admin, imp: r.session };
  }

  describe('start', () => {
    it('issues a new session for the target that carries the impersonator and revokes the actor session', async () => {
      const booted = await boot();
      const { p, svc, a, b } = booted;
      const admin = await issue(p, a);
      const r = await svc.start(admin, b, ctx(at(10 * SECOND)));
      assert.ok(r.ok);
      assert.notStrictEqual(r.session.id, admin.id);
      assert.strictEqual(r.session.state, 'active');
      assert.strictEqual(await p.sessions.restore(admin.id), null, 'the actor session is revoked');
      const stored = await p.sessions.restore(r.session.id);
      assert.ok(stored);
      assert.deepStrictEqual(stored.identity, b);
      assert.deepStrictEqual(stored.facts.impersonator, { type: 'user', id: a.id });
      assert.deepStrictEqual(stored.data.get(IMPERSONATION_BLOCK), { startedAt: at(10 * SECOND).toISOString() });
      const [e] = events(p, 'impersonation.start');
      assert.strictEqual(e.outcome, 'success');
      assert.deepStrictEqual(e.identity, b);
      assert.deepStrictEqual(e.actor, { type: 'user', id: a.id });
      assert.strictEqual(e.session, stored.facts.sessionHandle);
      assert.strictEqual(e.ip, IP);
      const text = JSON.stringify(p.events.all());
      assert.ok(!text.includes(admin.id) && !text.includes(r.session.id), 'raw session ids never reach an event');
    });

    it('keeps the actor authentication time, method and assurance, so the new session is not fresh because it is new (M6)', async () => {
      const { p, svc, a, b } = await boot();
      const admin = await issue(p, a, { authenticatedAt: at(-200 * SECOND) });
      const r = await svc.start(admin, b, ctx(T0));
      assert.ok(r.ok);
      const stored = await p.sessions.restore(r.session.id);
      const { sessionHandle: _h, ...facts } = stored!.facts;
      assert.deepStrictEqual(facts, { ...ADMIN, authenticatedAt: at(-200 * SECOND), impersonator: { type: 'user', id: a.id } });
    });

    it('asks the guard with the actor principal built through PrincipalFactory', async () => {
      const { p, svc, a, b } = await boot();
      const admin = await issue(p, a);
      assert.ok((await svc.start(admin, b, ctx())).ok);
      assert.strictEqual(p.guard.calls.length, 1);
      const [call] = p.guard.calls;
      assert.strictEqual(call.actor.id, a.id);
      assert.strictEqual(call.actor.authn?.assurance, 'aal2');
      assert.strictEqual(call.actor.authn?.impersonator, undefined);
      assert.strictEqual(call.actor.authn?.sessionHandle, undefined, 'the same facts as on each later request');
      assert.deepStrictEqual(call.target, b);
      assert.ok(p.principals.calls.some((c) => c.id.id === a.id));
    });

    it('refuses what the guard refuses and leaves the actor session intact', async () => {
      const { p, svc, a, b } = await boot();
      const admin = await issue(p, a);
      for (const code of ['forbidden', 'protected_role', 'escalation'] as const) {
        await p.guard.deny(code);
        assert.deepStrictEqual(await svc.start(admin, b, ctx()), { ok: false });
      }
      assert.ok(await p.sessions.restore(admin.id));
      assert.deepStrictEqual(reasons(p, 'impersonation.start'), ['forbidden', 'protected_role', 'escalation']);
      assert.strictEqual((await p.sessions.storage.storedKeys()).length, 1);
    });

    it('refuses when the guard throws', async () => {
      const { p, svc, a, b } = await boot();
      p.guard.allowed = async () => {
        throw new RangeError('authz down');
      };
      const admin = await issue(p, a);
      assert.deepStrictEqual(await svc.start(admin, b, ctx()), { ok: false });
      assert.ok(await p.sessions.restore(admin.id));
      const [e] = events(p, 'impersonation.start');
      assert.strictEqual(e.reason, 'guard_error');
      assert.deepStrictEqual(e.data, { error: 'RangeError' });
    });

    it('is off when no ImpersonationGuard is registered', async () => {
      const { p, svc, a, b } = await boot(undefined, { omit: ['ImpersonationGuard'] });
      const admin = await issue(p, a);
      assert.deepStrictEqual(await svc.start(admin, b, ctx()), { ok: false });
      assert.ok(await p.sessions.restore(admin.id));
      assert.deepStrictEqual(reasons(p, 'impersonation.start'), ['no_guard']);
    });

    it('refuses nesting: an impersonation session cannot start another', async () => {
      const booted = await boot();
      const { p, svc, b } = booted;
      const { imp } = await started(booted);
      const carol = p.identities.add({ login: 'carol@example.test' });
      p.guard.calls.length = 0;
      assert.deepStrictEqual(await svc.start(imp, carol, ctx()), { ok: false });
      assert.ok(await p.sessions.restore(imp.id), 'the impersonation goes on');
      assert.strictEqual(p.guard.calls.length, 0);
      const e = events(p, 'impersonation.start').at(-1);
      assert.strictEqual(e?.reason, 'nested');
      assert.deepStrictEqual(e?.identity, carol);
      assert.deepStrictEqual(e?.actor, b);
    });

    it('refuses self-impersonation', async () => {
      const { p, svc, a } = await boot();
      const admin = await issue(p, a);
      assert.deepStrictEqual(await svc.start(admin, a, ctx()), { ok: false });
      assert.ok(await p.sessions.restore(admin.id));
      assert.deepStrictEqual(reasons(p, 'impersonation.start'), ['self']);
    });

    it('refuses a target whose status does not allow a login, or that is not a user', async () => {
      const { p, svc, a } = await boot();
      const admin = await issue(p, a);
      const banned = p.identities.add({ login: 'x1', status: { banned: true } });
      const deleted = p.identities.add({ login: 'x2', status: { deleted: true } });
      const inactive = p.identities.add({ login: 'x3', status: { active: false } });
      const unknown: IdentityRef = { type: 'user', id: 'nobody' };
      const service = p.identities.add({ type: 'service', login: 'svc' });
      for (const t of [banned, deleted, inactive, unknown, service, { type: 'user', id: '' }, undefined as unknown as IdentityRef]) {
        assert.deepStrictEqual(await svc.start(admin, t, ctx()), { ok: false });
      }
      assert.ok(await p.sessions.restore(admin.id));
      assert.deepStrictEqual(reasons(p, 'impersonation.start'), ['target_banned', 'target_deleted', 'target_inactive', 'target_unknown_identity', 'non_user_target', 'invalid_target', 'invalid_target']);
      assert.strictEqual((await p.sessions.storage.storedKeys()).length, 1);
    });

    it('refuses an actor whose own status no longer allows a login', async () => {
      const { p, svc, a, b } = await boot();
      const admin = await issue(p, a);
      p.identities.setStatus(a, { banned: true });
      assert.deepStrictEqual(await svc.start(admin, b, ctx()), { ok: false });
      assert.deepStrictEqual(reasons(p, 'impersonation.start'), ['banned']);
    });

    it('refuses a pending, an unknown or a malformed session', async () => {
      const { p, svc, a, b } = await boot();
      const pending = await issue(p, a, {}, true);
      for (const s of [pending, { id: 'nope', state: 'active' } as SessionHandle, { id: '' } as SessionHandle, undefined as unknown as SessionHandle]) {
        assert.deepStrictEqual(await svc.start(s, b, ctx()), { ok: false });
      }
      assert.deepStrictEqual(reasons(p, 'impersonation.start'), Array(4).fill('not_active'));
    });

    it('requireMfa (default true) needs an aal2 session; false takes any active session (D2)', async () => {
      let booted = await boot();
      let admin = await issue(booted.p, booted.a, { assurance: 'aal1', mfa: [] });
      assert.deepStrictEqual(await booted.svc.start(admin, booted.b, ctx()), { ok: false });
      assert.deepStrictEqual(reasons(booted.p, 'impersonation.start'), ['mfa_required']);
      await booted.p.dispose();
      booted = await boot({ requireMfa: false });
      admin = await issue(booted.p, booted.a, { assurance: 'aal1', mfa: [] });
      assert.ok((await booted.svc.start(admin, booted.b, ctx())).ok);
    });

    it('requirePassword (default true) needs fresh auth or an inline re-authentication of the actor (D2, A13)', async () => {
      const { p, svc, a, b } = await boot();
      const admin = await issue(p, a);
      const stale = ctx(at(301 * SECOND));
      assert.deepStrictEqual(await svc.start(admin, b, stale), { ok: false });
      assert.deepStrictEqual(await svc.start(admin, b, stale, pw(ALICE.login, 'Wrong-Pass-9876')), { ok: false });
      assert.deepStrictEqual(await svc.start(admin, b, stale, pw(BOB.login, BOB.password)), { ok: false });
      assert.deepStrictEqual(reasons(p, 'impersonation.start'), ['not_fresh', 'not_fresh', 'not_fresh']);
      assert.strictEqual(events(p, 'reauth').filter((e) => e.outcome === 'failure').length, 2);
      assert.ok((await svc.start(admin, b, stale, pw(ALICE.login, ALICE.password))).ok);
    });

    it('requirePassword false takes a stale session', async () => {
      const { p, svc, a, b } = await boot({ requirePassword: false });
      const admin = await issue(p, a);
      assert.ok((await svc.start(admin, b, ctx(at(3600 * SECOND)))).ok);
    });

    it('fails closed when the new session cannot be set up: the new one is revoked, the old one stays', async () => {
      const { p, svc, a, b } = await boot();
      const admin = await issue(p, a);
      p.sessions.set = async () => {
        throw new TypeError('store down');
      };
      assert.deepStrictEqual(await svc.start(admin, b, ctx()), { ok: false });
      assert.ok(await p.sessions.restore(admin.id));
      assert.strictEqual((await p.sessions.storage.storedKeys()).length, 1, 'no impersonation session is left');
      const [e] = events(p, 'impersonation.start');
      assert.strictEqual(e.reason, 'session_error');
      assert.deepStrictEqual(e.data, { error: 'TypeError' });
    });

    it('fails closed when the old session cannot be revoked: the new one is revoked, the old one stays', async () => {
      const { p, svc, a, b } = await boot();
      const admin = await issue(p, a);
      const revoke = p.sessions.revoke.bind(p.sessions);
      p.sessions.revoke = async (h) => {
        if (h.id === admin.id) throw new TypeError('store down');
        return revoke(h);
      };
      assert.deepStrictEqual(await svc.start(admin, b, ctx()), { ok: false });
      assert.ok(await p.sessions.restore(admin.id));
      assert.strictEqual((await p.sessions.storage.storedKeys()).length, 1, 'no impersonation session is left');
      const [e] = events(p, 'impersonation.start');
      assert.strictEqual(e.reason, 'session_error');
      assert.deepStrictEqual(e.data, { error: 'TypeError' });
    });

    it('lets one of two parallel starts on one session through (M2)', async () => {
      const { p, svc, a, b } = await boot();
      const carol = p.identities.add({ login: 'carol@example.test' });
      const admin = await issue(p, a);
      const rs = await Promise.all([svc.start(admin, b, ctx()), svc.start(admin, carol, ctx())]);
      assert.strictEqual(rs.filter((r) => r.ok).length, 1);
      assert.strictEqual((await p.sessions.storage.storedKeys()).length, 1, 'one impersonation session, no actor session');
      assert.deepStrictEqual(reasons(p, 'impersonation.start'), [undefined, 'not_active']);
    });

    it('cannot renew the session lifetime of the original login by cycling start and stop (I1)', async () => {
      const { p, svc, a, b } = await boot({ requirePassword: false }, {}, { session: { expiration: { maxLifetime: 120 } } });
      let session = await issue(p, a);
      for (const m of [0, 25, 50, 75]) {
        const r = await svc.start(session, b, ctx(at(m * MINUTE)));
        assert.ok(r.ok, `start at ${m} min`);
        const back = await svc.stop(r.session, ctx(at((m + 20) * MINUTE)));
        assert.ok(back, `stop at ${m + 20} min`);
        session = back;
      }
      const r = await svc.start(session, b, ctx(at(100 * MINUTE)));
      assert.ok(r.ok);
      assert.strictEqual(await svc.stop(r.session, ctx(at(120 * MINUTE))), null, 'no new session once the login is maxLifetime old');
      assert.strictEqual(await p.sessions.restore(r.session.id), null);
      assert.strictEqual(reasons(p, 'impersonation.end').at(-1), 'session_lifetime');
      const late = await issue(p, a);
      assert.deepStrictEqual(await svc.start(late, b, ctx(at(120 * MINUTE))), { ok: false });
      assert.strictEqual(reasons(p, 'impersonation.start').at(-1), 'session_lifetime');
      assert.ok(await p.sessions.restore(late.id));
    });

    it('does not escape an endFor of the actor that runs while it starts (R2)', async () => {
      const { p, svc, a, b } = await boot();
      const admin = await issue(p, a);
      const issueNow = p.sessions.issue.bind(p.sessions);
      p.sessions.issue = async (id, facts, opts) => {
        await svc.endFor(a);
        return issueNow(id, facts, opts);
      };
      assert.deepStrictEqual(await svc.start(admin, b, ctx()), { ok: false });
      assert.deepStrictEqual(await p.sessions.storage.storedKeys(), [], 'no session of the actor or of its impersonation lives');
      assert.strictEqual(reasons(p, 'impersonation.start').at(-1), 'revoked');
    });
  });

  describe('stop', () => {
    it('issues a new session for the impersonator with the facts before the start and revokes the impersonation', async () => {
      const booted = await boot();
      const { p, svc, a, b } = booted;
      const { imp } = await started(booted);
      const back = await svc.stop(imp, ctx(at(5 * MINUTE)));
      assert.ok(back);
      assert.notStrictEqual(back.id, imp.id);
      assert.strictEqual(await p.sessions.restore(imp.id), null);
      const stored = await p.sessions.restore(back.id);
      assert.deepStrictEqual(stored?.identity, a);
      const { sessionHandle: _h, ...facts } = stored!.facts;
      assert.deepStrictEqual(facts, ADMIN);
      assert.strictEqual(stored?.data.get(IMPERSONATION_BLOCK), undefined);
      const [e] = events(p, 'impersonation.end');
      assert.strictEqual(e.outcome, 'success');
      assert.deepStrictEqual(e.identity, b);
      assert.deepStrictEqual(e.actor, { type: 'user', id: a.id });
      assert.strictEqual(e.session, stored?.facts.sessionHandle);
    });

    it('answers null on a session that does not impersonate and leaves it alone', async () => {
      const { p, svc, a } = await boot();
      const own = await issue(p, a);
      const pending = await issue(p, a, {}, true);
      for (const s of [own, pending, { id: 'nope', state: 'active' } as SessionHandle, undefined as unknown as SessionHandle]) {
        assert.strictEqual(await svc.stop(s, ctx()), null);
      }
      assert.ok(await p.sessions.restore(own.id));
      assert.deepStrictEqual(reasons(p, 'impersonation.end'), ['not_impersonating', 'not_active', 'not_active', 'not_active']);
    });

    it('gives no session to an impersonator who was banned meanwhile and ends the impersonation', async () => {
      const booted = await boot();
      const { p, svc, a } = booted;
      const { imp } = await started(booted);
      p.identities.setStatus(a, { banned: true });
      assert.strictEqual(await svc.stop(imp, ctx()), null);
      assert.strictEqual(await p.sessions.restore(imp.id), null);
      assert.deepStrictEqual(reasons(p, 'impersonation.end'), ['impersonator_banned']);
      assert.strictEqual((await p.sessions.storage.storedKeys()).length, 0);
    });

    it('treats an expired impersonation as over', async () => {
      const booted = await boot({ maxMinutes: 10 });
      const { p, svc } = booted;
      const { imp } = await started(booted);
      assert.strictEqual(await svc.stop(imp, ctx(at(10 * MINUTE))), null);
      assert.strictEqual(await p.sessions.restore(imp.id), null);
      assert.strictEqual(events(p, 'impersonation.expire').length, 1);
    });

    it('ends an impersonation whose start time is unreadable (M1)', async () => {
      const booted = await boot();
      const { p, svc } = booted;
      const { imp } = await started(booted);
      await p.sessions.set(imp, IMPERSONATION_BLOCK, { startedAt: at(10 * 60 * MINUTE).toISOString() });
      assert.strictEqual(await svc.stop(imp, ctx(at(MINUTE))), null);
      assert.strictEqual(await p.sessions.restore(imp.id), null);
      assert.deepStrictEqual(reasons(p, 'impersonation.end'), ['invalid_block']);
    });

    it('fails closed when the impersonation session cannot be revoked: the new session is revoked (M3)', async () => {
      const booted = await boot();
      const { p, svc } = booted;
      const { imp } = await started(booted);
      const revoke = p.sessions.revoke.bind(p.sessions);
      p.sessions.revoke = async (h) => {
        if (h.id === imp.id) throw new TypeError('store down');
        return revoke(h);
      };
      assert.strictEqual(await svc.stop(imp, ctx()), null);
      assert.ok(await p.sessions.restore(imp.id), 'the impersonation goes on');
      assert.strictEqual((await p.sessions.storage.storedKeys()).length, 1, 'no impersonator session is left');
      const e = events(p, 'impersonation.end').at(-1);
      assert.strictEqual(e?.reason, 'session_error');
      assert.deepStrictEqual(e?.data, { error: 'TypeError' });
    });

    it('lets one of two parallel stops through (M2)', async () => {
      const booted = await boot();
      const { p, svc } = booted;
      const { imp } = await started(booted);
      const rs = await Promise.all([svc.stop(imp, ctx()), svc.stop(imp, ctx())]);
      assert.strictEqual(rs.filter((r) => r !== null).length, 1);
      assert.strictEqual((await p.sessions.storage.storedKeys()).length, 1);
    });

    it('does not escape an endFor of the impersonator that runs while it stops (R2)', async () => {
      const booted = await boot();
      const { p, svc, a } = booted;
      const { imp } = await started(booted);
      const issueNow = p.sessions.issue.bind(p.sessions);
      p.sessions.issue = async (id, facts, opts) => {
        await svc.endFor(a);
        return issueNow(id, facts, opts);
      };
      assert.strictEqual(await svc.stop(imp, ctx()), null);
      assert.deepStrictEqual(await p.sessions.storage.storedKeys(), [], 'no session of the impersonator lives');
      const e = events(p, 'impersonation.end').at(-1);
      assert.strictEqual(e?.outcome, 'failure');
      assert.strictEqual(e?.reason, 'revoked');
    });
  });

  describe('principalOf', () => {
    it('ends the session stop handed back once the original login is maxLifetime old (R1)', async () => {
      const { p, svc, a, b } = await boot({ requirePassword: false }, {}, { session: { expiration: { maxLifetime: 120 } } });
      const admin = await issue(p, a);
      const r = await svc.start(admin, b, ctx(at(100 * MINUTE)));
      assert.ok(r.ok);
      const back = await svc.stop(r.session, ctx(at(119 * MINUTE)));
      assert.ok(back);
      assert.strictEqual((await svc.principalOf(back, ctx(at(120 * MINUTE - 1))))?.id, a.id);
      assert.strictEqual(await svc.principalOf(back, ctx(at(120 * MINUTE))), null);
      assert.strictEqual(await p.sessions.restore(back.id), null, 'the session is revoked');
      const [e] = events(p, 'session.expire');
      assert.strictEqual(e.reason, 'session_lifetime');
      assert.deepStrictEqual(e.identity, a);
      assert.ok(nonEmptyString(e.session));
    });

    it('still resolves a migrated 2.x session within its lifetime (R1)', async () => {
      const { p, svc, a } = await boot();
      const rawId = randomUUID();
      const creation = new Date();
      await p.sessions.storage.seedLegacy({ rawId, user: a.id, authorized: true, creation });
      const s: SessionHandle = { id: rawId, state: 'active' };
      assert.strictEqual((await svc.principalOf(s, ctx(new Date(creation.getTime() + 60 * MINUTE))))?.id, a.id);
      assert.strictEqual(await svc.principalOf(s, ctx(new Date(creation.getTime() + 480 * MINUTE))), null);
    });

    it('answers null for a pending, unknown or malformed session', async () => {
      const { p, svc, a } = await boot();
      const pending = await issue(p, a, {}, true);
      for (const s of [pending, { id: 'nope', state: 'active' } as SessionHandle, undefined as unknown as SessionHandle]) {
        assert.strictEqual(await svc.principalOf(s, ctx()), null);
      }
    });

    it('resolves an ordinary session to its identity, with the status checked', async () => {
      const { p, svc, a } = await boot();
      const own = await issue(p, a);
      const pr = await svc.principalOf(own, ctx());
      assert.strictEqual(pr?.id, a.id);
      assert.strictEqual(pr?.authn?.impersonator, undefined);
      p.identities.setStatus(a, { banned: true });
      assert.strictEqual(await svc.principalOf(own, ctx()), null);
    });

    it('resolves an impersonation session to the target with authn.impersonator, the guard asked again', async () => {
      const booted = await boot();
      const { p, svc, a, b } = booted;
      const { imp } = await started(booted);
      p.guard.calls.length = 0;
      const pr = await svc.principalOf(imp, ctx(at(MINUTE)));
      assert.strictEqual(pr?.id, b.id);
      assert.deepStrictEqual(pr?.authn?.impersonator, { type: 'user', id: a.id });
      assert.strictEqual(p.guard.calls.length, 1);
      assert.strictEqual(p.guard.calls[0].actor.id, a.id);
      assert.strictEqual(p.guard.calls[0].actor.authn?.impersonator, undefined);
    });

    it('ends the impersonation once maxMinutes have passed (SR-06)', async () => {
      const booted = await boot({ maxMinutes: 60 });
      const { p, svc, a, b } = booted;
      const { imp } = await started(booted);
      assert.strictEqual((await svc.principalOf(imp, ctx(at(60 * MINUTE - 1))))?.id, b.id);
      assert.strictEqual(await svc.principalOf(imp, ctx(at(60 * MINUTE))), null);
      assert.strictEqual(await p.sessions.restore(imp.id), null, 'the session is revoked');
      const [e] = events(p, 'impersonation.expire');
      assert.deepStrictEqual(e.identity, b);
      assert.deepStrictEqual(e.actor, { type: 'user', id: a.id });
    });

    it('takes the session authentication time as the start when the impersonation block is missing', async () => {
      const { p, svc, a, b } = await boot({ maxMinutes: 60 });
      const imp = await issue(p, b, { impersonator: { type: 'user', id: a.id } });
      assert.strictEqual((await svc.principalOf(imp, ctx(at(59 * MINUTE))))?.id, b.id);
      assert.strictEqual(await svc.principalOf(imp, ctx(at(60 * MINUTE))), null);
      assert.strictEqual(events(p, 'impersonation.expire').length, 1);
    });

    for (const [flag, reason] of [
      [{ banned: true }, 'impersonator_banned'],
      [{ deleted: true }, 'impersonator_deleted'],
      [{ active: false }, 'impersonator_inactive'],
    ] as const) {
      it(`ends the impersonation when the impersonator is ${reason.slice(13)} (SR-06)`, async () => {
        const booted = await boot();
        const { p, svc, a } = booted;
        const { imp } = await started(booted);
        p.identities.setStatus(a, flag);
        assert.strictEqual(await svc.principalOf(imp, ctx()), null);
        assert.strictEqual(await p.sessions.restore(imp.id), null);
        assert.deepStrictEqual(reasons(p, 'impersonation.end'), [reason]);
      });
    }

    it('ends the impersonation when the guard refuses or throws now', async () => {
      let booted = await boot();
      let { imp } = await started(booted);
      await booted.p.guard.deny('forbidden');
      assert.strictEqual(await booted.svc.principalOf(imp, ctx()), null);
      assert.strictEqual(await booted.p.sessions.restore(imp.id), null);
      assert.deepStrictEqual(reasons(booted.p, 'impersonation.end'), ['forbidden']);
      await booted.p.dispose();
      booted = await boot();
      ({ imp } = await started(booted));
      booted.p.guard.allowed = async () => {
        throw new RangeError('authz down');
      };
      assert.strictEqual(await booted.svc.principalOf(imp, ctx()), null);
      assert.deepStrictEqual(reasons(booted.p, 'impersonation.end'), ['guard_error']);
    });

    it('ends the impersonation when the target may no longer log in', async () => {
      const booted = await boot();
      const { p, svc, b } = booted;
      const { imp } = await started(booted);
      p.identities.setStatus(b, { banned: true });
      assert.strictEqual(await svc.principalOf(imp, ctx()), null);
      assert.strictEqual(await p.sessions.restore(imp.id), null);
      assert.deepStrictEqual(reasons(p, 'impersonation.end'), ['target_banned']);
    });

    it('tolerates 30 s of clock skew between instances on the start time (m2)', async () => {
      const booted = await boot();
      const { p, svc, b } = booted;
      const { imp } = await started(booted, at(30 * SECOND));
      assert.strictEqual((await svc.principalOf(imp, ctx(T0)))?.id, b.id, 'read on an instance 30 s behind');
      await p.sessions.set(imp, IMPERSONATION_BLOCK, { startedAt: at(-30 * SECOND).toISOString() });
      assert.strictEqual((await svc.principalOf(imp, ctx(T0)))?.id, b.id, 'a start 30 s before the login');
      await p.sessions.set(imp, IMPERSONATION_BLOCK, { startedAt: at(30 * SECOND + 1).toISOString() });
      assert.strictEqual(await svc.principalOf(imp, ctx(T0)), null, 'beyond the tolerance');
      assert.deepStrictEqual(reasons(p, 'impersonation.end'), ['invalid_block']);
    });

    for (const [label, block] of [
      ['a start in the future', { startedAt: at(10 * 60 * MINUTE).toISOString() }],
      ['a start before the login', { startedAt: at(-MINUTE).toISOString() }],
      ['a start that is no date', { startedAt: 'soon' }],
      ['a start that is no string', { startedAt: 42 }],
      ['a block that is no object', 'started'],
    ] as const) {
      it(`ends the impersonation on ${label} (M1)`, async () => {
        const booted = await boot();
        const { p, svc } = booted;
        const { imp } = await started(booted);
        await p.sessions.set(imp, IMPERSONATION_BLOCK, block);
        assert.strictEqual(await svc.principalOf(imp, ctx(at(MINUTE))), null);
        assert.strictEqual(await p.sessions.restore(imp.id), null);
        assert.deepStrictEqual(reasons(p, 'impersonation.end'), ['invalid_block']);
      });
    }

    it('ends the impersonation once the original login is maxLifetime old, 480 min by default (I1)', async () => {
      const { p, svc, a, b } = await boot({ maxMinutes: 1000 });
      const imp = await issue(p, b, { impersonator: { type: 'user', id: a.id } });
      assert.strictEqual((await svc.principalOf(imp, ctx(at(480 * MINUTE - 1))))?.id, b.id);
      assert.strictEqual(await svc.principalOf(imp, ctx(at(480 * MINUTE))), null);
      assert.strictEqual(await p.sessions.restore(imp.id), null);
      assert.deepStrictEqual(reasons(p, 'impersonation.end'), ['session_lifetime']);
    });

    it('rejects when a store fails, rather than answering for anyone (M3)', async () => {
      const booted = await boot();
      const { p, svc } = booted;
      const { imp } = await started(booted);
      p.identities.status = async () => {
        throw new RangeError('store down');
      };
      await assert.rejects(svc.principalOf(imp, ctx()), RangeError);
    });
  });

  describe('endFor', () => {
    it('revokes the impersonator sessions and the impersonations they started, not the target own sessions', async () => {
      const booted = await boot();
      const { p, svc, a, b } = booted;
      const { imp } = await started(booted);
      const second = await issue(p, a);
      const kept = await issue(p, a);
      const bobOwn = await issue(p, b);
      assert.strictEqual(await svc.endFor(a, { except: kept }), 2);
      assert.strictEqual(await p.sessions.restore(imp.id), null);
      assert.strictEqual(await p.sessions.restore(second.id), null);
      assert.ok(await p.sessions.restore(kept.id));
      assert.ok(await p.sessions.restore(bobOwn.id));
      assert.strictEqual(await svc.endFor(a), 1);
    });
  });

  describe('fresh auth on an impersonation session (M6)', () => {
    it('is never fresh, and no inline password makes it so', async () => {
      const booted = await boot();
      const { p, a } = booted;
      const { imp } = await started(booted);
      const stored = await p.sessions.restore(imp.id);
      assert.strictEqual(isFresh(stored!.facts, T0, 300), false);
      assert.strictEqual(isFresh({ authenticatedAt: T0 }, T0, 300), true);
      const fresh = await p.child.resolve(FreshAuthCheck);
      const c = ctx(T0, { purpose: 'reauth', session: imp });
      assert.strictEqual(await fresh.check(imp, c), false);
      assert.strictEqual(await fresh.check(imp, c, pw(ALICE.login, ALICE.password)), false);
      assert.strictEqual(await fresh.check(imp, c, pw(BOB.login, BOB.password)), false);
      assert.ok(a);
    });
  });

  describe('boot', () => {
    it('takes the impersonation defaults from the schema when authn.impersonation is unset', async () => {
      const { p } = await boot();
      assert.deepStrictEqual(p.configuration.get('authn.impersonation'), { requirePassword: true, requireMfa: true, maxMinutes: 60 });
    });

    it('takes what the schema coerces: a numeric string and boolean strings', async () => {
      const { p } = await boot({ maxMinutes: '30', requirePassword: 'false', requireMfa: 'true' });
      assert.deepStrictEqual(p.configuration.get('authn.impersonation'), { requirePassword: false, requireMfa: true, maxMinutes: 30 });
    });

    it('refuses malformed settings, naming the path of each', async () => {
      const cases: [unknown, string][] = [
        [{ maxMinutes: 0 }, 'authn.impersonation.maxMinutes'],
        [{ maxMinutes: 1.5 }, 'authn.impersonation.maxMinutes'],
        [{ requireMfa: 'yes' }, 'authn.impersonation.requireMfa'],
        ['on', 'authn.impersonation'],
      ];
      for (const [bad, path] of cases) {
        const paths = await violationPaths(boot(bad as Record<string, unknown>));
        assert.ok(paths.includes(path), `${JSON.stringify(bad)}: ${paths.join(', ')}`);
      }
      for (const bad of [0, -5, 1.5, 'abc']) {
        const paths = await violationPaths(boot(undefined, {}, { session: { expiration: { maxLifetime: bad } } }));
        assert.ok(paths.includes('authn.session.expiration.maxLifetime'), `${String(bad)}: ${paths.join(', ')}`);
      }
    });

    it('reads maxMinutes when it uses it, not at boot', async () => {
      const booted = await boot({ maxMinutes: 60 });
      const { p, svc } = booted;
      const { imp } = await started(booted);
      p.configuration.set('authn.impersonation.maxMinutes', 10);
      assert.strictEqual(await svc.principalOf(imp, ctx(at(10 * MINUTE))), null);
      assert.strictEqual(events(p, 'impersonation.expire').length, 1);
    });

    it('is one per container and does not collide with the 2.x ImpersonationService of authn-http', async () => {
      // DI keys registrations and instances by class name; authn-http registers a class named ImpersonationService.
      const Legacy = { ImpersonationService: class {} }.ImpersonationService;
      const { p, svc } = await boot(undefined, { register: (c) => c.register(Legacy).asSelf() });
      assert.ok(!((await p.child.resolve(Legacy)) instanceof AuthnImpersonationService));
      assert.strictEqual(await p.child.resolve(AuthnImpersonationService), svc);
      const second = await buildCore();
      try {
        assert.notStrictEqual(await second.child.resolve(AuthnImpersonationService), svc);
      } finally {
        await second.dispose();
      }
    });
  });
});
