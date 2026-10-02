import assert from 'node:assert/strict';
import type { IdentityRef, TokenCreateOptions } from '@spinajs/authn/contracts';
import type { ProbeBody } from '../harness/http.js';
import { ALICE, BOB, NEW_PW, auth, factsAal1, in4xx, probe, pw, routes, seedUser, send } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit, HarnessWith } from './types.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

const after = (k: CaseKit, ms: number): Date => new Date(k.clock.now().getTime() + ms);

async function mint(h: HarnessWith<'tokens'>, k: CaseKit, owner: IdentityRef, opts: TokenCreateOptions): Promise<string> {
  const t = await h.tokens.create(owner, opts, k.ctx());
  assert.ok(t.ok, `the token is minted: ${JSON.stringify(t)}`);
  return t.plaintext;
}

const mintPat = (h: HarnessWith<'tokens'>, k: CaseKit, owner: IdentityRef) => mint(h, k, owner, { name: 'kit', kind: 'pat', expiresAt: after(k, DAY) });

const tokenOk = async (h: HarnessWith<'tokens'>, k: CaseKit, plaintext: string): Promise<boolean> => (await h.tokens.validate(plaintext, k.ctx({ purpose: 'request' }))).ok;

async function expectPasswordChanged(h: HarnessWith<'service'>, k: CaseKit): Promise<void> {
  assert.strictEqual((await auth(h, k, pw(ALICE.login, NEW_PW))).status, 'success', 'the new password logs in');
  assert.strictEqual((await auth(h, k, pw(ALICE.login, ALICE.password))).status, 'failure', 'the old password no longer logs in');
}

const INVALID_ROWS = [
  {
    label: "another identity's session",
    session: async (h: HarnessWith<'sessions' | 'seed'>, k: CaseKit, _a: IdentityRef) => h.sessions.issue(await seedUser(h, BOB), factsAal1(k)),
  },
  { label: 'a pending session', session: (h: HarnessWith<'sessions' | 'seed'>, k: CaseKit, a: IdentityRef) => h.sessions.issue(a, factsAal1(k), { pending: { steps: ['totp'] } }) },
] as const;

const EXPIRY_ROWS = [
  { label: 'admin', expiry: { cause: 'admin', actor: { type: 'user', id: 'kit-admin' } } as const, keepsTokens: false },
  { label: 'aged', expiry: { cause: 'aged' } as const, keepsTokens: true },
] as const;

export const A30: AuthnRule = defineRule('A30', 'a voluntary change keeps tokens and ends other sessions', [
  defineCase({
    name: 'A30 a voluntary change keeps every API and agent token',
    facet: 'A30/local',
    needs: ['password', 'sessions', 'tokens', 'seed', 'service'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const s = await h.sessions.issue(a, factsAal1(k));
      const pat = await mintPat(h, k, a);
      const agent = await mint(h, k, a, { name: 'kit-agent', kind: 'agent', scope: { agent: true }, expiresAt: after(k, HOUR) });
      const r = await h.password.change(a, ALICE.password, NEW_PW, s, k.ctx({ purpose: 'reauth' }));
      assert.strictEqual(r.status, 'changed');
      await expectPasswordChanged(h, k);
      assert.strictEqual(await tokenOk(h, k, pat), true, 'the API token is valid');
      assert.strictEqual(await tokenOk(h, k, agent), true, 'the agent token is valid');
    },
  }),
  defineCase({
    name: 'A30 a change ends every other session, impersonations included, and rotates the current one',
    facet: 'A30/local',
    needs: ['password', 'sessions', 'seed', 'service'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const c = await seedUser(h, BOB);
      const s1 = await h.sessions.issue(a, factsAal1(k));
      const s2 = await h.sessions.issue(a, factsAal1(k));
      const si = await h.sessions.issue(c, { ...factsAal1(k), impersonator: { type: a.type, id: a.id } });
      const r = await h.password.change(a, ALICE.password, NEW_PW, s1, k.ctx({ purpose: 'reauth' }));
      assert.ok(r.status === 'changed', `the change answered ${r.status}`);
      assert.ok(r.session.id !== s1.id, 'the id rotates');
      assert.ok(await h.sessions.restore(r.session.id), 'the rotated session is alive');
      await expectPasswordChanged(h, k);
      for (const [label, dead] of [
        ['s1', s1],
        ['s2', s2],
        ['the impersonation', si],
      ] as const) {
        assert.strictEqual(await h.sessions.restore(dead.id), null, `${label} is ended`);
      }
    },
  }),
  table(INVALID_ROWS, (row) =>
    defineCase({
      name: `A30 a change with a session that is not the identity's own active one is invalid: ${row.label}`,
      facet: 'A30/local',
      needs: ['password', 'sessions', 'seed', 'service'],
      async run(h, k) {
        const a = await seedUser(h, ALICE);
        const s = await row.session(h, k, a);
        assert.deepStrictEqual({ ...(await h.password.change(a, ALICE.password, NEW_PW, s, k.ctx({ purpose: 'reauth' }))) }, { status: 'invalid' });
        assert.strictEqual((await auth(h, k, pw(ALICE.login, ALICE.password))).status, 'success', 'the old password still works');
      },
    }),
  ),
  table(EXPIRY_ROWS, (row) =>
    defineCase({
      name: `A30 an admin expiry revokes tokens and an aged one keeps them: ${row.label}`,
      facet: 'A30/local',
      needs: ['password', 'sessions', 'tokens', 'seed', 'service'],
      async run(h, k) {
        const a = await seedUser(h, ALICE);
        const s = await h.sessions.issue(a, factsAal1(k));
        const pat = await mintPat(h, k, a);
        await h.password.expire(a, row.expiry, k.ctx());
        assert.strictEqual(await h.sessions.restore(s.id), null, 'the session is revoked');
        assert.strictEqual((await auth(h, k, pw(ALICE.login, ALICE.password))).status, 'failure', 'the expired password no longer logs in');
        assert.strictEqual(await tokenOk(h, k, pat), row.keepsTokens);
      },
    }),
  ),
  defineCase({
    name: 'A30 PATCH /user/password keeps API tokens and revokes the other sessions',
    facet: 'A30/http',
    needs: ['http', 'tokens', 'seed', 'http.routes.login', 'http.routes.passwordChange'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const j1 = k.jar();
      const j2 = k.jar();
      assert.strictEqual((await send(h, routes(h).login(ALICE.login, ALICE.password), j1)).status, 200);
      assert.strictEqual((await send(h, routes(h).login(ALICE.login, ALICE.password), j2)).status, 200);
      const pat = await mintPat(h, k, a);
      const res = await send(h, routes(h).passwordChange(ALICE.password, NEW_PW), j1);
      assert.ok(res.status >= 200 && res.status < 300, `the change answered ${res.status}`);
      assert.strictEqual(((await send(h, probe(h, 'GET'), j1)).body as ProbeBody).principal?.id, a.id, 'the changing session stays');
      assert.strictEqual(((await send(h, probe(h, 'GET'), j2)).body as ProbeBody).principal, null, 'the other session is revoked');
      assert.strictEqual(await tokenOk(h, k, pat), true, 'the API token is valid');
      assert.strictEqual((await send(h, routes(h).login(ALICE.login, NEW_PW))).status, 200, 'the new password logs in');
      assert.ok(in4xx((await send(h, routes(h).login(ALICE.login, ALICE.password))).status), 'the old password is refused');
    },
  }),
]);
