import assert from 'node:assert/strict';
import type { IdentityRef } from '@spinajs/authn/contracts';
import type { ProbeBody } from '../harness/http.js';
import type { CookieJar } from '../helpers/cookies.js';
import { BOB, in4xx, probe, routes, seedUser, send } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit, HarnessWith } from './types.js';

type AdminHarness = HarnessWith<'http' | 'actors' | 'seed' | 'targetGuard' | 'http.routes.login'>;

const DAY = 86_400_000;

const ADMIN_ROUTES = ['adminPasswordReset', 'adminMfaReset', 'adminSessionsRevoke', 'adminTokensRevoke'] as const;

async function loginAs(h: AdminHarness, k: CaseKit, login: string, password: string): Promise<CookieJar> {
  const jar = k.jar();
  const res = await send(h, routes(h).login(login, password), jar);
  assert.strictEqual(res.status, 200, `login of ${login} answered ${res.status}`);
  return jar;
}

async function adminJar(h: AdminHarness, k: CaseKit, credentialsRight: boolean) {
  const ad = await h.actors.admin({ credentialsRight });
  return { ad, jar: await loginAs(h, k, ad.login, ad.password) };
}

/** BOB with two sessions, each in its own jar. */
async function bobWithSessions(h: AdminHarness, k: CaseKit): Promise<{ b: IdentityRef; jars: CookieJar[] }> {
  const b = await seedUser(h, BOB);
  return { b, jars: [await loginAs(h, k, BOB.login, BOB.password), await loginAs(h, k, BOB.login, BOB.password)] };
}

const principalOf = async (h: AdminHarness, jar: CookieJar) => ((await send(h, probe(h, 'GET'), jar)).body as ProbeBody).principal;

async function expectAlive(h: AdminHarness, b: IdentityRef, jars: readonly CookieJar[]): Promise<void> {
  for (const jar of jars) {
    assert.strictEqual((await principalOf(h, jar))?.id, b.id, "bob's session is alive");
  }
}

export const A25: AuthnRule = defineRule('A25', 'credential admin routes need users:credentials and the target guard', [
  table(ADMIN_ROUTES, (route) =>
    defineCase({
      name: `A25 ${route} needs users:credentials`,
      facet: 'A25/http',
      needs: ['http', 'actors', 'seed', 'targetGuard', 'http.routes.login', `http.routes.${route}` as const],
      async run(h, k) {
        const { b, jars } = await bobWithSessions(h, k);
        const { jar } = await adminJar(h, k, false);
        const res = await send(h, routes(h)[route](b), jar);
        assert.ok(in4xx(res.status), `${route} answered ${res.status}`);
        await expectAlive(h, b, jars);
      },
    }),
  ),
  defineCase({
    name: "A25 SR-10 lower admin cannot reset a higher admin's password",
    facet: 'A25/http',
    needs: ['http', 'actors', 'seed', 'targetGuard', 'http.routes.login', 'http.routes.adminPasswordReset'],
    async run(h, k) {
      const { b } = await bobWithSessions(h, k);
      await h.targetGuard.deny('escalation', b);
      const { jar } = await adminJar(h, k, true);
      const res = await send(h, routes(h).adminPasswordReset(b), jar);
      assert.ok(in4xx(res.status), `adminPasswordReset answered ${res.status}`);
      assert.strictEqual((await send(h, routes(h).login(BOB.login, BOB.password))).status, 200, "bob's password still works");
    },
  }),
  table(ADMIN_ROUTES, (route) =>
    defineCase({
      name: `A25 a protected target is refused: ${route}`,
      facet: 'A25/http',
      needs: ['http', 'actors', 'seed', 'targetGuard', 'http.routes.login', `http.routes.${route}` as const],
      async run(h, k) {
        const { b, jars } = await bobWithSessions(h, k);
        await h.targetGuard.deny('protected_role', b);
        const { jar } = await adminJar(h, k, true);
        const res = await send(h, routes(h)[route](b), jar);
        assert.ok(in4xx(res.status), `${route} answered ${res.status}`);
        await expectAlive(h, b, jars);
      },
    }),
  ),
  defineCase({
    name: 'A25 an allowed password reset revokes sessions and tokens and returns no secret',
    facet: 'A25/http',
    needs: ['http', 'actors', 'seed', 'targetGuard', 'tokens', 'outbox', 'http.routes.login', 'http.routes.adminPasswordReset'],
    async run(h, k) {
      const { b, jars } = await bobWithSessions(h, k);
      const t = await h.tokens.create(b, { name: 'kit', kind: 'pat', expiresAt: new Date(k.clock.now().getTime() + DAY) }, k.ctx());
      assert.ok(t.ok, `the token is minted: ${JSON.stringify(t)}`);
      const { jar } = await adminJar(h, k, true);
      const res = await send(h, routes(h).adminPasswordReset(b), jar);
      assert.ok(res.status >= 200 && res.status < 300, `adminPasswordReset answered ${res.status}`);
      for (const bobJar of jars) {
        assert.strictEqual(await principalOf(h, bobJar), null, "bob's session is revoked");
      }
      assert.strictEqual((await h.tokens.validate(t.plaintext, k.ctx({ purpose: 'request' }))).ok, false, "bob's token is revoked");
      const x = await h.outbox.secretFor(b, 'reset');
      assert.ok(x === null || !JSON.stringify(res.body ?? '').includes(x), 'the answer holds no reset secret');
    },
  }),
  defineCase({
    name: 'A25 SR-10 admin MFA reset returns no secret',
    facet: 'A25/http',
    needs: ['http', 'actors', 'seed', 'targetGuard', 'mfa', 'events', 'http.routes.login', 'http.routes.adminMfaReset'],
    async run(h, k) {
      const { b } = await bobWithSessions(h, k);
      await h.mfa.enrol(b);
      const { ad, jar } = await adminJar(h, k, true);
      const res = await send(h, routes(h).adminMfaReset(b), jar);
      assert.ok(res.status >= 200 && res.status < 300, `adminMfaReset answered ${res.status}`);
      assert.strictEqual(await h.mfa.step.enrolled(b), false, 'bob is no longer enrolled');
      const body = JSON.stringify(res.body ?? '').toLowerCase();
      for (const word of ['otpauth', 'secret', 'provisioning']) {
        assert.ok(!body.includes(word), `the answer holds no ${word}`);
      }
      const e = h.events.all().find((x) => x.type === 'mfa.disable');
      assert.ok(e, 'an mfa.disable event');
      assert.strictEqual(e.actor?.id, ad.ref.id);
    },
  }),
]);
