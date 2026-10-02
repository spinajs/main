import assert from 'node:assert/strict';
import type { IdentityRef, SessionHandle } from '@spinajs/authn/contracts';
import type { ProbeBody } from '../harness/http.js';
import type { CookieJar } from '../helpers/cookies.js';
import { ALICE, BOB, auth, expectMfaRequired, expectSuccess, hasEvent, in4xx, probe, pw, routes, seedUser, send, sessionJar } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit, HarnessWith } from './types.js';

/**
 * requirePassword is satisfied by fresh authentication (within freshAuth.maxAgeSeconds) or an inline re-authentication,
 * as FreshAuth in authn-http/src/api.ts defines it; the success rows below send no password and rely on the first.
 */
const PINNED = { requireMfa: true, requirePassword: true };
const BASE = { authn: { impersonation: PINNED } };
const FRESH_300 = { authn: { impersonation: PINNED, freshAuth: { maxAgeSeconds: 300 } } };
const MAX_60 = { authn: { impersonation: { ...PINNED, maxMinutes: 60 } } };

/** ALICE with MFA, logged in and elevated: an aal2, fresh session that can impersonate BOB. */
async function adminSession(h: HarnessWith<'service' | 'seed' | 'mfa'>, k: CaseKit): Promise<{ a: IdentityRef; b: IdentityRef; session: SessionHandle }> {
  const a = await seedUser(h, ALICE);
  await h.mfa.enrol(a);
  const r = await auth(h, k, pw(ALICE.login, ALICE.password));
  expectMfaRequired(r);
  const s = await h.service.completeMfa(r.pending, h.mfa.step.name, await h.mfa.code(a), k.ctx());
  expectSuccess(s);
  assert.ok(s.session, 'completeMfa returns the session');
  const b = await seedUser(h, BOB);
  return { a, b, session: s.session };
}

/** ALICE with MFA, logged in over HTTP: a jar holding the active aal2 session. */
async function adminJar(h: HarnessWith<'http' | 'seed' | 'mfa' | 'http.routes.login' | 'http.routes.mfaVerify'>, k: CaseKit): Promise<{ a: IdentityRef; jar: CookieJar }> {
  const a = await seedUser(h, ALICE);
  await h.mfa.enrol(a);
  const jar = k.jar();
  assert.strictEqual((await send(h, routes(h).login(ALICE.login, ALICE.password), jar)).status, 200);
  const res = await send(h, routes(h).mfaVerify(await h.mfa.code(a)), jar);
  assert.strictEqual(res.status, 200, `mfaVerify answered ${res.status}`);
  return { a, jar };
}

const probePrincipal = async (h: HarnessWith<'http'>, jar: CookieJar) => ((await send(h, probe(h, 'GET'), jar)).body as ProbeBody).principal;

const notTarget = (p: { id: string } | null, b: IdentityRef): boolean => p === null || p.id !== b.id;

const HTTP_ROWS = [
  { label: 'fresh', staleSeconds: 0, session: true, ok: true },
  { label: 'stale without a password', staleSeconds: 301, session: true, ok: false },
  { label: 'no session', staleSeconds: 0, session: false, ok: false },
] as const;

export const A20: AuthnRule = defineRule('A20', 'impersonation is guarded, rotated, bounded and audited', [
  defineCase({
    name: 'A20 start rotates into a session whose principal carries authn.impersonator',
    facet: 'A20/core',
    needs: ['impersonation', 'service', 'sessions', 'seed', 'mfa', 'guard', 'events'],
    config: BASE,
    async run(h, k) {
      const { a, b, session } = await adminSession(h, k);
      const r = await h.impersonation.start(session, b, k.ctx());
      assert.ok(r.ok, 'impersonation starts');
      assert.ok(r.session.id !== session.id, 'the id rotates');
      assert.strictEqual(await h.sessions.restore(session.id), null, 'the old session is revoked');
      const p = await h.impersonation.principalOf(r.session, k.ctx());
      assert.ok(p, 'the new session resolves to a principal');
      assert.strictEqual(p.id, b.id);
      assert.deepStrictEqual(p.authn?.impersonator, { type: 'user', id: a.id });
      assert.ok(
        h.events.all().some((e) => e.type === 'impersonation.start' && e.identity?.id === b.id && e.actor?.id === a.id),
        'an impersonation.start event for the target with the actor',
      );
    },
  }),
  defineCase({
    name: 'A20 the guard decides',
    facet: 'A20/core',
    needs: ['impersonation', 'service', 'seed', 'mfa', 'guard', 'sessions'],
    config: BASE,
    async run(h, k) {
      const { b, session } = await adminSession(h, k);
      await h.guard.deny('forbidden');
      assert.strictEqual((await h.impersonation.start(session, b, k.ctx())).ok, false);
      assert.ok(await h.sessions.restore(session.id), 'the admin session survives');
    },
  }),
  defineCase({
    name: 'A20 start needs fresh auth',
    facet: 'A20/core',
    needs: ['impersonation', 'service', 'seed', 'mfa', 'guard', 'fakeDate'],
    config: FRESH_300,
    async run(h, k) {
      const { b, session } = await adminSession(h, k);
      k.clock.tick(301_000);
      assert.strictEqual((await h.impersonation.start(session, b, k.ctx())).ok, false, 'a stale session without a password');
      assert.strictEqual((await h.impersonation.start(session, b, k.ctx(), pw(ALICE.login, ALICE.password))).ok, true, 'a stale session with an inline password');
    },
  }),
  defineCase({
    name: 'A20 stop issues a new session for the impersonator',
    facet: 'A20/core',
    needs: ['impersonation', 'service', 'seed', 'mfa', 'guard', 'events', 'sessions'],
    config: BASE,
    async run(h, k) {
      const { a, b, session } = await adminSession(h, k);
      const r = await h.impersonation.start(session, b, k.ctx());
      assert.ok(r.ok, 'impersonation starts');
      const back = await h.impersonation.stop(r.session, k.ctx());
      assert.ok(back, 'stop returns the impersonator session');
      assert.ok(back.id !== r.session.id, 'the id rotates');
      assert.strictEqual(await h.sessions.restore(r.session.id), null, 'the impersonation session is revoked');
      const p = await h.impersonation.principalOf(back, k.ctx());
      assert.strictEqual(p?.id, a.id);
      assert.strictEqual(p?.authn?.impersonator, undefined);
      assert.ok(hasEvent(h.events, 'impersonation.end'), 'an impersonation.end event');
    },
  }),
  defineCase({
    name: 'A20 SR-06 impersonation expires after maxMinutes',
    facet: 'A20/core',
    needs: ['impersonation', 'service', 'seed', 'mfa', 'guard', 'events', 'fakeDate'],
    config: MAX_60,
    async run(h, k) {
      const { b, session } = await adminSession(h, k);
      const r = await h.impersonation.start(session, b, k.ctx());
      assert.ok(r.ok, 'impersonation starts');
      for (const minutes of [20, 20, 19]) {
        k.clock.tick(minutes * 60_000);
        assert.strictEqual((await h.impersonation.principalOf(r.session, k.ctx()))?.id, b.id, `still the target after +${minutes} min`);
      }
      k.clock.tick(2 * 60_000);
      const p = await h.impersonation.principalOf(r.session, k.ctx());
      assert.ok(p === null || p.authn?.impersonator === undefined, 'no impersonation after 61 min');
      assert.ok(hasEvent(h.events, 'impersonation.expire'), 'an impersonation.expire event');
    },
  }),
  defineCase({
    name: 'A20 SR-06 banning the impersonator ends the impersonation',
    facet: 'A20/core',
    needs: ['impersonation', 'service', 'seed', 'mfa', 'guard'],
    config: BASE,
    async run(h, k) {
      const { a, b, session } = await adminSession(h, k);
      const r = await h.impersonation.start(session, b, k.ctx());
      assert.ok(r.ok, 'impersonation starts');
      await h.seed.setStatus(a, { banned: true });
      assert.ok(notTarget(await h.impersonation.principalOf(r.session, k.ctx()), b), 'the session no longer acts as the target');
    },
  }),
  defineCase({
    name: 'A20 losing the right to impersonate ends it on the next request',
    facet: 'A20/core',
    needs: ['impersonation', 'service', 'seed', 'mfa', 'guard'],
    config: BASE,
    async run(h, k) {
      const { b, session } = await adminSession(h, k);
      const r = await h.impersonation.start(session, b, k.ctx());
      assert.ok(r.ok, 'impersonation starts');
      await h.guard.deny('forbidden');
      assert.ok(notTarget(await h.impersonation.principalOf(r.session, k.ctx()), b), 'the session no longer acts as the target');
    },
  }),
  table(HTTP_ROWS, (row) =>
    defineCase({
      name: `A20 impersonation over HTTP: ${row.label}`,
      facet: 'A20/http',
      needs: ['http', 'http.routes.login', 'http.routes.mfaVerify', 'http.routes.impersonateStart', 'seed', 'mfa', 'guard', 'fakeDate'],
      config: FRESH_300,
      async run(h, k) {
        const b = await seedUser(h, BOB);
        const { a, jar } = row.session ? await adminJar(h, k) : { a: undefined, jar: k.jar() };
        const before = jar.get(h.http.sessionCookie);
        k.clock.tick(row.staleSeconds * 1000);
        const res = await send(h, routes(h).impersonateStart(b), jar);
        if (!row.ok) {
          assert.ok(in4xx(res.status), `impersonation answered ${res.status}`);
          return;
        }
        assert.ok(res.status >= 200 && res.status < 300, `impersonation answered ${res.status}`);
        const after = jar.get(h.http.sessionCookie);
        assert.ok(after && after !== before, 'a new cookie value');
        const p = await probePrincipal(h, jar);
        assert.strictEqual(p?.id, b.id);
        assert.strictEqual(p?.authn?.impersonator?.id, a?.id);
      },
    }),
  ),
  defineCase({
    name: 'A20 logout during impersonation ends it',
    facet: 'A20/http',
    needs: ['http', 'http.routes.login', 'http.routes.mfaVerify', 'http.routes.impersonateStart', 'http.routes.logout', 'seed', 'mfa', 'guard'],
    config: BASE,
    async run(h, k) {
      const b = await seedUser(h, BOB);
      const { jar } = await adminJar(h, k);
      const start = await send(h, routes(h).impersonateStart(b), jar);
      assert.ok(start.status >= 200 && start.status < 300, `impersonation answered ${start.status}`);
      const cookie = jar.get(h.http.sessionCookie);
      assert.ok(cookie, 'the impersonation session cookie');
      await send(h, routes(h).logout(), jar);
      assert.strictEqual(await probePrincipal(h, sessionJar(h, cookie)), null);
    },
  }),
]);
