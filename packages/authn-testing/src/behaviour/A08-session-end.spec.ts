import assert from 'node:assert/strict';
import { isCleared } from '../helpers/cookies.js';
import { ALICE, BOB, CAROL, factsAal1, in4xx, routes, seedUser, send, sessionCookieOf, sessionJar } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule } from './types.js';

const MIN = 60_000;
const EXPIRATION = { authn: { session: { expiration: { ttl: 30, maxLifetime: 480 } } } };
const ACTIONS = ['ban', 'deactivate'] as const;

export const A08: AuthnRule = defineRule('A08', 'sessions end by timeout, logout and revocation', [
  defineCase({
    name: 'A08 an idle session expires after the idle timeout',
    facet: 'A08/store',
    needs: ['sessions', 'seed', 'fakeDate'],
    config: EXPIRATION,
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const h1 = await h.sessions.issue(a, factsAal1(k));
      k.clock.tick(29 * MIN);
      assert.ok(await h.sessions.restore(h1.id), 'alive after 29 minutes');
      k.clock.tick(29 * MIN);
      assert.ok(await h.sessions.restore(h1.id), 'alive after 29 more minutes: the idle deadline slides');
      k.clock.tick(31 * MIN);
      assert.strictEqual(await h.sessions.restore(h1.id), null);
    },
  }),
  defineCase({
    name: 'A08 a session ends at the absolute timeout despite activity',
    facet: 'A08/store',
    needs: ['sessions', 'seed', 'fakeDate'],
    config: EXPIRATION,
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const h1 = await h.sessions.issue(a, factsAal1(k));
      for (let i = 1; i <= 23; i++) {
        k.clock.tick(20 * MIN);
        assert.ok(await h.sessions.restore(h1.id), `alive at ${i * 20} minutes`);
      }
      k.clock.tick(21 * MIN);
      assert.strictEqual(await h.sessions.restore(h1.id), null);
    },
  }),
  defineCase({
    name: "A08 revokeAll ends the identity's sessions and, on request, its impersonations",
    facet: 'A08/store',
    needs: ['sessions', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const b = await seedUser(h, BOB);
      const c = await seedUser(h, CAROL);
      await h.sessions.issue(a, factsAal1(k));
      await h.sessions.issue(a, factsAal1(k));
      const si = await h.sessions.issue(c, { ...factsAal1(k), impersonator: { type: 'user', id: a.id } });
      const sb = await h.sessions.issue(b, factsAal1(k));
      assert.strictEqual(await h.sessions.revokeAll(a), 2);
      assert.ok(await h.sessions.restore(si.id), 'the impersonation survives a plain revokeAll');
      assert.strictEqual(await h.sessions.revokeAll(a, { includeImpersonations: true }), 1);
      assert.strictEqual(await h.sessions.restore(si.id), null);
      assert.ok(await h.sessions.restore(sb.id), 'another identity is untouched');
    },
  }),
  defineCase({
    name: 'A08 revokeAll except keeps the current session',
    facet: 'A08/store',
    needs: ['sessions', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const s1 = await h.sessions.issue(a, factsAal1(k));
      await h.sessions.issue(a, factsAal1(k));
      await h.sessions.issue(a, factsAal1(k));
      assert.strictEqual(await h.sessions.revokeAll(a, { except: s1 }), 2);
      assert.ok(await h.sessions.restore(s1.id), 'the excepted session lives');
    },
  }),
  defineCase({
    name: "A08 revokeHandle ends only the owner's session",
    facet: 'A08/store',
    needs: ['sessions', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const b = await seedUser(h, BOB);
      const s1 = await h.sessions.issue(a, factsAal1(k));
      const sb = await h.sessions.issue(b, factsAal1(k));
      const hb = (await h.sessions.list(b))[0].handle;
      assert.strictEqual(await h.sessions.revokeHandle(a, hb), false, 'not the owner');
      assert.ok(await h.sessions.restore(sb.id));
      const si = await h.sessions.issue(b, { ...factsAal1(k), impersonator: { type: 'user', id: a.id } });
      const hi = (await h.sessions.list(b, { current: si })).find((x) => x.current)?.handle;
      assert.ok(hi, 'the impersonated session is listed for its subject');
      assert.strictEqual(await h.sessions.revokeHandle(a, hi), false, 'the impersonator is not the subject');
      assert.ok(await h.sessions.restore(si.id), 'the impersonated session lives');
      const ha = (await h.sessions.list(a))[0].handle;
      assert.strictEqual(await h.sessions.revokeHandle(a, ha), true);
      assert.strictEqual(await h.sessions.restore(s1.id), null);
    },
  }),
  defineCase({
    name: 'A08 logout deletes the session and clears the cookie',
    facet: 'A08/http',
    needs: ['http', 'http.routes.login', 'http.routes.logout', 'http.routes.whoami', 'seed'],
    async run(h, k) {
      const R = routes(h);
      await seedUser(h, ALICE);
      const jar = k.jar();
      await send(h, R.login(ALICE.login, ALICE.password), jar);
      const v = jar.get(h.http.sessionCookie);
      assert.ok(v, 'the login sets the session cookie');
      assert.strictEqual((await send(h, R.whoami(), sessionJar(h, v))).status, 200, 'whoami works before the logout');
      const res = await send(h, R.logout(), jar);
      const c = sessionCookieOf(h, res);
      assert.ok(c && isCleared(c, k.clock.now()), `the logout clears the session cookie: ${JSON.stringify(res.setCookie)}`);
      const w = await send(h, R.whoami(), sessionJar(h, v));
      assert.ok(in4xx(w.status), `whoami with the old cookie answered ${w.status}`);
    },
  }),
  table(ACTIONS, (action) =>
    defineCase({
      name: `A08 ${action} revokes every session of the identity, impersonations included`,
      facet: 'A08/lifecycle',
      needs: ['lifecycle', 'sessions', 'seed'],
      async run(h, k) {
        const a = await seedUser(h, ALICE);
        const c = await seedUser(h, CAROL);
        const s1 = await h.sessions.issue(a, factsAal1(k));
        const s2 = await h.sessions.issue(a, factsAal1(k));
        const si = await h.sessions.issue(c, { ...factsAal1(k), impersonator: { type: 'user', id: a.id } });
        for (const s of [s1, s2, si]) {
          assert.ok(await h.sessions.restore(s.id), `session ${s.id} is alive before the action`);
        }
        await h.lifecycle[action](a);
        for (const s of [s1, s2, si]) {
          assert.strictEqual(await h.sessions.restore(s.id), null, `session ${s.id} is revoked`);
        }
      },
    }),
  ),
]);
