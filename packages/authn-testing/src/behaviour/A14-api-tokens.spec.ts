import assert from 'node:assert/strict';
import type { IdentityRef, TokenCreateOptions } from '@spinajs/authn/contracts';
import type { Harness } from '../harness/ports.js';
import { idBits, sha256hex } from '../helpers/index.js';
import { ALICE, BOB, probe, seedUser, send } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit } from './types.js';

type WithTokens = Harness & Required<Pick<Harness, 'tokens' | 'seed'>>;
type Pat = Extract<TokenCreateOptions, { kind: 'pat' | 'service' }>;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 86_400 * SECOND;
const MAX_TTL_DAYS = 90;

const after = (k: CaseKit, ms: number): Date => new Date(k.clock.now().getTime() + ms);

/** A valid personal token of `owner`, one day ahead. */
async function mint(h: WithTokens, k: CaseKit, owner: IdentityRef, over: Partial<Pat> = {}) {
  const t = await h.tokens.create(owner, { name: 'kit', kind: 'pat', expiresAt: after(k, DAY), ...over }, k.ctx());
  assert.ok(t.ok, `the token is minted: ${JSON.stringify(t)}`);
  return t;
}

const bearer = (plaintext: string) => ({ authorization: `Bearer ${plaintext}` });

const EXPIRY_ROWS = [
  { label: 'undefined', title: 'A14 SR-08 token without expiry refused', expiresAt: () => undefined, lenient: true },
  { label: 'now', title: 'A14 a token expiring now is refused', expiresAt: (k: CaseKit) => k.clock.now(), lenient: false },
  { label: 'now - 1s', title: 'A14 a token expired in the past is refused', expiresAt: (k: CaseKit) => after(k, -SECOND), lenient: false },
  { label: 'now + maxTtlDays + 1s', title: 'A14 a token beyond maxTtlDays is refused', expiresAt: (k: CaseKit) => after(k, MAX_TTL_DAYS * DAY + SECOND), lenient: false },
] as const;

const STATUS_ROWS = [
  { label: 'banned', status: { banned: true } },
  { label: 'inactive', status: { active: false } },
  { label: 'deleted', status: { deleted: true } },
] as const;

const HEADER_ROWS = [
  { label: 'authorization bearer', headers: bearer },
  { label: 'x-api-key', headers: (plaintext: string) => ({ 'x-api-key': plaintext }) },
] as const;

export const A14: AuthnRule = defineRule('A14', 'API tokens are strong, bounded, revocable and checked on every use', [
  defineCase({
    name: 'A14 a token has the prefix and at least 256 bits',
    facet: 'A14/token',
    needs: ['tokens', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const t = await mint(h, k, a);
      assert.ok(t.plaintext.startsWith('spt_'), 'prefix spt_');
      assert.ok(idBits(t.plaintext.slice(4)) >= 256, `${idBits(t.plaintext.slice(4))} bits`);
    },
  }),
  table(EXPIRY_ROWS, (row) =>
    defineCase({
      name: `${row.title}: ${row.label}`,
      facet: 'A14/token',
      needs: ['tokens', 'seed'],
      config: { authn: { token: { maxTtlDays: MAX_TTL_DAYS } } },
      async run(h, k) {
        const a = await seedUser(h, ALICE);
        const attempt = h.tokens.create(a, { name: 'kit', kind: 'pat', expiresAt: row.expiresAt(k) } as never, k.ctx());
        // The type makes the expiry mandatory, so a rejection also counts as a refusal.
        const result = row.lenient ? await attempt.catch(() => undefined) : await attempt;
        if (result !== undefined) {
          assert.deepStrictEqual({ ...result }, { ok: false, code: 'invalid_expiry' });
        }
        assert.strictEqual((await h.tokens.list(a)).length, 0, 'no token was stored');
      },
    }),
  ),
  defineCase({
    name: 'A14 an expiry of exactly maxTtlDays is accepted',
    facet: 'A14/token',
    needs: ['tokens', 'seed'],
    config: { authn: { token: { maxTtlDays: MAX_TTL_DAYS } } },
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      await mint(h, k, a, { expiresAt: after(k, MAX_TTL_DAYS * DAY) });
    },
  }),
  defineCase({
    name: 'A14 the plaintext is shown once',
    facet: 'A14/token',
    needs: ['tokens', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const t = await mint(h, k, a);
      const listed = JSON.stringify(await h.tokens.list(a));
      assert.ok(!listed.includes(t.plaintext), 'the list holds no plaintext');
      assert.ok(!listed.includes(sha256hex(t.plaintext)), 'the list holds no hash');
    },
  }),
  defineCase({
    name: 'A14 validate reports the owner',
    facet: 'A14/token',
    needs: ['tokens', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const t = await mint(h, k, a);
      const v = await h.tokens.validate(t.plaintext, k.ctx({ purpose: 'request' }));
      assert.ok(v.ok, `validation ${JSON.stringify(v)}`);
      assert.deepStrictEqual({ ...v.identity }, { ...a });
      assert.strictEqual(v.method, 'token');
    },
  }),
  defineCase({
    name: 'A14 a revoked token fails; revoke is owner-bound',
    facet: 'A14/token',
    needs: ['tokens', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const b = await seedUser(h, BOB);
      const t = await mint(h, k, a);
      const request = () => h.tokens.validate(t.plaintext, k.ctx({ purpose: 'request' }));
      assert.strictEqual(await h.tokens.revoke(b, t.record.id, k.ctx()), false, 'another identity cannot revoke it');
      assert.strictEqual((await request()).ok, true);
      assert.strictEqual(await h.tokens.revoke(a, t.record.id, k.ctx()), true);
      assert.strictEqual((await request()).ok, false);
      assert.ok(!(await h.tokens.list(a)).some((r) => r.id === t.record.id), 'a revoked token is not listed');
    },
  }),
  defineCase({
    name: 'A14 an expired token fails',
    facet: 'A14/token',
    needs: ['tokens', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const t = await mint(h, k, a, { expiresAt: after(k, 3600 * SECOND) });
      const v = await h.tokens.validate(t.plaintext, k.ctx({ purpose: 'request', now: after(k, 3601 * SECOND) }));
      assert.strictEqual(v.ok, false);
      assert.ok(
        (await h.tokens.list(a)).some((r) => r.id === t.record.id),
        'an expired token is still listed',
      );
    },
  }),
  table(STATUS_ROWS, (row) =>
    defineCase({
      name: `A14 each use checks the owner's status: ${row.label}`,
      facet: 'A14/token',
      needs: ['tokens', 'seed'],
      async run(h, k) {
        const a = await seedUser(h, ALICE);
        const t = await mint(h, k, a);
        const request = () => h.tokens.validate(t.plaintext, k.ctx({ purpose: 'request' }));
        await h.seed.setStatus(a, row.status);
        assert.strictEqual((await request()).ok, false, `a ${row.label} owner`);
        await h.seed.setStatus(a, { active: true, banned: false, deleted: false });
        assert.strictEqual((await request()).ok, true, 'the owner is restored');
      },
    }),
  ),
  defineCase({
    name: 'A14 revokeAllFor ends every token of the owner, agent tokens included',
    facet: 'A14/token',
    needs: ['tokens', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const b = await seedUser(h, BOB);
      const pat = await mint(h, k, a);
      const agent = await h.tokens.create(a, { name: 'kit-agent', kind: 'agent', scope: { agent: true }, expiresAt: after(k, 60 * MINUTE) }, k.ctx());
      assert.ok(agent.ok, 'the agent token is minted');
      const other = await mint(h, k, b);
      assert.strictEqual(await h.tokens.revokeAllFor(a, k.ctx()), 2);
      const request = (plaintext: string) => h.tokens.validate(plaintext, k.ctx({ purpose: 'request' }));
      assert.strictEqual((await request(pat.plaintext)).ok, false, 'the personal token');
      assert.strictEqual((await request(agent.plaintext)).ok, false, 'the agent token');
      assert.strictEqual((await request(other.plaintext)).ok, true, "another identity's token");
    },
  }),
  table(HEADER_ROWS, (row) =>
    defineCase({
      name: `A14 a token authenticates a request: ${row.label}`,
      facet: 'A14/http',
      needs: ['http', 'tokens', 'seed'],
      async run(h, k) {
        const a = await seedUser(h, ALICE);
        const t = await mint(h, k, a);
        const res = await send(h, { ...probe(h, 'GET'), headers: row.headers(t.plaintext) });
        const body = res.body as { principal?: { id?: string } | null };
        assert.strictEqual(body.principal?.id, a.id);
      },
    }),
  ),
  defineCase({
    name: 'A14 a revoked token gets no principal',
    facet: 'A14/http',
    needs: ['http', 'tokens', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const t = await mint(h, k, a);
      assert.strictEqual(await h.tokens.revoke(a, t.record.id, k.ctx()), true);
      const res = await send(h, { ...probe(h, 'GET'), headers: bearer(t.plaintext) });
      // The probe has no policy, so a 401 from the middleware is as good as a null principal.
      assert.ok(res.status !== 200 || (res.body as { principal?: unknown }).principal === null, `status ${res.status}, body ${JSON.stringify(res.body)}`);
    },
  }),
]);
