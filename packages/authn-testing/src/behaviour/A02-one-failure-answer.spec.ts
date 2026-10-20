import assert from 'node:assert/strict';
import type { AuthenticationResult, IdentityStatus } from '@spinajs/authn/contracts';
import { UNTHROTTLED } from '../harness/config.js';
import type { Harness } from '../harness/ports.js';
import { assertSameTiming, repeat } from '../helpers/timing.js';
import { ALICE, BOB, CAROL, NOBODY, WRONG, auth, expectFailure, expectSameBody, expectThrottled, hasEvent, pw, routes, seedUser, send } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit } from './types.js';

type StatusFlags = Partial<Omit<IdentityStatus, 'exists'>>;

/** No `status`: unknown account; `password` WRONG: wrong password; otherwise the right password of a user in that status. */
interface LoginRow {
  readonly label: string;
  readonly seeded: boolean;
  readonly status?: StatusFlags;
  readonly password?: string;
}

const CORE_ROWS: readonly LoginRow[] = [
  { label: 'unknown account', seeded: false },
  { label: 'wrong password', seeded: true, password: WRONG },
  { label: 'banned', seeded: true, status: { banned: true } },
  { label: 'inactive', seeded: true, status: { active: false } },
  { label: 'deleted', seeded: true, status: { deleted: true } },
  { label: 'invite pending, inactive', seeded: true, status: { active: false, invitePending: true } },
];

const HTTP_ROWS = CORE_ROWS.slice(0, 3);

async function loginAs(h: Harness, k: CaseKit, row: LoginRow): Promise<AuthenticationResult> {
  if (!row.seeded) {
    return auth(h, k, pw(NOBODY, WRONG));
  }
  await seedUser(h, ALICE, row.status);
  return auth(h, k, pw(ALICE.login, row.password ?? ALICE.password));
}

const LOGIN_ACCOUNT_1S = { authn: { throttle: { login: { account: { free: 1, baseDelayMs: 1000, maxDelayMs: 1000 } } } } };

export const A02: AuthnRule = defineRule('A02', 'every authentication failure answers alike', [
  table(CORE_ROWS, (row) =>
    defineCase({
      name: `A02 failures answer alike: ${row.label}`,
      facet: 'A02/core',
      needs: ['service', 'seed', 'events'],
      async run(h, k) {
        expectFailure(await loginAs(h, k, row), 'invalid_credentials');
        assert.ok(hasEvent(h.events, 'login', 'failure'), 'a login failure event');
        const e = h.events.all().find((x) => x.type === 'login' && x.outcome === 'failure');
        assert.ok(typeof e?.reason === 'string' && e.reason.length > 0, 'the failure event carries the real reason');
      },
    }),
  ),
  defineCase({
    name: 'A02 banned, inactive and deleted keep distinct reasons in audit',
    facet: 'A02/core',
    needs: ['service', 'seed', 'events'],
    async run(h, k) {
      await seedUser(h, ALICE, { banned: true });
      await seedUser(h, BOB, { active: false });
      await seedUser(h, CAROL, { deleted: true });
      for (const u of [ALICE, BOB, CAROL]) {
        expectFailure(await auth(h, k, pw(u.login, u.password)), 'invalid_credentials');
      }
      const reasons = h.events
        .all()
        .filter((e) => e.type === 'login' && e.outcome === 'failure')
        .map((e) => e.reason);
      assert.strictEqual(reasons.length, 3, `login failure events: ${JSON.stringify(reasons)}`);
      assert.strictEqual(new Set(reasons).size, 3, `reasons: ${JSON.stringify(reasons)}`);
    },
  }),
  defineCase({
    name: 'A02 a not linked external subject fails with not_linked',
    facet: 'A02/external',
    needs: ['service', 'external', 'events'],
    async run(h, k) {
      const c = await h.external.credentialsFor({ provider: h.external.provider, subject: 'kit-unlinked-1', email: 'unlinked@example.test', emailVerified: true });
      expectFailure(await auth(h, k, c), 'not_linked');
      assert.ok(hasEvent(h.events, 'login', 'failure'));
    },
  }),
  defineCase({
    name: 'A02 a throttled answer carries the same Retry-After for known and unknown logins',
    facet: 'A02/core',
    needs: ['service', 'seed'],
    config: LOGIN_ACCOUNT_1S,
    async run(h, k) {
      await seedUser(h, ALICE);
      expectFailure(await auth(h, k, pw(ALICE.login, WRONG)), 'invalid_credentials');
      expectThrottled(await auth(h, k, pw(ALICE.login, WRONG)), 1, 'known login');
      expectFailure(await auth(h, k, pw(NOBODY, WRONG)), 'invalid_credentials');
      expectThrottled(await auth(h, k, pw(NOBODY, WRONG)), 1, 'unknown login');
    },
  }),
  defineCase({
    name: 'A02 only a throttled failure carries retryAfterSeconds',
    facet: 'A02/core',
    needs: ['service', 'seed'],
    async run(h, k) {
      await seedUser(h, ALICE);
      for (const c of [pw(NOBODY, WRONG), pw(ALICE.login, WRONG)]) {
        const r = await auth(h, k, c);
        assert.strictEqual((r as { retryAfterSeconds?: number }).retryAfterSeconds, undefined, JSON.stringify(r));
      }
    },
  }),
  defineCase({
    name: 'A02 SR-04 unknown login costs a hash',
    facet: 'A02/local',
    needs: ['service', 'seed'],
    config: { authn: { throttle: { login: { account: UNTHROTTLED, ip: UNTHROTTLED } } } },
    timeoutMs: 600_000,
    async run(h, k) {
      await seedUser(h, ALICE);
      await assertSameTiming(
        repeat(() => auth(h, k, pw(ALICE.login, WRONG))),
        repeat(() => auth(h, k, pw(NOBODY, WRONG))),
      );
    },
  }),
  table(HTTP_ROWS, (row) =>
    defineCase({
      name: `A02 every login failure answers one HTTP shape: ${row.label}`,
      facet: 'A02/http',
      needs: ['http', 'http.routes.login', 'seed'],
      async run(h) {
        const R = routes(h);
        const reference = await send(h, R.login(NOBODY, WRONG));
        if (row.seeded) {
          await seedUser(h, ALICE, row.status);
        }
        const res = await send(h, row.seeded ? R.login(ALICE.login, row.password ?? ALICE.password) : R.login(NOBODY, WRONG));
        assert.strictEqual(res.status, 401);
        expectSameBody(h, res, reference);
        assert.ok(JSON.stringify(res.body).includes('E_AUTH_FAILED'), `body ${JSON.stringify(res.body)}`);
        assert.strictEqual(res.headers['retry-after'], undefined);
      },
    }),
  ),
  defineCase({
    name: 'A02 a throttled login answers 401 with Retry-After alike for known and unknown logins',
    facet: 'A02/http',
    needs: ['http', 'http.routes.login', 'seed'],
    config: LOGIN_ACCOUNT_1S,
    async run(h) {
      const R = routes(h);
      await seedUser(h, ALICE);
      const first = await send(h, R.login(ALICE.login, WRONG));
      const firstUnknown = await send(h, R.login(NOBODY, WRONG));
      for (const res of [first, firstUnknown]) {
        assert.strictEqual(res.status, 401);
        assert.strictEqual(res.headers['retry-after'], undefined);
      }
      for (const login of [ALICE.login, NOBODY]) {
        const res = await send(h, R.login(login, WRONG));
        assert.strictEqual(res.status, 401, login);
        assert.strictEqual(res.headers['retry-after'], '1', login);
        expectSameBody(h, res, first, login);
      }
    },
  }),
]);
