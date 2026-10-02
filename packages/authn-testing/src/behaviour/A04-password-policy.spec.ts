import assert from 'node:assert/strict';
import type { PasswordViolation } from '@spinajs/authn/contracts';
import { ALICE, NEW_PW, auth, expectFailure, expectSuccess, factsAal1, pw, seedUser } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule } from './types.js';

const pwOfLength = (n: number): string => 'Ab1-'.repeat(33).slice(0, n);

const BLOCKED = 'Blocked-Password-x1';
const POLICY = { authn: { local: { policy: { rule: { type: 'string', pattern: '[0-9]' }, blocklist: [BLOCKED] } } } };

function assertRejected(r: { status: string; violations?: readonly PasswordViolation[] }, violation: PasswordViolation): void {
  assert.strictEqual(r.status, 'rejected', `result ${JSON.stringify(r)}`);
  assert.ok(r.violations?.includes(violation), `violations ${JSON.stringify(r.violations)} include ${violation}`);
}

const CHECK_ROWS = [
  { n: 7, expected: 'too_short' },
  { n: 8, expected: null },
  { n: 128, expected: null },
  { n: 129, expected: 'too_long' },
] as const;

const OUTSIDE_ROWS = [7, 129] as const;
const BLOCKLIST_PATHS = ['change', 'redeemReset'] as const;

export const A04: AuthnRule = defineRule('A04', 'passwords are 8 to 128 characters, never trimmed, policy applied whenever set', [
  table(CHECK_ROWS, (row) =>
    defineCase({
      name: `A04 check enforces 8 to 128 characters: ${row.n}`,
      facet: 'A04/local',
      needs: ['password'],
      async run(h) {
        const v = await h.password.check(pwOfLength(row.n));
        if (row.expected === null) {
          assert.deepStrictEqual([...v], []);
        } else {
          assert.ok(v.includes(row.expected), `violations ${JSON.stringify(v)}`);
        }
      },
    }),
  ),
  defineCase({
    name: 'A04 set applies the bounds',
    facet: 'A04/local',
    needs: ['password', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      assertRejected(await h.password.set(a, pwOfLength(7), k.ctx()), 'too_short');
      assertRejected(await h.password.set(a, pwOfLength(129), k.ctx()), 'too_long');
      assert.deepStrictEqual({ ...(await h.password.set(a, pwOfLength(8), k.ctx())) }, { status: 'set' });
    },
  }),
  defineCase({
    name: 'A04 change applies the bounds and keeps the old password',
    facet: 'A04/local',
    needs: ['password', 'seed', 'sessions', 'service'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const s = await h.sessions.issue(a, factsAal1(k));
      const r = await h.password.change(a, ALICE.password, pwOfLength(129), s, k.ctx({ purpose: 'reauth' }));
      assert.strictEqual(r.status, 'rejected');
      assert.strictEqual((await auth(h, k, pw(ALICE.login, ALICE.password))).status, 'success');
    },
  }),
  defineCase({
    name: 'A04 a reset violation does not use up the secret',
    facet: 'A04/local',
    needs: ['password', 'seed', 'outbox', 'service'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      assert.deepStrictEqual({ ...(await h.password.requestReset(ALICE.login, k.ctx())) }, { status: 'accepted' });
      const x = await h.outbox.secretFor(a, 'reset');
      assert.ok(x, 'the reset mail holds a secret');
      assertRejected(await h.password.redeemReset(ALICE.login, x, pwOfLength(7), k.ctx()), 'too_short');
      assert.deepStrictEqual({ ...(await h.password.redeemReset(ALICE.login, x, NEW_PW, k.ctx())) }, { status: 'reset', purpose: 'reset' });
    },
  }),
  defineCase({
    name: 'A04 passwords are never trimmed',
    facet: 'A04/local',
    needs: ['password', 'seed', 'service'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      assert.deepStrictEqual({ ...(await h.password.set(a, '  Spaced-Pass-1  ', k.ctx())) }, { status: 'set' });
      expectFailure(await auth(h, k, pw(ALICE.login, 'Spaced-Pass-1')), 'invalid_credentials');
      expectSuccess(await auth(h, k, pw(ALICE.login, '  Spaced-Pass-1  ')));
    },
  }),
  table(OUTSIDE_ROWS, (n) =>
    defineCase({
      name: `A04 a login outside 8 to 128 characters fails even with the stored password: ${n}`,
      facet: 'A04/local',
      needs: ['service', 'seed', 'hasher', 'passwordStore'],
      async run(h, k) {
        const a = await seedUser(h, ALICE);
        await h.passwordStore.set(a, await h.hasher.hash(pwOfLength(n)));
        expectFailure(await auth(h, k, pw(ALICE.login, pwOfLength(n))), 'invalid_credentials');
      },
    }),
  ),
  defineCase({
    name: 'A04 the policy rule and the blocklist apply to check and set',
    facet: 'A04/local',
    needs: ['password', 'seed'],
    config: POLICY,
    async run(h, k) {
      assert.ok((await h.password.check('No-Digits-Here')).includes('rule'));
      assert.ok((await h.password.check(BLOCKED)).includes('blocklisted'));
      const a = await seedUser(h, ALICE);
      assertRejected(await h.password.set(a, 'No-Digits-Here', k.ctx()), 'rule');
    },
  }),
  table(BLOCKLIST_PATHS, (path) =>
    defineCase({
      name: `A04 the blocklist applies to ${path}`,
      facet: 'A04/local',
      needs: ['password', 'seed', 'sessions', 'outbox'],
      config: POLICY,
      async run(h, k) {
        const a = await seedUser(h, ALICE);
        if (path === 'change') {
          const s = await h.sessions.issue(a, factsAal1(k));
          assertRejected(await h.password.change(a, ALICE.password, BLOCKED, s, k.ctx({ purpose: 'reauth' })), 'blocklisted');
        } else {
          await h.password.requestReset(ALICE.login, k.ctx());
          const x = await h.outbox.secretFor(a, 'reset');
          assert.ok(x, 'the reset mail holds a secret');
          assertRejected(await h.password.redeemReset(ALICE.login, x, BLOCKED, k.ctx()), 'blocklisted');
        }
      },
    }),
  ),
]);
