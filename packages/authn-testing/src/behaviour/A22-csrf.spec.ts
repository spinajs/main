import assert from 'node:assert/strict';
import type { ConfigOverrides } from '../harness/config.js';
import type { HttpMethod, ProbeBody } from '../harness/http.js';
import type { CookieJar } from '../helpers/cookies.js';
import { ALICE, ORIGIN_EVIL, ORIGIN_PARTNER, probe, routes, seedUser, send, sendRaw } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit, HarnessWith } from './types.js';

type CsrfHarness = HarnessWith<'http' | 'seed' | 'http.routes.login'>;

const CSRF: ConfigOverrides = { authn: { http: { csrf: { allowedOrigins: [ORIGIN_PARTNER] } } } };
const CSRF_OFF: ConfigOverrides = { authn: { http: { csrf: { enabled: false, allowedOrigins: [ORIGIN_PARTNER] } } } };

const otherPort = (origin: string): string => {
  const u = new URL(origin);
  if (u.port === '') {
    return `${origin}:8443`;
  }
  u.port = String(Number(u.port) + 1);
  return u.origin;
};

const longerHost = (origin: string): string => {
  const u = new URL(origin);
  u.hostname += '.evil.example.net';
  return u.origin;
};

const otherScheme = (origin: string): string => {
  const u = new URL(origin);
  u.protocol = u.protocol === 'https:' ? 'http:' : 'https:';
  return u.origin;
};

/** ALICE logged in through `send`: a jar holding the session cookie. */
async function aliceJar(h: CsrfHarness, k: CaseKit): Promise<CookieJar> {
  await seedUser(h, ALICE);
  const jar = k.jar();
  const res = await send(h, routes(h).login(ALICE.login, ALICE.password), jar);
  assert.strictEqual(res.status, 200, `login answered ${res.status}`);
  assert.ok(jar.get(h.http.sessionCookie), 'the login sets the session cookie');
  return jar;
}

const hitsOf = async (h: CsrfHarness, jar: CookieJar): Promise<number> => ((await send(h, probe(h, 'GET'), jar)).body as ProbeBody).hits;

interface Row {
  readonly name: string;
  readonly method: HttpMethod;
  readonly headers: (origin: string) => Record<string, string>;
  readonly pass: boolean;
  readonly session?: false;
  readonly config?: ConfigOverrides;
}

const ROWS: readonly Row[] = [
  { name: 'A22 own origin passes', method: 'POST', headers: (o) => ({ origin: o }), pass: true },
  { name: 'A22 SR-12 cross-origin cookie POST refused', method: 'POST', headers: () => ({ origin: ORIGIN_EVIL }), pass: false },
  { name: 'A22 a listed origin passes', method: 'POST', headers: () => ({ origin: ORIGIN_PARTNER }), pass: true },
  { name: 'A22 same-origin fetch metadata passes without Origin', method: 'POST', headers: () => ({ 'sec-fetch-site': 'same-origin' }), pass: true },
  { name: 'A22 cross-site fetch metadata is refused', method: 'POST', headers: () => ({ 'sec-fetch-site': 'cross-site' }), pass: false },
  { name: 'A22 no Origin and no fetch metadata is refused', method: 'POST', headers: () => ({}), pass: false },
  { name: 'A22 Origin null is refused', method: 'POST', headers: () => ({ origin: 'null' }), pass: false },
  { name: 'A22 another port is another origin', method: 'POST', headers: (o) => ({ origin: otherPort(o) }), pass: false },
  { name: 'A22 a longer host is another origin', method: 'POST', headers: (o) => ({ origin: longerHost(o) }), pass: false },
  { name: 'A22 a longer listed origin is another origin', method: 'POST', headers: () => ({ origin: `${ORIGIN_PARTNER}.evil.example.net` }), pass: false },
  { name: 'A22 same-site fetch metadata is refused', method: 'POST', headers: () => ({ 'sec-fetch-site': 'same-site' }), pass: false },
  { name: 'A22 another scheme is another origin', method: 'POST', headers: (o) => ({ origin: otherScheme(o) }), pass: false },
  { name: 'A22 Origin wins over fetch metadata', method: 'POST', headers: () => ({ origin: ORIGIN_EVIL, 'sec-fetch-site': 'same-origin' }), pass: false },
  ...(['PUT', 'PATCH', 'DELETE'] as const).map((method): Row => ({ name: `A22 every unsafe method is checked: ${method}`, method, headers: () => ({ origin: ORIGIN_EVIL }), pass: false })),
  { name: 'A22 safe methods are not checked', method: 'GET', headers: () => ({ origin: ORIGIN_EVIL }), pass: true },
  { name: 'A22 requests without the session cookie are exempt', method: 'POST', headers: () => ({ origin: ORIGIN_EVIL }), pass: true, session: false },
  { name: 'A22 the guard is off when disabled', method: 'POST', headers: () => ({ origin: ORIGIN_EVIL }), pass: true, config: CSRF_OFF },
];

interface LoginRow {
  readonly name: string;
  readonly headers: (origin: string) => Record<string, string>;
  readonly pass: boolean;
  readonly config?: ConfigOverrides;
}

const NO_LISTED_ROUTES: ConfigOverrides = { authn: { http: { csrf: { allowedOrigins: [ORIGIN_PARTNER], unauthenticatedRoutes: [] } } } };

const REFUSED_BODY = { error: { code: 'E_CSRF_ORIGIN', message: 'Cross-origin request refused' } };

const LOGIN_ROWS: readonly LoginRow[] = [
  { name: 'A22 login without the session cookie: a foreign Origin is refused', headers: () => ({ origin: ORIGIN_EVIL }), pass: false },
  { name: 'A22 login without the session cookie: the own origin passes', headers: (o) => ({ origin: o }), pass: true },
  { name: 'A22 login without the session cookie: a listed origin passes', headers: () => ({ origin: ORIGIN_PARTNER }), pass: true },
  { name: 'A22 login without the session cookie: Origin null is refused', headers: () => ({ origin: 'null' }), pass: false },
  { name: 'A22 login without the session cookie: cross-site fetch metadata without Origin is refused', headers: () => ({ 'sec-fetch-site': 'cross-site' }), pass: false },
  { name: 'A22 login without the session cookie: same-site fetch metadata without Origin is refused', headers: () => ({ 'sec-fetch-site': 'same-site' }), pass: false },
  { name: 'A22 login without the session cookie: same-origin fetch metadata without Origin passes', headers: () => ({ 'sec-fetch-site': 'same-origin' }), pass: true },
  { name: 'A22 login without the session cookie: Origin wins over fetch metadata', headers: () => ({ origin: ORIGIN_EVIL, 'sec-fetch-site': 'same-origin' }), pass: false },
  { name: 'A22 login without the session cookie: a non-browser client sending neither header passes', headers: () => ({}), pass: true },
  { name: 'A22 login without the session cookie: an empty unauthenticatedRoutes list leaves it unchecked', headers: () => ({ origin: ORIGIN_EVIL }), pass: true, config: NO_LISTED_ROUTES },
  { name: 'A22 login without the session cookie: the guard off leaves it unchecked', headers: () => ({ origin: ORIGIN_EVIL }), pass: true, config: CSRF_OFF },
];

const LOGIN_CASES = table(LOGIN_ROWS, (row) =>
  defineCase({
    name: row.name,
    facet: 'A22/http',
    needs: ['http', 'http.routes.login', 'seed'],
    config: row.config ?? CSRF,
    async run(h, k) {
      await seedUser(h, ALICE);
      const login = routes(h).login(ALICE.login, ALICE.password);
      const jar = k.jar();
      const res = await sendRaw(h, { ...login, headers: { ...login.headers, ...row.headers(h.http.origin) } }, jar);
      if (row.pass) {
        assert.strictEqual(res.status, 200, 'the login reached the controller');
        assert.ok(jar.get(h.http.sessionCookie), 'the login sets the session cookie');
      } else {
        assert.strictEqual(res.status, 403);
        assert.deepStrictEqual(res.body, REFUSED_BODY);
        assert.strictEqual(jar.get(h.http.sessionCookie), undefined, 'a refused login sets no session');
      }
    },
  }),
);

export const A22: AuthnRule = defineRule('A22', "cookie-authenticated unsafe requests need the app's own origin", [
  ...table(ROWS, (row) =>
    defineCase({
      name: row.name,
      facet: 'A22/http',
      needs: ['http', 'http.routes.login', 'seed'],
      config: row.config ?? CSRF,
      async run(h, k) {
        const jar = row.session === false ? k.jar() : await aliceJar(h, k);
        const h0 = await hitsOf(h, jar);
        const res = await sendRaw(h, { method: row.method, path: h.http.probePath, headers: row.headers(h.http.origin) }, jar);
        if (row.pass) {
          assert.strictEqual(res.status, 200);
          assert.strictEqual((res.body as ProbeBody).hits, h0 + 1, 'the probe handler ran');
        } else {
          assert.strictEqual(res.status, 403);
          assert.strictEqual(await hitsOf(h, jar), h0 + 1, 'the refused request never reached the handler');
        }
      },
    }),
  ),
  ...LOGIN_CASES,
]);
