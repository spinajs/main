import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { a32Fixtures } from '../fixtures/index.js';
import type { A32CaseName, A32Fixtures } from '../fixtures/index.js';
import type { LegacyUser } from '../harness/ports.js';
import { NEW_PW, expectSameBody, routes, send } from './steps.js';
import { defineCase, defineRule } from './types.js';
import type { AuthnRule, CaseKit, HarnessWith } from './types.js';

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

/** The fixture for the case clock, seeded and migrated. */
async function migrate(h: HarnessWith<'migration'>, k: CaseKit): Promise<A32Fixtures> {
  const f = a32Fixtures(k.clock.now());
  await h.migration.seedLegacy(f.users);
  await h.migration.run();
  return f;
}

const tokenOf = (f: A32Fixtures, name: A32CaseName): string => {
  const token = f.cases[name].token;
  assert.ok(token, `${name} has a token`);
  return token;
};

const ok2xx = (status: number): boolean => status >= 200 && status < 300;

export const A32: AuthnRule = defineRule('A32', 'pending 2.x resets and invites survive the upgrade', [
  defineCase({
    name: 'A32 each live reset or invite becomes one authn_secret row',
    facet: 'A32/migration',
    needs: ['migration', 'fakeDate'],
    async run(h, k) {
      const f = await migrate(h, k);
      const rows = await h.migration.secretRows();
      assert.strictEqual(rows.length, f.liveCount);
      for (const e of f.expectedRows) {
        const mine = rows.filter((r) => r.identity === e.identity);
        assert.strictEqual(mine.length, 1, `one row for ${e.identity}`);
        const r = mine[0];
        assert.strictEqual(r.purpose, e.purpose);
        assert.strictEqual(r.secret_hash, e.secret_hash);
        assert.strictEqual(r.expires_at.getTime(), e.expires_at.getTime());
        assert.strictEqual(r.created_at.getTime(), e.created_at.getTime());
        assert.ok(r.used_at == null, 'the row is unused');
      }
    },
  }),
  defineCase({
    name: 'A32 SR-09 no clear secret in users_metadata',
    facet: 'A32/migration',
    needs: ['migration'],
    async run(h, k) {
      const f = await migrate(h, k);
      for (const c of Object.values(f.cases)) {
        const keys = await h.migration.metadataKeys(c.user.Uuid);
        assert.deepStrictEqual(sorted(keys), sorted(c.expected.metadataKeysAfter), c.name);
        assert.ok(!keys.some((key) => key.startsWith('user:pwd_reset:') || key === 'user:pwd:reset'), `${c.name} keeps no reset key`);
      }
    },
  }),
  defineCase({
    name: 'A32 expired and malformed entries are dropped',
    facet: 'A32/migration',
    needs: ['migration'],
    async run(h, k) {
      const f = await migrate(h, k);
      const rows = await h.migration.secretRows();
      for (const name of ['expiredReset', 'resetWithoutStartDate', 'resetWithoutWaitTime', 'lastAttemptOnly'] as const) {
        const identity = `user:${f.cases[name].user.Uuid}`;
        assert.ok(!rows.some((r) => r.identity === identity), `${name} has no row`);
      }
    },
  }),
  defineCase({
    name: 'A32 a carried secret redeems once',
    facet: 'A32/migration',
    needs: ['migration', 'secrets'],
    async run(h, k) {
      const f = await migrate(h, k);
      for (const [name, purpose] of [
        ['liveReset', 'reset'],
        ['liveInvite', 'invite'],
      ] as const) {
        const id = { type: 'user', id: f.cases[name].user.Uuid };
        assert.strictEqual(await h.secrets.redeem(id, purpose, tokenOf(f, name)), true, `${name} redeems`);
        assert.strictEqual(await h.secrets.redeem(id, purpose, tokenOf(f, name)), false, `${name} redeems once`);
      }
    },
  }),
  defineCase({
    name: 'A32 a carried reset link redeems once through the reset route',
    facet: 'A32/http',
    needs: ['migration', 'http', 'http.routes.passwordReset', 'http.routes.login'],
    async run(h, k) {
      const f = await migrate(h, k);
      const user: LegacyUser = f.cases.liveReset.user;
      const token = tokenOf(f, 'liveReset');
      const first = await send(h, routes(h).passwordReset(user.Email, token, NEW_PW));
      assert.ok(ok2xx(first.status), `the reset answered ${first.status}`);
      assert.ok((await send(h, routes(h).passwordReset(user.Email, token, NEW_PW))).status >= 400, 'the second use is refused');
      assert.strictEqual((await send(h, routes(h).login(user.Email, NEW_PW))).status, 200);
    },
  }),
  defineCase({
    name: 'A32 a carried invite link activates the user',
    facet: 'A32/http',
    needs: ['migration', 'http', 'http.routes.passwordReset', 'http.routes.login'],
    async run(h, k) {
      const f = await migrate(h, k);
      const user = f.cases.liveInvite.user;
      const res = await send(h, routes(h).passwordReset(user.Email, tokenOf(f, 'liveInvite'), NEW_PW));
      assert.ok(ok2xx(res.status), `the invite redemption answered ${res.status}`);
      assert.strictEqual((await send(h, routes(h).login(user.Email, NEW_PW))).status, 200);
    },
  }),
  defineCase({
    name: 'A32 an expired 2.x link fails like any expired secret',
    facet: 'A32/http',
    needs: ['migration', 'http', 'http.routes.passwordReset', 'http.routes.login'],
    async run(h, k) {
      const f = await migrate(h, k);
      const user = f.cases.expiredReset.user;
      const x = await send(h, routes(h).passwordReset(user.Email, tokenOf(f, 'expiredReset'), NEW_PW));
      const y = await send(h, routes(h).passwordReset(user.Email, randomUUID(), NEW_PW));
      assert.strictEqual(x.status, y.status);
      assert.ok(x.status >= 400, `the expired link answered ${x.status}`);
      expectSameBody(h, x, y);
    },
  }),
  defineCase({
    name: 'A32 a carried link fails after its old expiry',
    facet: 'A32/http',
    needs: ['migration', 'http', 'http.routes.passwordReset', 'http.routes.login', 'fakeDate'],
    async run(h, k) {
      const f = await migrate(h, k);
      k.clock.tick(3_001_000);
      const res = await send(h, routes(h).passwordReset(f.cases.liveReset.user.Email, tokenOf(f, 'liveReset'), NEW_PW));
      assert.ok(res.status >= 400, `the expired carried link answered ${res.status}`);
    },
  }),
]);
