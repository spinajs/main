import assert from 'node:assert/strict';
import type { HttpResponse, ProbeBody } from '../harness/http.js';
import type { Harness } from '../harness/ports.js';
import { SoftAuthenticator } from '../helpers/webauthn.js';
import type { SoftCreationOptions, SoftRequestOptions } from '../helpers/webauthn.js';
import type { CookieJar } from '../helpers/cookies.js';
import { ALICE, in4xx, probe, routes, seedUser, send, sessionCookieOf } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule, CaseKit } from './types.js';

type WithPasskeys = Harness & Required<Pick<Harness, 'http' | 'seed' | 'webauthn'>>;

const SECOND = 1000;
const FRESH_300 = { authn: { freshAuth: { maxAgeSeconds: 300 } } };

const ok = (r: HttpResponse): boolean => r.status >= 200 && r.status < 300;

const REGISTER_NEEDS = ['http', 'http.routes.login', 'http.routes.passkeyOptions', 'http.routes.passkeyRegister', 'webauthn', 'seed'] as const;
const LOGIN_NEEDS = ['http.routes.logout', 'http.routes.passkeyChallenge', 'http.routes.passkeyLogin'] as const;

/** `{ challengeId, options }` of a ceremony answer; the options are what the browser hands the authenticator. */
function ceremonyOf<O>(r: HttpResponse, what: string): { challengeId: string; options: O } {
  const body = r.body as { challengeId?: unknown; options?: { challenge?: unknown } } | undefined;
  assert.ok(ok(r), `${what} answered ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(typeof body?.challengeId === 'string' && typeof body.options?.challenge === 'string', `${what}: no challengeId and options in ${JSON.stringify(r.body)}`);
  return body as { challengeId: string; options: O };
}

/** ALICE logged in with her password: a fresh session in `jar`. */
async function passwordLogin(h: WithPasskeys, k: CaseKit): Promise<CookieJar> {
  await seedUser(h, ALICE);
  const jar = k.jar();
  const login = await send(h, routes(h).login(ALICE.login, ALICE.password), jar);
  assert.strictEqual(login.status, 200, `password login answered ${login.status}`);
  return jar;
}

/** Registers `key` as a passkey of the session in `jar`; `reauthPassword` on both calls when given. */
async function registerPasskey(h: WithPasskeys, jar: CookieJar, key: SoftAuthenticator, reauthPassword?: string): Promise<HttpResponse> {
  const asked = await send(h, routes(h).passkeyOptions(reauthPassword !== undefined ? { reauthPassword } : {}), jar);
  const { challengeId, options } = ceremonyOf<SoftCreationOptions>(asked, 'POST /user/passkeys/options');
  return send(h, routes(h).passkeyRegister({ challengeId, response: key.create(options, h.webauthn.origin), name: 'kit key', ...(reauthPassword !== undefined ? { reauthPassword } : {}) }), jar);
}

/** A passkey login in a fresh jar: the challenge, then the authenticator's assertion over it. */
async function passkeyLogin(h: WithPasskeys, k: CaseKit, key: SoftAuthenticator, uv = true): Promise<{ jar: CookieJar; res: HttpResponse; body: { challengeId: string; response: unknown } }> {
  const jar = k.jar();
  const { challengeId, options } = ceremonyOf<SoftRequestOptions>(await send(h, routes(h).passkeyChallenge(), jar), 'POST /auth/passkeys/challenge');
  const body = { challengeId, response: key.get(options, h.webauthn.origin, { uv }) };
  return { jar, res: await send(h, routes(h).passkeyLogin(body), jar), body };
}

async function authnOf(h: WithPasskeys, jar: CookieJar): Promise<NonNullable<NonNullable<ProbeBody['principal']>['authn']> | undefined> {
  const res = await send(h, probe(h, 'GET'), jar);
  assert.strictEqual(res.status, 200, 'the probe');
  return (res.body as ProbeBody).principal?.authn;
}

const passkeyIds = (r: HttpResponse): string[] => {
  assert.ok(ok(r) && Array.isArray(r.body), `GET /user/passkeys answered ${r.status} ${JSON.stringify(r.body)}`);
  return (r.body as { id?: unknown }[]).map((p) => String(p.id));
};

export const A33: AuthnRule = defineRule('A33', 'WebAuthn: passkeys log in at aal2 and are managed under fresh auth', [
  defineCase({
    name: 'A33 a passkey registered with fresh auth logs in at aal2 after logout',
    facet: 'A33/http',
    needs: [...REGISTER_NEEDS, ...LOGIN_NEEDS],
    async run(h, k) {
      const jar = await passwordLogin(h, k);
      const key = new SoftAuthenticator({ seed: 'a33-alice' });
      const registered = await registerPasskey(h, jar, key);
      assert.ok(ok(registered), `POST /user/passkeys answered ${registered.status} ${JSON.stringify(registered.body)}`);
      assert.ok(ok(await send(h, routes(h).logout(), jar)), 'logout');
      const { jar: next, res } = await passkeyLogin(h, k, key);
      assert.strictEqual(res.status, 200, `passkey login answered ${res.status} ${JSON.stringify(res.body)}`);
      assert.ok(sessionCookieOf(h, res), 'the passkey login sets the session cookie');
      const authn = await authnOf(h, next);
      assert.strictEqual(authn?.assurance, 'aal2');
      assert.strictEqual(authn?.method, 'webauthn');
    },
  }),
  defineCase({
    name: 'A33 a passkey assertion without user verification logs in at aal1',
    facet: 'A33/http',
    needs: [...REGISTER_NEEDS, ...LOGIN_NEEDS],
    async run(h, k) {
      const jar = await passwordLogin(h, k);
      const key = new SoftAuthenticator({ seed: 'a33-alice-no-uv' });
      assert.ok(ok(await registerPasskey(h, jar, key)), 'registration');
      const { jar: next, res } = await passkeyLogin(h, k, key, false);
      assert.strictEqual(res.status, 200, `passkey login answered ${res.status}`);
      assert.strictEqual((await authnOf(h, next))?.assurance, 'aal1');
    },
  }),
  defineCase({
    name: 'A33 registering a passkey needs fresh auth',
    facet: 'A33/http',
    needs: [...REGISTER_NEEDS, 'fakeDate'],
    config: FRESH_300,
    async run(h, k) {
      const jar = await passwordLogin(h, k);
      k.clock.tick(301 * SECOND);
      const stale = await send(h, routes(h).passkeyOptions({}), jar);
      assert.ok(in4xx(stale.status), `options on a stale session answered ${stale.status}`);
      const key = new SoftAuthenticator({ seed: 'a33-alice-stale' });
      const { challengeId, options } = ceremonyOf<SoftCreationOptions>(await send(h, routes(h).passkeyOptions({ reauthPassword: ALICE.password }), jar), 'options with the password');
      const response = key.create(options, h.webauthn.origin);
      const without = await send(h, routes(h).passkeyRegister({ challengeId, response }), jar);
      assert.ok(in4xx(without.status), `registration on a stale session answered ${without.status}`);
      const listed = await send(h, routes(h).passkeyList(), jar);
      assert.deepStrictEqual(passkeyIds(listed), [], 'nothing registered without fresh auth');
      assert.ok(ok(await registerPasskey(h, jar, key, ALICE.password)), 'registration with the password');
      assert.deepStrictEqual(passkeyIds(await send(h, routes(h).passkeyList(), jar)), [key.credentialId]);
    },
  }),
  defineCase({
    name: 'A33 a deleted passkey no longer logs in',
    facet: 'A33/http',
    needs: [...REGISTER_NEEDS, ...LOGIN_NEEDS, 'http.routes.passkeyList', 'http.routes.passkeyDelete'],
    async run(h, k) {
      const jar = await passwordLogin(h, k);
      const key = new SoftAuthenticator({ seed: 'a33-alice-deleted' });
      assert.ok(ok(await registerPasskey(h, jar, key)), 'registration');
      assert.deepStrictEqual(passkeyIds(await send(h, routes(h).passkeyList(), jar)), [key.credentialId]);
      assert.ok(ok(await send(h, routes(h).passkeyDelete(key.credentialId), jar)), 'delete');
      assert.deepStrictEqual(passkeyIds(await send(h, routes(h).passkeyList(), jar)), []);
      assert.ok(ok(await send(h, routes(h).logout(), jar)), 'logout');
      const { res } = await passkeyLogin(h, k, key);
      assert.strictEqual(res.status, 401, `login with a deleted passkey answered ${res.status}`);
      assert.ok(!sessionCookieOf(h, res)?.value, 'no session cookie');
    },
  }),
  defineCase({
    name: 'A33 a replayed passkey assertion does not log in',
    facet: 'A33/http',
    needs: [...REGISTER_NEEDS, ...LOGIN_NEEDS],
    async run(h, k) {
      const jar = await passwordLogin(h, k);
      const key = new SoftAuthenticator({ seed: 'a33-alice-replay' });
      assert.ok(ok(await registerPasskey(h, jar, key)), 'registration');
      const { res, body } = await passkeyLogin(h, k, key);
      assert.strictEqual(res.status, 200, 'the first login');
      const again = await send(h, routes(h).passkeyLogin(body), k.jar());
      assert.strictEqual(again.status, 401, `the replay answered ${again.status}`);
    },
  }),
]);
