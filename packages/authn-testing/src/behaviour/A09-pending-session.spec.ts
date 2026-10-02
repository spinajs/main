import assert from 'node:assert/strict';
import type { AuthenticationResult, IdentityRef } from '@spinajs/authn/contracts';
import type { HttpRequest, HttpRoutes, ProbeBody } from '../harness/http.js';
import type { Harness } from '../harness/ports.js';
import type { CookieJar } from '../helpers/cookies.js';
import { ALICE, BOB, auth, expectFail, expectFailOrReject, expectMfaRequired, expectSuccess, factsAal1, hasEvent, in4xx, probe, pw, routes, seedUser, send } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit } from './types.js';

type Pending = Extract<AuthenticationResult, { status: 'mfa_required' }>;
type WithMfa = Harness & Required<Pick<Harness, 'service' | 'seed' | 'mfa'>>;
type WithHttp = Harness & Required<Pick<Harness, 'http' | 'seed' | 'mfa'>>;

/** ALICE enrolled and logged in: a pending session. */
async function pendingLogin(h: WithMfa, k: CaseKit): Promise<{ a: IdentityRef; r: Pending }> {
  const a = await seedUser(h, ALICE);
  await h.mfa.enrol(a);
  const r = await auth(h, k, pw(ALICE.login, ALICE.password));
  expectMfaRequired(r);
  return { a, r };
}

/** ALICE enrolled and logged in over HTTP: a jar holding the pending session cookie. */
async function pendingJar(h: WithHttp, k: CaseKit) {
  const a = await seedUser(h, ALICE);
  await h.mfa.enrol(a);
  const jar = k.jar();
  const res = await send(h, routes(h).login(ALICE.login, ALICE.password), jar);
  assert.strictEqual(res.status, 200, `pending login answered ${res.status}`);
  assert.ok(jar.get(h.http.sessionCookie), 'the pending login sets the session cookie');
  return { a, jar };
}

const probePrincipal = async (h: WithHttp, jar: CookieJar) => ((await send(h, probe(h, 'GET'), jar)).body as ProbeBody).principal;

interface RouteRow {
  readonly label: 'sessionsList' | 'tokenList' | 'activeRoleSet';
  readonly req: (R: HttpRoutes) => HttpRequest;
}

const ROUTE_ROWS: readonly RouteRow[] = [
  { label: 'sessionsList', req: (R) => R.sessionsList() },
  { label: 'tokenList', req: (R) => R.tokenList() },
  { label: 'activeRoleSet', req: (R) => R.activeRoleSet('kit-role') },
];

const PENDING_TTL_300 = { authn: { session: { pendingTtlSeconds: 300 } } };

export const A09: AuthnRule = defineRule('A09', 'a session before MFA is pending and yields no principal', [
  defineCase({
    name: 'A09 a login with MFA required returns a pending session',
    facet: 'A09/core',
    needs: ['service', 'seed', 'mfa', 'events'],
    async run(h, k) {
      const { r } = await pendingLogin(h, k);
      assert.strictEqual(r.pending.state, 'pending');
      assert.deepStrictEqual([...r.steps], [h.mfa.step.name]);
      assert.ok(hasEvent(h.events, 'mfa.challenge'), 'an mfa.challenge event');
    },
  }),
  defineCase({
    name: 'A09 completeMfa with a valid code elevates to aal2 and rotates',
    facet: 'A09/core',
    needs: ['service', 'seed', 'mfa', 'sessions'],
    async run(h, k) {
      const { a, r } = await pendingLogin(h, k);
      const s = await h.service.completeMfa(r.pending, h.mfa.step.name, await h.mfa.code(a), k.ctx());
      expectSuccess(s);
      assert.ok(s.session, 'completeMfa returns the session');
      assert.strictEqual(s.session.state, 'active');
      assert.ok(s.session.id !== r.pending.id, 'the id rotates');
      assert.strictEqual(s.facts.assurance, 'aal2');
      assert.deepStrictEqual([...s.facts.mfa], [h.mfa.step.name]);
      assert.strictEqual(await h.sessions.restore(r.pending.id), null, 'the pending id is dead');
    },
  }),
  defineCase({
    name: 'A09 completeMfa with a wrong code keeps the session pending',
    facet: 'A09/core',
    needs: ['service', 'seed', 'mfa', 'sessions', 'events'],
    async run(h, k) {
      const { r } = await pendingLogin(h, k);
      expectFail(await h.service.completeMfa(r.pending, h.mfa.step.name, 'kit-wrong', k.ctx()));
      assert.strictEqual((await h.sessions.restore(r.pending.id))?.handle.state, 'pending');
      assert.ok(hasEvent(h.events, 'mfa.verify', 'failure'), 'an mfa.verify failure event');
    },
  }),
  defineCase({
    name: 'A09 completeMfa refuses an active session',
    facet: 'A09/core',
    needs: ['service', 'seed', 'mfa'],
    async run(h, k) {
      const b = await seedUser(h, BOB);
      const r = await auth(h, k, pw(BOB.login, BOB.password));
      expectSuccess(r);
      assert.ok(r.session, 'an interactive login issues a session');
      await h.mfa.enrol(b);
      await expectFailOrReject(h.service.completeMfa(r.session, h.mfa.step.name, await h.mfa.code(b), k.ctx()));
    },
  }),
  defineCase({
    name: 'A09 completeMfa with an unknown step fails',
    facet: 'A09/core',
    needs: ['service', 'seed', 'mfa'],
    async run(h, k) {
      const { r } = await pendingLogin(h, k);
      expectFail(await h.service.completeMfa(r.pending, 'kit-no-step', '123456', k.ctx()));
    },
  }),
  defineCase({
    name: 'A09 a pending session expires after pendingTtlSeconds',
    facet: 'A09/store',
    needs: ['sessions', 'seed', 'fakeDate'],
    config: PENDING_TTL_300,
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const pd = await h.sessions.issue(a, factsAal1(k), { pending: { steps: ['totp'] } });
      assert.strictEqual(pd.state, 'pending');
      k.clock.tick(299_000);
      assert.ok(await h.sessions.restore(pd.id), 'alive at +299 s');
      k.clock.tick(2_000);
      assert.strictEqual(await h.sessions.restore(pd.id), null, 'gone at +301 s');
    },
  }),
  defineCase({
    name: 'A09 a pending session is not extended by use',
    facet: 'A09/store',
    needs: ['sessions', 'seed', 'fakeDate'],
    config: PENDING_TTL_300,
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const pd = await h.sessions.issue(a, factsAal1(k), { pending: { steps: ['totp'] } });
      for (const step of [100, 100, 90]) {
        k.clock.tick(step * 1000);
        assert.ok(await h.sessions.restore(pd.id), `alive after +${step} s`);
      }
      k.clock.tick(11_000);
      assert.strictEqual(await h.sessions.restore(pd.id), null, 'gone at +301 s despite use');
    },
  }),
  defineCase({
    name: 'A09 elevate turns pending into active aal2 and refuses an active session',
    facet: 'A09/store',
    needs: ['sessions', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const pd = await h.sessions.issue(a, factsAal1(k), { pending: { steps: ['totp'] } });
      const e = await h.sessions.elevate(pd, { assurance: 'aal2', mfa: ['totp'] });
      assert.strictEqual(e.state, 'active');
      assert.ok(e.id !== pd.id, 'elevate rotates');
      assert.strictEqual((await h.sessions.restore(e.id))?.facts.assurance, 'aal2');
      await assert.rejects(h.sessions.elevate(e, { assurance: 'aal2' }));
    },
  }),
  defineCase({
    name: 'A09 SR-07 pending whoami shows only MfaRequired',
    facet: 'A09/http',
    needs: ['http', 'http.routes.login', 'http.routes.whoami', 'seed', 'mfa'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      await h.mfa.enrol(a);
      const jar = k.jar();
      const login = await send(h, routes(h).login(ALICE.login, ALICE.password), jar);
      assert.strictEqual(login.status, 200);
      assert.deepStrictEqual((login.body as { MfaRequired?: unknown }).MfaRequired, [h.mfa.step.name]);
      assert.ok(jar.get(h.http.sessionCookie), 'the session cookie is set');
      const w = await send(h, routes(h).whoami(), jar);
      assert.strictEqual(w.status, 200);
      assert.deepStrictEqual(Object.keys(w.body as object), ['MfaRequired']);
    },
  }),
  defineCase({
    name: 'A09 a pending session yields no principal',
    facet: 'A09/http',
    needs: ['http', 'http.routes.login', 'seed', 'mfa'],
    async run(h, k) {
      const { jar } = await pendingJar(h, k);
      assert.strictEqual(await probePrincipal(h, jar), null);
    },
  }),
  defineCase({
    name: 'A09 SR-07 pending session cannot impersonate',
    facet: 'A09/http',
    needs: ['http', 'http.routes.login', 'http.routes.impersonateStart', 'seed', 'mfa', 'events'],
    async run(h, k) {
      const { jar } = await pendingJar(h, k);
      const b = await seedUser(h, BOB);
      const res = await send(h, routes(h).impersonateStart(b, ALICE.password), jar);
      assert.ok(in4xx(res.status), `impersonation answered ${res.status}`);
      assert.ok(!h.events.all().some((e) => e.type === 'impersonation.start' && e.outcome === 'success'), 'no impersonation.start success');
      assert.strictEqual(await probePrincipal(h, jar), null);
    },
  }),
  table(ROUTE_ROWS, (row) =>
    defineCase({
      name: `A09 a pending session reaches no route but the MFA routes: ${row.label}`,
      facet: 'A09/http',
      needs: ['http', 'http.routes.login', `http.routes.${row.label}` as const, 'seed', 'mfa'],
      async run(h, k) {
        const { jar } = await pendingJar(h, k);
        const res = await send(h, row.req(routes(h)), jar);
        assert.ok(in4xx(res.status), `${row.label} answered ${res.status}`);
      },
    }),
  ),
  defineCase({
    name: 'A09 under force a pending session reaches the enrolment routes only',
    facet: 'A09/http',
    needs: ['http', 'http.routes.login', 'http.routes.mfaEnrol', 'http.routes.sessionsList', 'seed', 'mfa'],
    config: { authn: { mfa: { policy: { force: true } } } },
    async run(h, k) {
      await seedUser(h, ALICE);
      const jar = k.jar();
      const login = await send(h, routes(h).login(ALICE.login, ALICE.password), jar);
      assert.strictEqual(login.status, 200);
      assert.ok((login.body as { MfaRequired?: unknown }).MfaRequired, 'MfaRequired in the login answer');
      assert.ok(jar.get(h.http.sessionCookie), 'the session cookie is set');
      const enrol = await send(h, routes(h).mfaEnrol(), jar);
      assert.ok(enrol.status >= 200 && enrol.status < 300, `enrolment answered ${enrol.status}`);
      assert.ok(in4xx((await send(h, routes(h).sessionsList(), jar)).status), 'sessionsList is refused');
      assert.strictEqual(await probePrincipal(h, jar), null);
    },
  }),
  defineCase({
    name: 'A09 MFA completion over HTTP rotates the cookie and yields a principal',
    facet: 'A09/http',
    needs: ['http', 'http.routes.login', 'http.routes.mfaVerify', 'seed', 'mfa'],
    async run(h, k) {
      const { a, jar } = await pendingJar(h, k);
      const v1 = jar.get(h.http.sessionCookie);
      const res = await send(h, routes(h).mfaVerify(await h.mfa.code(a)), jar);
      assert.strictEqual(res.status, 200);
      const v2 = jar.get(h.http.sessionCookie);
      assert.ok(v2 && v2 !== v1, 'a new cookie value');
      const p = await probePrincipal(h, jar);
      assert.strictEqual(p?.id, a.id);
      assert.strictEqual(p?.authn?.assurance, 'aal2');
    },
  }),
]);
