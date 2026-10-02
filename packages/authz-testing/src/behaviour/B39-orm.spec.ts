import type { ScriptedVote, VoteFn } from '../fakes/index.js';
import { extension, permit, ref, staticModel } from './dsl.js';
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
  columns: ['org_id'],
  rows: [
    { id: 'i1', org_id: 'o1' },
    { id: 'i2', org_id: 'o2' },
  ],
};

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
    note: 'OrmResourceAdapter: ancestors from @ScopeColumn, scope attributes from the columns listed in @AccessResource(type, { attributes }), JSON parsed (design §12.3).',
    cases: [
      { name: "scope.<type>.* reads the nearest ancestor's listed columns through the ORM adapter, JSON parsed", world: world(byOrg((a) => (a.policies as { level?: string } | undefined)?.level === 'gold')), steps: [read('i1', true), read('i2', false)] },
      { name: 'a column not listed in attributes is not a scope attribute', world: world(byOrg((a) => a.policies !== undefined && a.name === undefined)), steps: [read('i1', true)] },
    ],
  },
]);
