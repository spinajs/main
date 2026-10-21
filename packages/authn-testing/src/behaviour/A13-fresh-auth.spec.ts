import assert from 'node:assert/strict';
import { DEFAULT_THROTTLE } from '../harness/config.js';
import type { ProbeBody } from '../harness/http.js';
import type { CookieJar } from '../helpers/cookies.js';
import { ALICE, BOB, NEW_PW, WRONG, auth, expectSuccess, factsAal1, in4xx, probe, pw, routes, seedUser, send, sessionJar } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, HarnessWith } from './types.js';

const SECOND = 1000;
const DAY = 86_400 * SECOND;

/** The token list body is not frozen: a bare array, or an object holding one. */
const tokenCount = (body: unknown): number => {
  const list = Array.isArray(body) ? body : Object.values((body ?? {}) as object).find(Array.isArray);
  assert.ok(Array.isArray(list), 'the token list body holds an array');
  return list.length;
};

const REAUTH_FREE = DEFAULT_THROTTLE.reauth.account!.free;
const FRESH_AUTH = { authn: { freshAuth: { maxAgeSeconds: 300 } } };

type OidcHarness = HarnessWith<'oidc' | 'http'>;

/** GET an OIDC start route; the provider's authorization URL it redirects to. */
async function oidcStart(h: OidcHarness, path: string, jar: CookieJar): Promise<URL> {
  const res = await send(h, { method: 'GET', path }, jar);
  assert.ok(res.status >= 300 && res.status <= 399, `${path} answered ${res.status}`);
  const location = res.headers['location'];
  assert.ok(location, 'the redirect has a location');
  return new URL(location);
}

const oidcCallback = (h: OidcHarness, query: Readonly<Record<string, string>>, jar: CookieJar) => send(h, { method: 'GET', path: `/auth/oidc/${h.oidc.provider}/callback?${new URLSearchParams(query)}` }, jar);

const principalOf = async (h: OidcHarness, jar: CookieJar) => ((await send(h, probe(h, 'GET'), jar)).body as ProbeBody).principal;

const MINT_ROWS = [
  { label: 'fresh', title: 'A13 minting a token needs fresh auth', staleSeconds: 0, reauth: false, minted: true },
  { label: 'stale', title: 'A13 SR-08 minting a token needs fresh auth', staleSeconds: 301, reauth: false, minted: false },
  { label: 'stale with reauthPassword', title: 'A13 minting a token needs fresh auth', staleSeconds: 301, reauth: true, minted: true },
] as const;

export const A13: AuthnRule = defineRule('A13', 'sensitive actions need fresh authentication', [
  defineCase({
    name: 'A13 reauthenticate with the right password passes and changes nothing',
    facet: 'A13/core',
    needs: ['service', 'seed', 'sessions'],
    async run(h, k) {
      await seedUser(h, ALICE);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectSuccess(r);
      assert.ok(r.session, 'an interactive login issues a session');
      const f0 = (await h.sessions.restore(r.session.id))?.facts;
      assert.ok(f0, 'the session restores');
      k.clock.tick(10 * SECOND);
      assert.strictEqual(await h.service.reauthenticate(r.session, pw(ALICE.login, ALICE.password), k.ctx({ purpose: 'reauth', session: r.session })), true);
      assert.deepStrictEqual((await h.sessions.restore(r.session.id))?.facts, f0, 'same id, same facts');
    },
  }),
  defineCase({
    name: 'A13 a wrong password fails',
    facet: 'A13/core',
    needs: ['service', 'seed'],
    async run(h, k) {
      await seedUser(h, ALICE);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectSuccess(r);
      assert.ok(r.session);
      assert.strictEqual(await h.service.reauthenticate(r.session, pw(ALICE.login, WRONG), k.ctx({ purpose: 'reauth', session: r.session })), false);
    },
  }),
  defineCase({
    name: "A13 another identity's credentials fail",
    facet: 'A13/core',
    needs: ['service', 'seed'],
    async run(h, k) {
      await seedUser(h, ALICE);
      await seedUser(h, BOB);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectSuccess(r);
      assert.ok(r.session);
      assert.strictEqual(await h.service.reauthenticate(r.session, pw(BOB.login, BOB.password), k.ctx({ purpose: 'reauth', session: r.session })), false);
    },
  }),
  defineCase({
    name: 'A13 SR-20 failed re-authentications count into the reauth throttle',
    facet: 'A13/core',
    needs: ['service', 'seed'],
    async run(h, k) {
      await seedUser(h, ALICE);
      const r = await auth(h, k, pw(ALICE.login, ALICE.password));
      expectSuccess(r);
      assert.ok(r.session);
      const session = r.session;
      const reauth = (password: string) => h.service.reauthenticate(session, pw(ALICE.login, password), k.ctx({ purpose: 'reauth', session }));
      for (let i = 0; i < REAUTH_FREE; i++) {
        assert.strictEqual(await reauth(WRONG), false, `wrong password ${i + 1}`);
      }
      assert.strictEqual(await reauth(ALICE.password), false, 'the right password at the same instant is throttled');
      k.clock.tick(SECOND);
      assert.strictEqual(await reauth(ALICE.password), true, 'one second later');
    },
  }),
  defineCase({
    name: 'A13 password change verifies the old password inline and counts failures',
    facet: 'A13/local',
    needs: ['password', 'seed', 'sessions'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const s = await h.sessions.issue(a, factsAal1(k));
      const ctx = () => k.ctx({ purpose: 'reauth' });
      for (let i = 0; i < REAUTH_FREE; i++) {
        assert.deepStrictEqual({ ...(await h.password.change(a, WRONG, NEW_PW, s, ctx())) }, { status: 'invalid' }, `wrong old password ${i + 1}`);
      }
      assert.deepStrictEqual({ ...(await h.password.change(a, ALICE.password, NEW_PW, s, ctx())) }, { status: 'throttled', retryAfterSeconds: 1 });
    },
  }),
  table(MINT_ROWS, (row) =>
    defineCase({
      name: `${row.title}: ${row.label}`,
      facet: 'A13/http',
      needs: ['http', 'http.routes.login', 'http.routes.tokenCreate', 'http.routes.tokenList', 'seed', 'fakeDate'],
      config: { authn: { freshAuth: { maxAgeSeconds: 300 } } },
      async run(h, k) {
        await seedUser(h, ALICE);
        const jar = k.jar();
        await send(h, routes(h).login(ALICE.login, ALICE.password), jar);
        k.clock.tick(row.staleSeconds * SECOND);
        const created = await send(h, routes(h).tokenCreate({ name: 'kit', expiresAt: new Date(k.clock.now().getTime() + DAY), ...(row.reauth ? { reauthPassword: ALICE.password } : {}) }), jar);
        assert.ok(row.minted ? created.status >= 200 && created.status < 300 : in4xx(created.status), `token creation answered ${created.status}`);
        const listed = await send(h, routes(h).tokenList(), jar);
        assert.strictEqual(listed.status, 200, 'token list');
        assert.strictEqual(tokenCount(listed.body), row.minted ? 1 : 0);
      },
    }),
  ),
  defineCase({
    name: 'A13 POST /auth/reauth refreshes authenticatedAt under a new session id; a fresh-auth route then needs no password',
    facet: 'A13/http',
    needs: ['http', 'http.routes.login', 'http.routes.reauth', 'http.routes.tokenCreate', 'http.routes.tokenList', 'seed', 'fakeDate'],
    config: FRESH_AUTH,
    async run(h, k) {
      await seedUser(h, ALICE);
      const R = routes(h);
      const jar = k.jar();
      assert.strictEqual((await send(h, R.login(ALICE.login, ALICE.password), jar)).status, 200, 'the login');
      const old = jar.get(h.http.sessionCookie) ?? assert.fail('the login sets the session cookie');
      k.clock.tick(301 * SECOND);

      const reauth = await send(h, R.reauth(ALICE.password), jar);
      assert.strictEqual(reauth.status, 200, `the re-authentication answered ${reauth.status} ${JSON.stringify(reauth.body)}`);
      const next = jar.get(h.http.sessionCookie);
      assert.ok(next && next !== old, 'the re-authentication sets a new session cookie');

      const created = await send(h, R.tokenCreate({ name: 'kit', expiresAt: new Date(k.clock.now().getTime() + DAY) }), jar);
      assert.ok(created.status >= 200 && created.status < 300, `token creation without a password answered ${created.status}`);
      assert.strictEqual(tokenCount((await send(h, R.tokenList(), jar)).body), 1);
      const stale = await send(h, R.tokenList(), sessionJar(h, old));
      assert.ok(in4xx(stale.status), `the old session cookie answered ${stale.status}`);
    },
  }),
  defineCase({
    name: 'A13 a wrong password on POST /auth/reauth answers 401, keeps the session and counts into the reauth throttle',
    facet: 'A13/http',
    needs: ['http', 'http.routes.login', 'http.routes.reauth', 'http.routes.tokenCreate', 'seed', 'fakeDate'],
    config: FRESH_AUTH,
    async run(h, k) {
      await seedUser(h, ALICE);
      const R = routes(h);
      const jar = k.jar();
      assert.strictEqual((await send(h, R.login(ALICE.login, ALICE.password), jar)).status, 200, 'the login');
      const cookie = jar.get(h.http.sessionCookie) ?? assert.fail('the login sets the session cookie');
      k.clock.tick(301 * SECOND);

      for (let i = 0; i < REAUTH_FREE; i++) {
        const wrong = await send(h, R.reauth(WRONG), jar);
        assert.strictEqual(wrong.status, 401, `wrong password ${i + 1} answered ${wrong.status}`);
        assert.strictEqual(wrong.headers['retry-after'], undefined, 'a re-authentication never tells the backoff');
      }
      assert.strictEqual(jar.get(h.http.sessionCookie), cookie, 'the session id stays');
      assert.strictEqual((await send(h, R.reauth(ALICE.password), jar)).status, 401, 'the right password at the same instant is throttled');
      const refused = await send(h, R.tokenCreate({ name: 'kit', expiresAt: new Date(k.clock.now().getTime() + DAY) }), jar);
      assert.ok(in4xx(refused.status), `the session is still stale: token creation answered ${refused.status}`);

      k.clock.tick(SECOND);
      assert.strictEqual((await send(h, R.reauth(ALICE.password), jar)).status, 200, 'one second later');
    },
  }),
  defineCase({
    name: 'A13 an OIDC re-authentication asks for prompt=login and max_age=0 and refreshes authenticatedAt under a new session id',
    facet: 'A13/oidc',
    needs: ['oidc', 'http', 'links', 'seed', 'fakeDate'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const subject = { provider: h.oidc.linkProvider, subject: 'kit-oidc-reauth' };
      await h.links.link(a, subject);
      const jar = k.jar();
      const login = await oidcStart(h, `/auth/oidc/${h.oidc.provider}`, jar);
      assert.ok((await oidcCallback(h, await h.oidc.authorize(login.href, subject), jar)).status < 400, 'the OIDC login');
      const old = jar.get(h.http.sessionCookie) ?? assert.fail('the login sets the session cookie');
      const before = (await principalOf(h, jar))?.authn?.authenticatedAt;
      assert.ok(before, 'the login yields a session principal');
      k.clock.tick(301 * SECOND);

      const reauth = await oidcStart(h, `/auth/oidc/${h.oidc.provider}/reauth`, jar);
      assert.strictEqual(reauth.searchParams.get('prompt'), 'login');
      assert.strictEqual(reauth.searchParams.get('max_age'), '0');
      const done = await oidcCallback(h, await h.oidc.authorize(reauth.href, subject), jar);
      assert.ok(done.status < 400, `the re-authentication callback answered ${done.status}`);
      const next = jar.get(h.http.sessionCookie);
      assert.ok(next && next !== old, 'the re-authentication sets a new session cookie');

      const p = await principalOf(h, jar);
      assert.strictEqual(p?.id, a.id);
      assert.strictEqual(p?.authn?.authenticatedAt, k.clock.now().toISOString(), `authenticatedAt was ${before}`);
      assert.strictEqual(((await send(h, probe(h, 'GET'), sessionJar(h, old))).body as ProbeBody).principal, null, 'the old session id is dead');
    },
  }),
]);
