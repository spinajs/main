import assert from 'node:assert/strict';
import { DEFAULT_THROTTLE } from '../harness/config.js';
import { ALICE, BOB, NEW_PW, WRONG, auth, expectSuccess, factsAal1, in4xx, pw, routes, seedUser, send } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule } from './types.js';

const SECOND = 1000;
const DAY = 86_400 * SECOND;

/** The token list body is not frozen: a bare array, or an object holding one. */
const tokenCount = (body: unknown): number => {
  const list = Array.isArray(body) ? body : Object.values((body ?? {}) as object).find(Array.isArray);
  assert.ok(Array.isArray(list), 'the token list body holds an array');
  return list.length;
};

const REAUTH_FREE = DEFAULT_THROTTLE.reauth.account!.free;

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
]);
