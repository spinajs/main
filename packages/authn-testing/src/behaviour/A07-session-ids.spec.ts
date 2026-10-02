import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AppEnv } from '../harness/config.js';
import { sha256hex } from '../helpers/crypto.js';
import { idBits } from '../helpers/ids.js';
import { ALICE, factsAal1, in4xx, routes, seedUser, send, sessionCookieOf, sessionJar } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule } from './types.js';

const ENVS: readonly AppEnv[] = ['production', 'staging', 'development', 'test'];

type Planted = 'an unknown value' | 'the cookie of a live pending session';
const PLANTED: readonly Planted[] = ['an unknown value', 'the cookie of a live pending session'];

export const A07: AuthnRule = defineRule('A07', 'session ids are strong, hashed, migrated and rotated', [
  defineCase({
    name: 'A07 session ids have at least 128 bits',
    facet: 'A07/store',
    needs: ['sessions', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const ids: string[] = [];
      for (let i = 0; i < 100; i++) {
        ids.push((await h.sessions.issue(a, factsAal1(k))).id);
      }
      assert.strictEqual(new Set(ids).size, ids.length, 'ids are pairwise distinct');
      for (const id of ids) {
        assert.ok(idBits(id) >= 128, `id ${id} has ${idBits(id)} bits`);
      }
    },
  }),
  defineCase({
    name: 'A07 stores keep only a hash of the id',
    facet: 'A07/store',
    needs: ['sessions', 'sessionStorage', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const h1 = await h.sessions.issue(a, factsAal1(k));
      const keys = await h.sessionStorage.storedKeys();
      assert.ok(keys.includes(sha256hex(h1.id)), 'the storage key is sha256(id)');
      assert.ok(!keys.some((x) => x.includes(h1.id)), 'no storage key holds the raw id');
    },
  }),
  defineCase({
    name: 'A07 a 2.x raw id is migrated on first use without logging the user out',
    facet: 'A07/store',
    needs: ['sessions', 'sessionStorage', 'seed'],
    async run(h, k) {
      const t0 = k.clock.now().getTime();
      const a = await seedUser(h, ALICE);
      const raw = randomUUID();
      await h.sessionStorage.seedLegacy({ rawId: raw, user: a.id, authorized: true, creation: new Date(t0 - 60_000) });
      const r = await h.sessions.restore(raw);
      assert.ok(r, 'the 2.x session restores');
      assert.deepStrictEqual({ ...r.identity }, { type: 'user', id: a.id });
      assert.strictEqual(r.handle.state, 'active');
      assert.strictEqual(r.facts.assurance, 'aal1');
      assert.strictEqual(r.facts.authenticatedAt.getTime(), t0 - 60_000);
      const keys = await h.sessionStorage.storedKeys();
      assert.ok(keys.includes(sha256hex(raw)), 'migrated under sha256(raw)');
      assert.ok(!keys.includes(raw), 'the raw key is gone');
      assert.ok(await h.sessions.restore(raw), 'the same raw id restores again');
    },
  }),
  defineCase({
    name: 'A07 a 2.x row without Authorized comes back pending',
    facet: 'A07/store',
    needs: ['sessions', 'sessionStorage', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const raw = randomUUID();
      await h.sessionStorage.seedLegacy({ rawId: raw, user: a.id, authorized: false, creation: new Date(k.clock.now().getTime() - 60_000) });
      assert.strictEqual((await h.sessions.restore(raw))?.handle.state, 'pending');
    },
  }),
  defineCase({
    name: 'A07 SR-18 a stored hash never works as an id',
    facet: 'A07/store',
    needs: ['sessions', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const h1 = await h.sessions.issue(a, factsAal1(k));
      assert.strictEqual(await h.sessions.restore(sha256hex(h1.id)), null);
    },
  }),
  defineCase({
    name: 'A07 rotate gives a new id, keeps the data and kills the old id',
    facet: 'A07/store',
    needs: ['sessions', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const h1 = await h.sessions.issue(a, factsAal1(k));
      await h.sessions.set(h1, 'KitKey', 'v');
      const h2 = await h.sessions.rotate(h1);
      assert.ok(h2.id !== h1.id, 'a new id');
      assert.strictEqual(await h.sessions.restore(h1.id), null, 'the old id is dead');
      assert.strictEqual((await h.sessions.restore(h2.id))?.data.get('KitKey'), 'v');
    },
  }),
  defineCase({
    name: 'A07 the listed handle equals facts.sessionHandle and is neither the id nor the storage key',
    facet: 'A07/store',
    needs: ['sessions', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const h1 = await h.sessions.issue(a, factsAal1(k));
      const r = await h.sessions.restore(h1.id);
      const cur = (await h.sessions.list(a, { current: h1 })).find((x) => x.current);
      assert.ok(r && cur, 'restored and listed as current');
      assert.strictEqual(cur.handle, r.facts.sessionHandle);
      assert.ok(cur.handle !== h1.id && cur.handle !== sha256hex(h1.id), 'the handle is neither the id nor sha256(id)');
    },
  }),
  table(ENVS, (env) =>
    defineCase({
      name: `A07 the session cookie flags under ${env}`,
      facet: 'A07/http',
      needs: ['http', 'http.routes.login', 'seed'],
      config: { env },
      async run(h) {
        await seedUser(h, ALICE);
        const res = await send(h, routes(h).login(ALICE.login, ALICE.password));
        const c = sessionCookieOf(h, res);
        assert.ok(c, `a ${h.http.sessionCookie} cookie in ${JSON.stringify(res.setCookie)}`);
        assert.strictEqual(c.attributes.httponly, true);
        if (env === 'production' || env === 'staging') {
          assert.strictEqual(c.attributes.secure, true);
          assert.ok(c.name.startsWith('__Host-'), c.name);
          assert.strictEqual(String(c.attributes.samesite).toLowerCase(), 'strict');
        } else {
          assert.strictEqual(c.attributes.secure, undefined);
          assert.ok(!c.name.startsWith('__Host-'), c.name);
        }
      },
    }),
  ),
  defineCase({
    name: 'A07 a second login gets a new session id',
    facet: 'A07/http',
    needs: ['http', 'http.routes.login', 'http.routes.whoami', 'seed'],
    async run(h, k) {
      const R = routes(h);
      await seedUser(h, ALICE);
      const jar = k.jar();
      await send(h, R.login(ALICE.login, ALICE.password), jar);
      const v1 = jar.get(h.http.sessionCookie);
      await send(h, R.login(ALICE.login, ALICE.password), jar);
      const v2 = jar.get(h.http.sessionCookie);
      assert.ok(v1 && v2, 'both logins set the session cookie');
      assert.ok(v1 !== v2, 'a new id');
      assert.strictEqual((await send(h, R.whoami(), sessionJar(h, v2))).status, 200);
    },
  }),
  table(PLANTED, (planted) =>
    defineCase({
      name: `A07 a login never keeps a planted session id: ${planted}`,
      facet: 'A07/http',
      needs: ['http', 'http.routes.login', 'http.routes.whoami', 'seed', 'mfa'],
      async run(h, k) {
        const R = routes(h);
        const a = await seedUser(h, ALICE);
        let P = 'kit-planted';
        if (planted === 'the cookie of a live pending session') {
          await h.mfa.enrol(a);
          const jar = k.jar();
          await send(h, R.login(ALICE.login, ALICE.password), jar);
          P = jar.get(h.http.sessionCookie) ?? assert.fail('the pending login sets a session cookie');
          await h.mfa.step.disable(a);
        }
        const res = await send(h, R.login(ALICE.login, ALICE.password), sessionJar(h, P));
        const c = sessionCookieOf(h, res);
        assert.ok(c, 'the login sets a session cookie');
        assert.ok(c.value !== P, 'the planted value is not kept');
        const w = await send(h, R.whoami(), sessionJar(h, P));
        const pendingOnly = w.status === 200 && JSON.stringify(Object.keys((w.body ?? {}) as object)) === JSON.stringify(['MfaRequired']);
        assert.ok(in4xx(w.status) || pendingOnly, `whoami with the planted value answered ${w.status} ${JSON.stringify(w.body)}`);
      },
    }),
  ),
]);
