import assert from 'node:assert/strict';
import type { ProbeBody } from '../harness/http.js';
import type { CookieJar } from '../helpers/cookies.js';
import { ALICE, in4xx, probe, routes, seedUser, send, sessionJar } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit, HarnessWith } from './types.js';

type RoleHarness = HarnessWith<'http' | 'roles' | 'seed' | 'http.routes.login' | 'http.routes.activeRoleSet'>;

const FRESH_300 = { authn: { freshAuth: { maxAgeSeconds: 300 } } };

/** ALICE holding kit-editor and kit-root, logged in: a jar with the session cookie. */
async function aliceWithRoles(h: RoleHarness, k: CaseKit): Promise<CookieJar> {
  const a = await seedUser(h, ALICE);
  await h.roles.grant(a, [
    { role: 'kit-editor', requirePassword: false },
    { role: 'kit-root', requirePassword: true },
  ]);
  const jar = k.jar();
  const res = await send(h, routes(h).login(ALICE.login, ALICE.password), jar);
  assert.strictEqual(res.status, 200, `login answered ${res.status}`);
  return jar;
}

const ceilingRoles = async (h: RoleHarness, jar: CookieJar) => ((await send(h, probe(h, 'GET'), jar)).body as ProbeBody).principal?.ceiling?.roles;

const FRESHNESS_ROWS = [
  { label: 'stale without password', password: false },
  { label: 'stale with password', password: true },
] as const;

export const A26: AuthnRule = defineRule('A26', 'role switch takes only held roles and rotates', [
  defineCase({
    name: 'A26 a held role is accepted and sets ceiling.roles',
    facet: 'A26/http',
    needs: ['http', 'roles', 'seed', 'http.routes.login', 'http.routes.activeRoleSet'],
    async run(h, k) {
      const jar = await aliceWithRoles(h, k);
      const res = await send(h, routes(h).activeRoleSet('kit-editor'), jar);
      assert.ok(res.status >= 200 && res.status < 300, `the role switch answered ${res.status}`);
      assert.deepStrictEqual(await ceilingRoles(h, jar), ['kit-editor']);
    },
  }),
  defineCase({
    name: 'A26 a role the principal does not hold is refused',
    facet: 'A26/http',
    needs: ['http', 'roles', 'seed', 'http.routes.login', 'http.routes.activeRoleSet'],
    async run(h, k) {
      const jar = await aliceWithRoles(h, k);
      const res = await send(h, routes(h).activeRoleSet('kit-other'), jar);
      assert.ok(in4xx(res.status), `the role switch answered ${res.status}`);
      assert.notDeepStrictEqual(await ceilingRoles(h, jar), ['kit-other']);
    },
  }),
  defineCase({
    name: 'A26 the switch rotates the session',
    facet: 'A26/http',
    needs: ['http', 'roles', 'seed', 'http.routes.login', 'http.routes.activeRoleSet', 'http.routes.whoami'],
    async run(h, k) {
      const jar = await aliceWithRoles(h, k);
      const v1 = jar.get(h.http.sessionCookie);
      assert.ok(v1, 'the login sets the session cookie');
      const res = await send(h, routes(h).activeRoleSet('kit-editor'), jar);
      assert.ok(res.status >= 200 && res.status < 300, `the role switch answered ${res.status}`);
      const v2 = jar.get(h.http.sessionCookie);
      assert.ok(v2 && v2 !== v1, 'a new cookie value');
      assert.ok(in4xx((await send(h, routes(h).whoami(), sessionJar(h, v1))).status), 'the old cookie is dead');
    },
  }),
  table(FRESHNESS_ROWS, (row) =>
    defineCase({
      name: `A26 a requirePassword role needs fresh auth: ${row.label}`,
      facet: 'A26/http',
      needs: ['http', 'roles', 'seed', 'http.routes.login', 'http.routes.activeRoleSet', 'fakeDate'],
      config: FRESH_300,
      async run(h, k) {
        const jar = await aliceWithRoles(h, k);
        k.clock.tick(301_000);
        const res = await send(h, routes(h).activeRoleSet('kit-root', row.password ? ALICE.password : undefined), jar);
        if (row.password) {
          assert.ok(res.status >= 200 && res.status < 300, `the role switch answered ${res.status}`);
        } else {
          assert.ok(in4xx(res.status), `the role switch answered ${res.status}`);
          assert.ok(!(await ceilingRoles(h, jar))?.includes('kit-root'), 'the ceiling stays off kit-root');
        }
      },
    }),
  ),
]);
