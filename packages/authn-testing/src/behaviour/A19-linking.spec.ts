import assert from 'node:assert/strict';
import type { ExternalSubject } from '@spinajs/authn/contracts';
import type { ProbeBody } from '../harness/http.js';
import type { CookieJar } from '../helpers/cookies.js';
import { ALICE, BOB, auth, expectFailure, expectSuccess, factsAal1, probe, pw, seedUser, send } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit, HarnessWith } from './types.js';

const FRESH_300 = { authn: { freshAuth: { maxAgeSeconds: 300 } } };

type OidcHarness = HarnessWith<'oidc' | 'http'>;

/** ALICE's active session from a password login. */
async function aliceSession(h: HarnessWith<'service' | 'seed'>, k: CaseKit) {
  const a = await seedUser(h, ALICE);
  const r = await auth(h, k, pw(ALICE.login, ALICE.password));
  expectSuccess(r);
  assert.ok(r.session, 'an interactive login issues a session');
  return { a, session: r.session };
}

async function begin(h: OidcHarness, jar: CookieJar): Promise<string> {
  const res = await send(h, { method: 'GET', path: `/auth/oidc/${h.oidc.provider}` }, jar);
  assert.ok(res.status >= 300 && res.status < 400, `the authorization redirect answered ${res.status}`);
  const location = res.headers['location'];
  assert.ok(location, 'the redirect has a location');
  return location;
}

const callback = (h: OidcHarness, query: Readonly<Record<string, string>>, jar: CookieJar) => send(h, { method: 'GET', path: `/auth/oidc/${h.oidc.provider}/callback?${new URLSearchParams(query)}` }, jar);

const FRESHNESS_ROWS = [
  { label: 'fresh', ok: true, staleSeconds: 0, pending: false },
  { label: 'stale', ok: false, staleSeconds: 301, pending: false },
  { label: 'pending', ok: false, staleSeconds: 0, pending: true },
] as const;

const LAST_CREDENTIAL_ROWS = [
  { label: 'no password, one link', password: false, links: 1, ok: false },
  { label: 'password and one link', password: true, links: 1, ok: true },
  { label: 'no password, two links', password: false, links: 2, ok: true },
] as const;

const EMAIL_ROWS = [
  { label: 'off, verified', byVerifiedEmail: false, verified: true, ok: false },
  { label: 'on, verified', byVerifiedEmail: true, verified: true, ok: true },
  { label: 'on, not verified', byVerifiedEmail: true, verified: false, ok: false },
] as const;

export const A19: AuthnRule = defineRule('A19', 'one identity, many links, unique subjects, guarded changes', [
  defineCase({
    name: 'A19 one identity may hold many links',
    facet: 'A19/store',
    needs: ['links', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      await h.links.link(a, { provider: 'kit-g', subject: 'g1' });
      await h.links.link(a, { provider: 'kit-e', subject: 'e1' });
      assert.strictEqual((await h.links.list(a)).length, 2);
      assert.deepStrictEqual((await h.links.find('kit-g', 'g1'))?.identity, a);
    },
  }),
  defineCase({
    name: 'A19 (provider, subject) is unique',
    facet: 'A19/store',
    needs: ['links', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      const b = await seedUser(h, BOB);
      const same = { provider: 'kit-g', subject: 'g1' };
      await h.links.link(a, same);
      await assert.rejects(h.links.link(b, same));
      assert.deepStrictEqual((await h.links.find('kit-g', 'g1'))?.identity, a);
    },
  }),
  defineCase({
    name: 'A19 the same subject at another provider is another link',
    facet: 'A19/store',
    needs: ['links', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      const b = await seedUser(h, BOB);
      await h.links.link(a, { provider: 'kit-g', subject: 'x' });
      await h.links.link(b, { provider: 'kit-h', subject: 'x' });
      assert.deepStrictEqual((await h.links.find('kit-g', 'x'))?.identity, a);
      assert.deepStrictEqual((await h.links.find('kit-h', 'x'))?.identity, b);
    },
  }),
  defineCase({
    name: 'A19 unlink removes the link',
    facet: 'A19/store',
    needs: ['links', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      const l = await h.links.link(a, { provider: 'kit-g', subject: 'g1' });
      await h.links.unlink(l.id);
      assert.strictEqual(await h.links.find('kit-g', 'g1'), null);
      assert.strictEqual((await h.links.list(a)).length, 0);
    },
  }),
  table(FRESHNESS_ROWS, (row) =>
    defineCase({
      name: `A19 linking needs the identity's own fresh session: ${row.label}`,
      facet: 'A19/core',
      needs: ['accountLinks', 'links', 'service', 'seed', 'sessions', 'fakeDate'],
      config: FRESH_300,
      async run(h, k) {
        let a;
        let session;
        if (row.pending) {
          a = await seedUser(h, ALICE);
          session = await h.sessions.issue(a, factsAal1(k), { pending: { steps: ['totp'] } });
        } else {
          ({ a, session } = await aliceSession(h, k));
        }
        k.clock.tick(row.staleSeconds * 1000);
        const r = await h.accountLinks.link(session, { provider: 'kit-g', subject: 'g-new' }, k.ctx({ purpose: 'link', session }));
        assert.strictEqual(r.ok, row.ok);
        const stored = await h.links.find('kit-g', 'g-new');
        if (row.ok) {
          assert.deepStrictEqual(stored?.identity, a);
        } else {
          assert.strictEqual(stored, null, 'a refused link writes nothing');
        }
      },
    }),
  ),
  defineCase({
    name: 'A19 a subject linked to another identity is refused',
    facet: 'A19/core',
    needs: ['accountLinks', 'links', 'service', 'seed'],
    async run(h, k) {
      const b = await seedUser(h, BOB);
      await h.links.link(b, { provider: 'kit-g', subject: 'taken' });
      const { session } = await aliceSession(h, k);
      const r = await h.accountLinks.link(session, { provider: 'kit-g', subject: 'taken' }, k.ctx({ purpose: 'link', session }));
      assert.strictEqual(r.ok, false);
      assert.deepStrictEqual((await h.links.find('kit-g', 'taken'))?.identity, b, 'the subject stays with its owner');
    },
  }),
  table(LAST_CREDENTIAL_ROWS, (row) =>
    defineCase({
      name: `A19 unlinking the last usable credential is refused: ${row.label}`,
      facet: 'A19/core',
      needs: ['accountLinks', 'links', 'service', 'external', 'seed'],
      async run(h, k) {
        const a = await h.seed.user({ login: ALICE.login, ...(row.password ? { password: ALICE.password } : {}) });
        const subjects: ExternalSubject[] = Array.from({ length: row.links }, (_, i) => ({ provider: h.external.provider, subject: `kit-ext-${i + 1}` }));
        const links = [];
        for (const s of subjects) {
          links.push(await h.links.link(a, s));
        }
        const r = await auth(h, k, row.password ? pw(ALICE.login, ALICE.password) : await h.external.credentialsFor(subjects[0]));
        expectSuccess(r);
        assert.ok(r.session, 'an interactive login issues a session');
        const out = await h.accountLinks.unlink(r.session, links[0].id, k.ctx({ purpose: 'link', session: r.session }));
        assert.strictEqual(out.ok, row.ok);
        const left = await h.links.find(subjects[0].provider, subjects[0].subject);
        if (row.ok) {
          assert.strictEqual(left, null, 'the link is gone');
        } else {
          assert.deepStrictEqual(left?.identity, a, 'the link stays');
        }
      },
    }),
  ),
  table(EMAIL_ROWS, (row) =>
    defineCase({
      name: `A19 an external login matches by verified email only with byVerifiedEmail on: ${row.label}`,
      facet: 'A19/core',
      needs: ['service', 'external', 'seed'],
      config: { authn: { linking: { byVerifiedEmail: row.byVerifiedEmail } } },
      async run(h, k) {
        const a = await h.seed.user({ login: ALICE.login, email: 'alice@example.test', password: ALICE.password });
        const subject: ExternalSubject = { provider: h.external.provider, subject: 'kit-new', email: 'alice@example.test', emailVerified: row.verified };
        const r = await auth(h, k, await h.external.credentialsFor(subject));
        if (row.ok) {
          expectSuccess(r);
          assert.deepStrictEqual(r.identity, a);
        } else {
          expectFailure(r, 'not_linked');
        }
      },
    }),
  ),
  defineCase({
    name: 'A19 a linked OIDC subject logs in and an unlinked one does not',
    facet: 'A19/oidc',
    needs: ['oidc', 'http', 'links', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      await h.links.link(a, { provider: h.oidc.linkProvider, subject: 'kit-oidc-1' });

      const jar = k.jar();
      const loc = await begin(h, jar);
      const q = await h.oidc.authorize(loc, { provider: h.oidc.linkProvider, subject: 'kit-oidc-1' });
      const res = await callback(h, q, jar);
      assert.ok(res.status < 400, `the linked callback answered ${res.status}`);
      assert.ok(jar.get(h.http.sessionCookie), 'a session cookie is set');
      const principal = ((await send(h, probe(h, 'GET'), jar)).body as ProbeBody).principal;
      assert.strictEqual(principal?.id, a.id);

      const other = k.jar();
      const otherLoc = await begin(h, other);
      const oq = await h.oidc.authorize(otherLoc, { provider: h.oidc.linkProvider, subject: 'kit-oidc-other' });
      assert.strictEqual((await callback(h, oq, other)).status, 401);
    },
  }),
]);
