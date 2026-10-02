import assert from 'node:assert/strict';
import type { TokenCreateOptions } from '@spinajs/authn/contracts';
import { ALICE, auth, expectSuccess, seedUser } from './steps.js';
import { defineCase, defineRule, table } from './types.js';
import type { AuthnRule, CaseKit } from './types.js';

const MINUTE = 60_000;

const after = (k: CaseKit, ms: number): Date => new Date(k.clock.now().getTime() + ms);

const TTL_ROWS = [
  { label: '1440 minutes', minutes: 1440, code: null },
  { label: '1441 minutes', minutes: 1441, code: 'invalid_expiry' },
] as const;

const SCOPE_ROWS: readonly { readonly label: string; readonly opts: (expiresAt: Date) => unknown }[] = [
  { label: 'agent without scope.agent', opts: (expiresAt) => ({ name: 'kit-agent', kind: 'agent', scope: { permissions: ['file:read'] }, expiresAt }) },
  { label: 'pat with scope.agent', opts: (expiresAt) => ({ name: 'kit', kind: 'pat', scope: { agent: true }, expiresAt }) },
  { label: 'agent with roles', opts: (expiresAt) => ({ name: 'kit-agent', kind: 'agent', scope: { agent: true }, roles: ['kit-role'], expiresAt }) },
];

export const A15: AuthnRule = defineRule('A15', 'agent tokens act for their owner inside a ceiling', [
  defineCase({
    name: 'A15 an agent token yields an agent identity acting for its owner',
    facet: 'A15/token',
    needs: ['tokens', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const t = await h.tokens.create(a, { name: 'kit-agent', kind: 'agent', scope: { agent: true, permissions: ['file:read'] }, expiresAt: after(k, 60 * MINUTE) }, k.ctx());
      assert.ok(t.ok, `the agent token is minted: ${JSON.stringify(t)}`);
      const v = await h.tokens.validate(t.plaintext, k.ctx({ purpose: 'request' }));
      assert.ok(v.ok && v.delegation, `validation ${JSON.stringify(v)}`);
      assert.deepStrictEqual({ ...v.identity }, { type: 'agent', id: t.record.id });
      assert.deepStrictEqual({ ...v.delegation }, { onBehalfOf: a, mode: 'inherit' });
      assert.strictEqual(v.ceiling.reason, 'out_of_scope');
      assert.strictEqual(v.ceiling.roles, undefined);
      assert.deepStrictEqual([...(v.ceiling.permissions ?? [])], ['file:read']);
    },
  }),
  table(TTL_ROWS, (row) =>
    defineCase({
      name: `A15 an agent token lives at most agentMaxTtlMinutes: ${row.label}`,
      facet: 'A15/token',
      needs: ['tokens', 'seed'],
      config: { authn: { token: { agentMaxTtlMinutes: 1440 } } },
      async run(h, k) {
        const a = await seedUser(h, ALICE);
        const t = await h.tokens.create(a, { name: 'kit-agent', kind: 'agent', scope: { agent: true }, expiresAt: after(k, row.minutes * MINUTE) }, k.ctx());
        if (row.code === null) {
          assert.ok(t.ok, `accepted: ${JSON.stringify(t)}`);
        } else {
          assert.deepStrictEqual({ ...t }, { ok: false, code: row.code });
        }
      },
    }),
  ),
  table(SCOPE_ROWS, (row) =>
    defineCase({
      name: `A15 kind and scope.agent must agree: ${row.label}`,
      facet: 'A15/token',
      needs: ['tokens', 'seed'],
      async run(h, k) {
        const a = await seedUser(h, ALICE);
        const t = await h.tokens.create(a, row.opts(after(k, 60 * MINUTE)) as TokenCreateOptions, k.ctx());
        assert.deepStrictEqual({ ...t }, { ok: false, code: 'invalid_scope' });
      },
    }),
  ),
  defineCase({
    name: 'A15 an agent token through authenticate gives an agent principal',
    facet: 'A15/core',
    needs: ['service', 'tokens', 'seed'],
    async run(h, k) {
      const a = await seedUser(h, ALICE);
      const t = await h.tokens.create(a, { name: 'kit-agent', kind: 'agent', scope: { agent: true }, expiresAt: after(k, 60 * MINUTE) }, k.ctx());
      assert.ok(t.ok, 'the agent token is minted');
      const r = await auth(h, k, { kind: 'bearer', token: t.plaintext }, { purpose: 'request' });
      expectSuccess(r);
      const p = await h.service.principalOf(r);
      assert.strictEqual(p.type, 'agent');
      assert.strictEqual(p.onBehalfOf?.id, a.id);
      assert.strictEqual(p.delegation, 'inherit');
      assert.strictEqual(p.ceiling?.reason, 'out_of_scope');
    },
  }),
]);
