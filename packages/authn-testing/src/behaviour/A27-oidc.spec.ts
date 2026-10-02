import assert from 'node:assert/strict';
import type { IdTokenTamper } from '../harness/ports.js';
import type { ProbeBody } from '../harness/http.js';
import type { CookieJar } from '../helpers/cookies.js';
import { parseSetCookie } from '../helpers/cookies.js';
import { ALICE, NOBODY, WRONG, expectSameBody, probe, routes, seedUser, send, sessionCookieOf } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, HarnessWith } from './types.js';

type OidcHarness = HarnessWith<'oidc' | 'http'>;
type LinkedHarness = HarnessWith<'oidc' | 'http' | 'links' | 'seed'>;

async function begin(h: OidcHarness, jar: CookieJar): Promise<string> {
  const res = await send(h, { method: 'GET', path: `/auth/oidc/${h.oidc.provider}` }, jar);
  assert.ok(res.status >= 300 && res.status <= 399, `the authorization redirect answered ${res.status}`);
  const location = res.headers['location'];
  assert.ok(location, 'the redirect has a location');
  return location;
}

const callback = (h: OidcHarness, query: Readonly<Record<string, string>>, jar: CookieJar) => send(h, { method: 'GET', path: `/auth/oidc/${h.oidc.provider}/callback?${new URLSearchParams(query)}` }, jar);

/** ALICE linked to one subject of the provider. */
async function linked(h: LinkedHarness) {
  const a = await seedUser(h, ALICE);
  await h.links.link(a, { provider: h.oidc.linkProvider, subject: 'kit-oidc-1' });
  return { a, sub1: { provider: h.oidc.linkProvider, subject: 'kit-oidc-1' } };
}

const TAMPERS: readonly Exclude<IdTokenTamper, 'none'>[] = ['wrong-iss', 'wrong-aud', 'azp-mismatch', 'wrong-nonce', 'expired', 'iat-future', 'alg-none', 'hmac-public-key', 'at-hash-mismatch'];

export const A27: AuthnRule = defineRule('A27', 'OIDC login is code flow with PKCE and full ID token checks', [
  defineCase({
    name: 'A27 the authorization request uses the code flow with PKCE S256',
    facet: 'A27/oidc',
    needs: ['oidc', 'http'],
    async run(h, k) {
      const loc = await begin(h, k.jar());
      const u = new URL(loc);
      assert.strictEqual(u.searchParams.get('response_type'), 'code');
      assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(u.searchParams.get('code_challenge'), 'a code_challenge');
      assert.ok(u.searchParams.get('state'), 'a state');
      assert.ok(u.searchParams.get('nonce'), 'a nonce');
    },
  }),
  defineCase({
    name: 'A27 a linked subject logs in',
    facet: 'A27/oidc',
    needs: ['oidc', 'http', 'links', 'seed'],
    async run(h, k) {
      const { a, sub1 } = await linked(h);
      const jar = k.jar();
      const loc = await begin(h, jar);
      const res = await callback(h, await h.oidc.authorize(loc, sub1), jar);
      assert.ok(res.status < 400, `the callback answered ${res.status}`);
      assert.ok(sessionCookieOf(h, res)?.value, 'the callback sets a session cookie');
      assert.strictEqual(((await send(h, probe(h, 'GET'), jar)).body as ProbeBody).principal?.id, a.id);
    },
  }),
  table(TAMPERS, (tamper) =>
    defineCase({
      name: `A27 a failed ID token check answers like a failed login: ${tamper}`,
      facet: 'A27/oidc',
      needs: ['oidc', 'http', 'http.routes.login', 'links', 'seed'],
      async run(h, k) {
        const { sub1 } = await linked(h);
        const ref = await send(h, routes(h).login(NOBODY, WRONG));
        const jar = k.jar();
        const loc = await begin(h, jar);
        const res = await callback(h, await h.oidc.authorize(loc, sub1, tamper), jar);
        assert.strictEqual(res.status, 401);
        expectSameBody(h, res, ref);
        assert.ok(
          parseSetCookie(res.setCookie).every((c) => c.name !== h.http.sessionCookie || c.value === ''),
          'no session cookie with a value',
        );
      },
    }),
  ),
  defineCase({
    name: 'A27 a replayed state fails',
    facet: 'A27/oidc',
    needs: ['oidc', 'http', 'links', 'seed'],
    async run(h, k) {
      const { sub1 } = await linked(h);
      const jar = k.jar();
      const loc = await begin(h, jar);
      const q = await h.oidc.authorize(loc, sub1);
      const first = await callback(h, q, jar);
      assert.ok(first.status < 400, `the first callback answered ${first.status}`);
      assert.strictEqual((await callback(h, q, jar)).status, 401);
    },
  }),
  defineCase({
    name: 'A27 an unlinked subject fails with JIT off',
    facet: 'A27/oidc',
    needs: ['oidc', 'http'],
    async run(h, k) {
      const jar = k.jar();
      const loc = await begin(h, jar);
      const q = await h.oidc.authorize(loc, { provider: h.oidc.linkProvider, subject: 'kit-oidc-new', email: 'new@example.test', emailVerified: true });
      assert.strictEqual((await callback(h, q, jar)).status, 401);
    },
  }),
  defineCase({
    name: 'A27 an unlinked subject is provisioned with JIT on',
    facet: 'A27/oidc',
    needs: ['oidc', 'http'],
    config: { authn: { linking: { jit: true } } },
    async run(h, k) {
      const jar = k.jar();
      const loc = await begin(h, jar);
      const q = await h.oidc.authorize(loc, { provider: h.oidc.linkProvider, subject: 'kit-oidc-new', email: 'new@example.test', emailVerified: true });
      const res = await callback(h, q, jar);
      assert.ok(res.status < 400, `the callback answered ${res.status}`);
      assert.ok(sessionCookieOf(h, res)?.value, 'the callback sets a session cookie');
      assert.notStrictEqual(((await send(h, probe(h, 'GET'), jar)).body as ProbeBody).principal, null, 'the session resolves to a principal');
    },
  }),
]);
