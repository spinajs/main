import assert from 'node:assert/strict';
import type { IdentityRef } from '@spinajs/authn/contracts';
import type { HttpResponse, ProbeBody } from '../harness/http.js';
import type { Need } from '../harness/ports.js';
import type { CookieJar } from '../helpers/cookies.js';
import { sha256hex } from '../helpers/crypto.js';
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

const mintToken = async (h: HarnessWith<'tokens'>, k: CaseKit, owner: IdentityRef): Promise<string> => {
  const t = await h.tokens.create(owner, { name: 'kit', kind: 'pat', expiresAt: new Date(k.clock.now().getTime() + DAY) }, k.ctx());
  assert.ok(t.ok, `the token is minted: ${JSON.stringify(t)}`);
  return t.plaintext;
};

const tokenOk = async (h: HarnessWith<'tokens'>, k: CaseKit, raw: string): Promise<boolean> => (await h.tokens.validate(raw, k.ctx({ purpose: 'request' }))).ok;

const collectStrings = (v: unknown, out: string[]): string[] => {
  if (typeof v === 'string') {
    out.push(v);
  } else if (Array.isArray(v)) {
    v.forEach((x) => collectStrings(x, out));
  } else if (v !== null && typeof v === 'object') {
    Object.values(v).forEach((x) => collectStrings(x, out));
  }
  return out;
};

/** No string leaf of the body, no header value and no base64url run inside them hashes to a stored secret row of `id`. */
async function expectNoSecretIn(h: HarnessWith<'secretStorage'>, id: IdentityRef, res: HttpResponse): Promise<void> {
  const hashes = new Set((await h.secretStorage.rows()).filter((r) => r.identity.type === id.type && r.identity.id === id.id).map((r) => r.hash));
  const values = [...collectStrings(res.body, []), ...Object.values(res.headers), ...res.setCookie];
  const candidates = new Set(values.flatMap((v) => [v, ...v.split(/[^A-Za-z0-9_-]+/)]).filter((v) => v !== ''));
  for (const c of candidates) {
    assert.ok(!hashes.has(sha256hex(c)), 'the answer holds a stored secret');
  }
}

/** What a refused admin route must leave untouched besides the sessions: needs, and a setup that returns the check. */
const UNTOUCHED = {
  adminPasswordReset: {
    needs: [] as readonly Need[],
    arm: async (h: AdminHarness, _k: CaseKit, _b: IdentityRef) => async (): Promise<void> => {
      assert.strictEqual((await send(h, routes(h).login(BOB.login, BOB.password))).status, 200, "bob's password still works");
    },
  },
  adminMfaReset: {
    needs: ['mfa'] as readonly Need[],
    arm: async (h: AdminHarness & HarnessWith<'mfa'>, _k: CaseKit, b: IdentityRef) => {
      await h.mfa.enrol(b);
      return async (): Promise<void> => {
        assert.strictEqual(await h.mfa.step.enrolled(b), true, 'bob is still enrolled');
      };
    },
  },
  adminSessionsRevoke: { needs: [] as readonly Need[], arm: async () => async (): Promise<void> => undefined },
  adminTokensRevoke: {
    needs: ['tokens'] as readonly Need[],
    arm: async (h: AdminHarness & HarnessWith<'tokens'>, k: CaseKit, b: IdentityRef) => {
      const raw = await mintToken(h, k, b);
      return async (): Promise<void> => {
        assert.strictEqual(await tokenOk(h, k, raw), true, "bob's token is still valid");
      };
    },
  },
} as const;

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
        await h.targetGuard.allowAll();
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
      needs: ['http', 'actors', 'seed', 'targetGuard', 'http.routes.login', `http.routes.${route}` as const, ...UNTOUCHED[route].needs],
      async run(h, k) {
        const { b, jars } = await bobWithSessions(h, k);
        const untouched = await UNTOUCHED[route].arm(h as never, k, b);
        await h.targetGuard.deny('protected_role', b);
        const { jar } = await adminJar(h, k, true);
        const res = await send(h, routes(h)[route](b), jar);
        assert.ok(in4xx(res.status), `${route} answered ${res.status}`);
        await expectAlive(h, b, jars);
        await untouched();
      },
    }),
  ),
  defineCase({
    name: 'A25 an allowed password reset revokes sessions and tokens and returns no secret',
    facet: 'A25/http',
    needs: ['http', 'actors', 'seed', 'targetGuard', 'tokens', 'outbox', 'secretStorage', 'http.routes.login', 'http.routes.adminPasswordReset'],
    async run(h, k) {
      await h.targetGuard.allowAll();
      const { b, jars } = await bobWithSessions(h, k);
      const raw = await mintToken(h, k, b);
      const { jar } = await adminJar(h, k, true);
      const res = await send(h, routes(h).adminPasswordReset(b), jar);
      assert.ok(res.status >= 200 && res.status < 300, `adminPasswordReset answered ${res.status}`);
      for (const bobJar of jars) {
        assert.strictEqual(await principalOf(h, bobJar), null, "bob's session is revoked");
      }
      assert.strictEqual(await tokenOk(h, k, raw), false, "bob's token is revoked");
      assert.ok(in4xx((await send(h, routes(h).login(BOB.login, BOB.password))).status), "bob's old password no longer works");
      const x = await h.outbox.secretFor(b, 'reset');
      assert.ok(x === null || !JSON.stringify(res.body ?? '').includes(x), 'the answer holds no reset secret');
      await expectNoSecretIn(h, b, res);
    },
  }),
  defineCase({
    name: "A25 an allowed sessions revoke ends the target's sessions",
    facet: 'A25/http',
    needs: ['http', 'actors', 'seed', 'targetGuard', 'http.routes.login', 'http.routes.adminSessionsRevoke'],
    async run(h, k) {
      await h.targetGuard.allowAll();
      const { b, jars } = await bobWithSessions(h, k);
      const { jar } = await adminJar(h, k, true);
      const res = await send(h, routes(h).adminSessionsRevoke(b), jar);
      assert.ok(res.status >= 200 && res.status < 300, `adminSessionsRevoke answered ${res.status}`);
      for (const bobJar of jars) {
        assert.strictEqual(await principalOf(h, bobJar), null, "bob's session is revoked");
      }
    },
  }),
  defineCase({
    name: "A25 an allowed tokens revoke ends the target's tokens",
    facet: 'A25/http',
    needs: ['http', 'actors', 'seed', 'targetGuard', 'tokens', 'http.routes.login', 'http.routes.adminTokensRevoke'],
    async run(h, k) {
      await h.targetGuard.allowAll();
      const { b } = await bobWithSessions(h, k);
      const raw = await mintToken(h, k, b);
      const { jar } = await adminJar(h, k, true);
      const res = await send(h, routes(h).adminTokensRevoke(b), jar);
      assert.ok(res.status >= 200 && res.status < 300, `adminTokensRevoke answered ${res.status}`);
      assert.strictEqual(await tokenOk(h, k, raw), false, "bob's token is revoked");
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
