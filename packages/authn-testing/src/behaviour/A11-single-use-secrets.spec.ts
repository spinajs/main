import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IdentityRef } from '@spinajs/authn/contracts';
import { UNTHROTTLED } from '../harness/config.js';
import type { Harness } from '../harness/ports.js';
import { assertSameTiming, idBits, repeat, sha256hex } from '../helpers/index.js';
import { ALICE, BOB, CAROL, DAVE, IP_B, NEW_PW, NOBODY, auth, expectSameBody, expectSuccess, factsAal1, pw, routes, seedUser, send, throttleParams } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit } from './types.js';

type WithReset = Harness & Required<Pick<Harness, 'password' | 'seed' | 'outbox'>>;

const SECOND = 1000;
const DAY = 86_400 * SECOND;

/** requestReset for ALICE, then the secret the mail holds. */
async function requestAndTake(h: WithReset, k: CaseKit, a: IdentityRef): Promise<string> {
  assert.deepStrictEqual({ ...(await h.password.requestReset(ALICE.login, k.ctx())) }, { status: 'accepted' });
  const x = await h.outbox.secretFor(a, 'reset');
  assert.ok(x, 'the reset mail holds a secret');
  return x;
}

const redeem = (h: WithReset, k: CaseKit, secret: string) => h.password.redeemReset(ALICE.login, secret, NEW_PW, k.ctx());

const TOKEN_ROWS = [
  { revokeTokens: true, label: 'revokeTokens true' },
  { revokeTokens: false, label: 'revokeTokens false' },
] as const;

const INVITE_ROWS = [
  { label: 'pending', pending: true },
  { label: 'not pending', pending: false },
] as const;

export const A11: AuthnRule = defineRule('A11', 'single-use secrets are strong, hashed, bound, short-lived and opaque', [
  defineCase({
    name: 'A11 a secret has at least 128 bits',
    facet: 'A11/store',
    needs: ['secrets', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      const issued: string[] = [];
      for (let i = 0; i < 50; i++) {
        issued.push(await h.secrets.issue(a, 'reset', 60));
      }
      assert.strictEqual(new Set(issued).size, 50, 'every secret is distinct');
      for (const x of issued) {
        assert.ok(idBits(x) >= 128, `${idBits(x)} bits`);
      }
    },
  }),
  defineCase({
    name: 'A11 only the SHA-256 of a secret is stored',
    facet: 'A11/store',
    needs: ['secrets', 'secretStorage', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      const x = await h.secrets.issue(a, 'reset', 60);
      const rows = await h.secretStorage.rows();
      assert.ok(rows.some((r) => r.hash === sha256hex(x)), 'a row holds the SHA-256 hex of the secret');
      assert.ok(!JSON.stringify(rows).includes(x), 'no row holds the raw secret');
    },
  }),
  defineCase({
    name: 'A11 a secret redeems once',
    facet: 'A11/store',
    needs: ['secrets', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      const x = await h.secrets.issue(a, 'reset', 60);
      assert.strictEqual(await h.secrets.redeem(a, 'reset', x), true);
      assert.strictEqual(await h.secrets.redeem(a, 'reset', x), false, 'a second redeem');
    },
  }),
  defineCase({
    name: 'A11 a secret is bound to its identity: other identity',
    facet: 'A11/store',
    needs: ['secrets', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      const b = await seedUser(h, BOB);
      const x = await h.secrets.issue(a, 'reset', 60);
      assert.strictEqual(await h.secrets.redeem(b, 'reset', x), false);
    },
  }),
  defineCase({
    name: 'A11 a secret is bound to its purpose',
    facet: 'A11/store',
    needs: ['secrets', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      const x = await h.secrets.issue(a, 'reset', 60);
      assert.strictEqual(await h.secrets.redeem(a, 'invite', x), false);
    },
  }),
  defineCase({
    name: 'A11 only the latest secret per purpose is live',
    facet: 'A11/store',
    needs: ['secrets', 'seed'],
    async run(h) {
      const a = await seedUser(h, ALICE);
      const x1 = await h.secrets.issue(a, 'reset', 60);
      const x2 = await h.secrets.issue(a, 'reset', 60);
      const i = await h.secrets.issue(a, 'invite', 60);
      assert.strictEqual(await h.secrets.redeem(a, 'reset', x1), false, 'the older reset secret');
      assert.strictEqual(await h.secrets.redeem(a, 'reset', x2), true);
      assert.strictEqual(await h.secrets.redeem(a, 'invite', i), true, 'another purpose is untouched');
    },
  }),
  defineCase({
    name: 'A11 a secret expires',
    facet: 'A11/store',
    needs: ['secrets', 'seed', 'fakeDate'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const b = await seedUser(h, BOB);
      const x = await h.secrets.issue(a, 'reset', 60);
      const y = await h.secrets.issue(b, 'reset', 60);
      k.clock.tick(59 * SECOND);
      assert.strictEqual(await h.secrets.redeem(a, 'reset', x), true, 'live at +59 s');
      k.clock.tick(2 * SECOND);
      assert.strictEqual(await h.secrets.redeem(b, 'reset', y), false, 'expired at +61 s');
    },
  }),
  defineCase({
    name: 'A11 SR-17 a redeem without a pending reset fails with invalid',
    facet: 'A11/local',
    needs: ['password', 'seed'],
    async run(h, k) {
      await seedUser(h, ALICE);
      assert.deepStrictEqual({ ...(await h.password.redeemReset(ALICE.login, randomUUID(), NEW_PW, k.ctx())) }, { status: 'invalid' });
    },
  }),
  defineCase({
    name: 'A11 a reset redeems once',
    facet: 'A11/local',
    needs: ['password', 'seed', 'outbox', 'service'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const x = await requestAndTake(h, k, a);
      assert.deepStrictEqual({ ...(await redeem(h, k, x)) }, { status: 'reset', purpose: 'reset' });
      expectSuccess(await auth(h, k, pw(ALICE.login, NEW_PW)));
      assert.deepStrictEqual({ ...(await redeem(h, k, x)) }, { status: 'invalid' }, 'a second redeem');
    },
  }),
  defineCase({
    name: 'A11 an expired reset fails with invalid',
    facet: 'A11/local',
    needs: ['password', 'seed', 'outbox', 'fakeDate'],
    config: { authn: { local: { reset: { ttlSeconds: 3600 } } } },
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const x = await requestAndTake(h, k, a);
      k.clock.tick(3601 * SECOND);
      assert.deepStrictEqual({ ...(await redeem(h, k, x)) }, { status: 'invalid' });
    },
  }),
  defineCase({
    name: 'A11 a newer reset request voids the older link',
    facet: 'A11/local',
    needs: ['password', 'seed', 'outbox'],
    async run(h, k) {
      const p = throttleParams(k.config);
      const a = await seedUser(h, ALICE);
      const x1 = await requestAndTake(h, k, a);
      k.clock.tick((Math.ceil(p.reset.account!.baseDelayMs / SECOND) + 1) * SECOND);
      const x2 = await requestAndTake(h, k, a);
      assert.deepStrictEqual({ ...(await redeem(h, k, x1)) }, { status: 'invalid' }, 'the older link');
      assert.deepStrictEqual({ ...(await redeem(h, k, x2)) }, { status: 'reset', purpose: 'reset' });
    },
  }),
  defineCase({
    name: 'A11 a reset answers unknown and known logins alike',
    facet: 'A11/local',
    needs: ['password', 'seed'],
    async run(h, k) {
      await seedUser(h, ALICE);
      const known = await h.password.requestReset(ALICE.login, k.ctx());
      const unknown = await h.password.requestReset(NOBODY, k.ctx({ ip: IP_B }));
      assert.deepStrictEqual({ ...known }, { status: 'accepted' });
      assert.deepStrictEqual({ ...unknown }, { ...known });
    },
  }),
  defineCase({
    name: 'A11 SR-04 reset request answers before the work',
    facet: 'A11/local',
    needs: ['password', 'seed'],
    config: { authn: { throttle: { reset: { account: UNTHROTTLED, ip: UNTHROTTLED } } } },
    timeoutMs: 600_000,
    async run(h, k) {
      await seedUser(h, ALICE);
      await assertSameTiming(
        repeat(() => h.password.requestReset(ALICE.login, k.ctx())),
        repeat(() => h.password.requestReset(NOBODY, k.ctx())),
      );
    },
  }),
  defineCase({
    name: 'A11 reset requests count in the reset flow',
    facet: 'A11/local',
    needs: ['password', 'seed'],
    async run(h, k) {
      await seedUser(h, ALICE);
      const throttled = { status: 'throttled', retryAfterSeconds: 60 };
      assert.deepStrictEqual({ ...(await h.password.requestReset(ALICE.login, k.ctx())) }, { status: 'accepted' });
      assert.deepStrictEqual({ ...(await h.password.requestReset(ALICE.login, k.ctx())) }, throttled);
      assert.deepStrictEqual({ ...(await h.password.requestReset(NOBODY, k.ctx({ ip: IP_B }))) }, { status: 'accepted' });
      assert.deepStrictEqual({ ...(await h.password.requestReset(NOBODY, k.ctx({ ip: IP_B }))) }, throttled);
    },
  }),
  defineCase({
    name: 'A11 a redeem soon after the request is not refused by the account key',
    facet: 'A11/local',
    needs: ['password', 'seed', 'outbox'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const x = await requestAndTake(h, k, a);
      k.clock.tick(SECOND);
      assert.strictEqual((await redeem(h, k, x)).status, 'reset');
    },
  }),
  defineCase({
    name: 'A11 redemption revokes all sessions, impersonations included',
    facet: 'A11/local',
    needs: ['password', 'seed', 'outbox', 'sessions'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const c = await seedUser(h, CAROL);
      const s1 = await h.sessions.issue(a, factsAal1(k));
      const s2 = await h.sessions.issue(a, factsAal1(k));
      const si = await h.sessions.issue(c, { ...factsAal1(k), impersonator: { type: 'user', id: a.id } });
      const x = await requestAndTake(h, k, a);
      assert.strictEqual((await redeem(h, k, x)).status, 'reset');
      for (const [label, s] of [['first session', s1], ['second session', s2], ['impersonation', si]] as const) {
        assert.strictEqual(await h.sessions.restore(s.id), null, label);
      }
    },
  }),
  table(TOKEN_ROWS, (row) =>
    defineCase({
      name: row.revokeTokens ? `A11 SR-08 reset revokes tokens: ${row.label}` : `A11 a reset keeps tokens when revoking them is off: ${row.label}`,
      facet: 'A11/local',
      needs: ['password', 'seed', 'outbox', 'tokens'],
      config: { authn: { local: { reset: { revokeTokens: row.revokeTokens } } } },
      async run(h, k) {
        const a = await seedUser(h, ALICE);
        const t = await h.tokens.create(a, { name: 'kit', kind: 'pat', expiresAt: new Date(k.clock.now().getTime() + DAY) }, k.ctx());
        assert.ok(t.ok, 'the token is minted');
        const x = await requestAndTake(h, k, a);
        assert.strictEqual((await redeem(h, k, x)).status, 'reset');
        const v = await h.tokens.validate(t.plaintext, k.ctx({ purpose: 'request' }));
        assert.strictEqual(v.ok, !row.revokeTokens);
      },
    }),
  ),
  table(INVITE_ROWS, (row) =>
    defineCase({
      name: `A11 an invite redeems through redeemReset only while pending: ${row.label}`,
      facet: 'A11/local',
      needs: ['password', 'seed', 'outbox'],
      async run(h, k) {
        const a = await seedUser(h, DAVE, row.pending ? { active: false, invitePending: true } : { active: true });
        await h.password.invite(a, k.ctx());
        if (!row.pending) {
          await h.seed.setStatus(a, { invitePending: false });
        }
        const x = await h.outbox.secretFor(a, 'invite');
        assert.ok(x, 'the invite mail holds a secret');
        const r = await h.password.redeemReset(DAVE.login, x, NEW_PW, k.ctx());
        assert.deepStrictEqual({ ...r }, row.pending ? { status: 'reset', purpose: 'invite' } : { status: 'invalid' });
      },
    }),
  ),
  defineCase({
    name: 'A11 reset routes answer one shape',
    facet: 'A11/http',
    needs: ['http', 'http.routes.passwordResetRequest', 'http.routes.passwordReset', 'seed'],
    async run(h) {
      await seedUser(h, ALICE);
      const R = routes(h);
      const known = await send(h, R.passwordResetRequest(ALICE.login));
      const unknown = await send(h, R.passwordResetRequest(NOBODY));
      assert.strictEqual(known.status, unknown.status, 'reset request status');
      expectSameBody(h, known, unknown, 'reset request body');
      const wrongKnown = await send(h, R.passwordReset(ALICE.login, 'kit-wrong-secret', NEW_PW));
      const wrongUnknown = await send(h, R.passwordReset(NOBODY, 'kit-wrong-secret', NEW_PW));
      assert.strictEqual(wrongKnown.status, wrongUnknown.status, 'reset status');
      assert.ok(wrongKnown.status >= 400, `reset with a wrong secret answered ${wrongKnown.status}`);
      expectSameBody(h, wrongKnown, wrongUnknown, 'reset body');
    },
  }),
]);
