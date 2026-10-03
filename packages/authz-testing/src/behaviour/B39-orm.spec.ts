import type { ScriptedVote, VoteFn } from '../fakes/index.js';
import { cmp, extension, permit, ref, staticModel } from './dsl.js';
import type { OrmModelSpec } from './lane.js';
import { ormWorld } from './B20-orm-scoping.spec.js';
import type { Step, World } from './types.js';

/** `@AccessResource('org', { attributes: ['policies'] })`; `policies` is a JSON column, `name` is not listed. */
const ORG: OrmModelSpec = {
  name: 'Org',
  type: 'org',
  attributes: ['policies'],
  columns: ['name', 'policies'],
  json: ['policies'],
  rows: [
    { id: 'o1', name: 'gold org', policies: '{"level":"gold"}' },
    { id: 'o2', name: 'silver org', policies: '{"level":"silver"}' },
  ],
};
const ITEM: OrmModelSpec = {
  name: 'Item',
  type: 'item',
  scopeColumns: [{ column: 'org_id', type: 'org' }],
  columns: ['org_id', 'tier'],
  rows: [
    { id: 'i1', org_id: 'o1', tier: 'gold' },
    { id: 'i2', org_id: 'o2', tier: 'gold' },
    // No Org row o9: the adapter cannot resolve i3's org (an unknown node).
    { id: 'i3', org_id: 'o9', tier: 'gold' },
  ],
};

const TIER_MATCHES_ORG = { 'item:read': permit(cmp('tier', 'eq', { ref: 'scope.org.policies.level' })) };

/** Permits when `test` holds for the attributes of the nearest org, read through ctx.ancestors and ctx.attributes. */
const byOrg =
  (test: (attributes: Readonly<Record<string, unknown>>) => boolean): VoteFn =>
  async (req, ctx): Promise<ScriptedVote> => {
    const org = (await ctx.ancestors(req.resource))?.find((r) => r.type === 'org');
    const attributes = org ? await ctx.attributes(org) : null;
    return attributes && test(attributes) ? permit() : {};
  };

const world = (votes: VoteFn): World => ({ ...ormWorld({}, [ORG, ITEM]), models: [staticModel('m1', { votes, capabilities: { sync: 'never' } })] });

const read = (id: string, allowed: boolean): Step => ({ check: { as: 'alice', permission: 'item:read', resource: ref('item', id) }, expect: { allowed } });

export const B39Orm = extension('B39', [
  {
    name: 'orm',
    facets: ['engine', 'orm'],
    lanes: ['L4'],
    note: 'OrmResourceAdapter: ancestors from @ScopeColumn, scope attributes from the columns listed in @AccessResource(type, { attributes }), JSON parsed (design §12.3); a scope row it cannot load answers null (unknown node, B39 r6). A dangling @ScopeColumn value is an unknown node, not an unknown resource: ancestors() lists it without loading its row.',
    cases: [
      { name: "scope.<type>.* reads the nearest ancestor's listed columns through the ORM adapter, JSON parsed", world: world(byOrg((a) => (a.policies as { level?: string } | undefined)?.level === 'gold')), steps: [read('i1', true), read('i2', false)] },
      { name: 'a column not listed in attributes is not a scope attribute', world: world(byOrg((a) => a.policies !== undefined && a.name === undefined)), steps: [read('i1', true)] },
      {
        name: 'a scope.org.* ref in a vote binds from the nearest org through the ORM adapter',
        world: ormWorld(TIER_MATCHES_ORG, [ORG, ITEM]),
        steps: [
          { check: { as: 'alice', permission: 'item:read', resource: ref('item', 'i1') }, expect: { allowed: true, residual: { equals: cmp('tier', 'eq', 'gold') } } },
          { check: { as: 'alice', permission: 'item:read', resource: ref('item', 'i2') }, expect: { allowed: true, residual: { equals: cmp('tier', 'eq', 'silver') } } },
        ],
      },
      {
        name: 'a scope.org.* ref to an org the ORM adapter cannot load (unknown node) makes the vote indeterminate: deny model_error',
        world: ormWorld(TIER_MATCHES_ORG, [ORG, ITEM]),
        steps: [{ check: { as: 'alice', permission: 'item:read', resource: ref('item', 'i3') }, expect: { allowed: false, reason: { code: 'model_error', model: 'm1' } } }],
      },
    ],
  },
]);
