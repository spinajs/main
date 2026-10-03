import { CORE_FILTER_OPS, GLOBAL } from '@spinajs/authz';
import type { FilterOp } from '@spinajs/authz';

import { FAKE_TUPLE_OP } from '../fakes/index.js';
import { userPrincipal } from '../principals.js';
import { assignment, combine, fixture, permit, ref, role, staticModel } from './dsl.js';
import type { Case, World } from './types.js';

const alice = userPrincipal('alice');
const f1 = ref('file', 'f1');
const READ = { name: 'file:read', types: ['file'] };

const base: World = {
  permissions: [READ],
  principals: { alice },
  combine: combine('deny-overrides', 'm1'),
  models: [staticModel('m1', { votes: { 'file:read': permit() } })],
};

const refused = (name: string, world: World, message: string[]): Case => ({ name, world, boot: { throws: 'AuthzConfigError', message }, steps: [] });

const WITHOUT_CMP = CORE_FILTER_OPS.filter((op) => op !== 'cmp');

const core: Case[] = [
  { name: 'control: a valid world boots', world: base, steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true } }] },
  refused('rule 1: combine names a model the domain does not register', { ...base, combine: combine('deny-overrides', 'm1', 'ghost') }, ['$domain', 'ghost']),
  refused('rule 1: a per-type route names a model the domain does not register', { ...base, combine: { default: { algorithm: 'deny-overrides', models: ['m1'] }, types: { file: { algorithm: 'deny-overrides', models: ['m1', 'ghost'] } } } }, ['$domain', 'ghost']),
  refused('rule 2: two models with one name in one domain', { ...base, models: [staticModel('m1'), staticModel('m1')] }, ['$domain', 'm1']),
  refused('rule 3: two adapters claim one type', { ...base, adapters: [{ types: ['file'] }, { kind: 'other', types: ['file'] }] }, ['$domain', 'file']),
  refused('rule 4: a residual op the list-scoped adapter does not compile', { ...base, adapters: [{ types: ['file'], compiles: WITHOUT_CMP }] }, ['$domain', 'm1', 'file', 'file:read']),
  refused('rule 4: a native op with no NativeFilter', { ...base, models: [staticModel('m1', { capabilities: { residuals: [...CORE_FILTER_OPS, 'native:ghost'] as FilterOp[] } })] }, ['$domain', 'm1', 'file', 'file:read']),
  {
    name: 'rule 4 control: a native op the adapter compiles and a model registers boots',
    world: {
      permissions: [READ],
      principals: { alice },
      adapters: [{ types: ['file'], rows: { file: [{ id: 'f1' }] }, compiles: [...CORE_FILTER_OPS, FAKE_TUPLE_OP] }],
      combine: combine('deny-overrides', 'rebac'),
      models: [{ kind: 'fake-tuple', schema: { file: { relations: { viewer: 'user' }, permissions: { view: 'viewer' } } }, permissions: { 'file:read': 'file#view' }, tuples: [{ object: f1, relation: 'viewer', subject: alice }] }],
    },
    steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: true } }],
  },
  refused('rule 5: first-applicable with a model whose effects is empty', { ...base, combine: combine('first-applicable', 'm1'), models: [staticModel('m1', { capabilities: { effects: [] } })] }, ['$domain', 'm1']),
  {
    name: 'rule 5 control: a model whose effects is empty boots under deny-overrides',
    world: { ...base, models: [staticModel('m1', { capabilities: { effects: [] } })] },
    steps: [{ check: { as: 'alice', permission: 'file:read', resource: f1 }, expect: { allowed: false, reason: 'no_access' } }],
  },
];

const rbacWorld = (rbac: World['rbac'], extra: Partial<World> = {}): World => ({ permissions: [READ], principals: { alice }, combine: combine('deny-overrides', 'rbac'), rbac, ...extra });

const LADDER_ROLES = [role('viewer', ['file:read'], { ladder: 'project' }), role('editor', [], { ladder: 'project' }), role('owner', [], { ladder: 'project' })];

export const B05 = fixture('B05', [
  { name: 'core', facets: ['engine', 'boot'], lanes: ['F3'], note: 'Rules 1-5 with kit models; rule 6 is in part orm, rules 7-11 in the model parts and B02.', cases: core },
  {
    name: 'rbac',
    facets: ['engine', 'boot', 'rbac'],
    lanes: ['L1'],
    note: 'Rule 8, when the RBAC model compiles its grants.',
    cases: [refused('rule 8: a grant relation with no RelationResolver for the type', rbacWorld({ roles: [role('owner', [{ permission: 'file:read', relation: 'owner' }])], assignments: [assignment('a1', alice, 'owner')] }, { adapters: [{ types: ['file'] }] }), ['$domain', 'rbac', 'file', 'file:read'])],
  },
  {
    name: 'ladders',
    facets: ['engine', 'boot', 'rbac', 'ladders'],
    lanes: ['L1b'],
    note: 'Rule 9 (roles, ladders, implies).',
    cases: [
      refused(
        'rule 9: a role in two ladders',
        rbacWorld({
          ladders: [
            { name: 'project', roles: ['viewer', 'editor'] },
            { name: 'org', roles: ['editor', 'owner'] },
          ],
          roles: [role('viewer', ['file:read']), role('editor', []), role('owner', [])],
        }),
        ['$domain', 'rbac', 'editor'],
      ),
      refused('rule 9: a ladder role extends a higher role of its own ladder', rbacWorld({ ladders: [{ name: 'project', roles: ['viewer', 'editor', 'owner'] }], roles: [role('viewer', ['file:read'], { ladder: 'project', extends: ['editor'] }), LADDER_ROLES[1], LADDER_ROLES[2]] }), ['$domain', 'rbac', 'viewer', 'editor']),
      refused('rule 9: implies names an unknown role', rbacWorld({ ladders: [{ name: 'project', roles: ['viewer', 'editor', 'owner'] }], roles: [...LADDER_ROLES.slice(0, 2), role('owner', [], { ladder: 'project', implies: [{ role: 'ghost', at: 'descendants' }] })] }), ['$domain', 'rbac', 'ghost']),
    ],
  },
  {
    name: 'rules',
    facets: ['engine', 'boot', 'rbac', 'ladders', 'rules'],
    lanes: ['L1b'],
    note: 'Rule 9 (rules) and rule 10 (rule at: <type>). Rule 9\'s "subjectSet role outside every ladder that rank selectors use" reads two ways (the canvas config of design §8.5 has a subjectSet role in no ladder next to rank selectors), so L1b proposes that case by RFC.',
    cases: [refused('rule 9: a rule names an unknown ladder', rbacWorld({ ladders: [{ name: 'project', roles: ['viewer', 'editor', 'owner'] }], roles: LADDER_ROLES, rules: [{ id: 'cap1', kind: 'cap', scope: GLOBAL, ladder: 'ghost', maxRole: 'viewer', source: 'test' }] }), ['$domain', 'rbac', 'ghost']), refused('rule 9: a rule names an unknown role', rbacWorld({ ladders: [{ name: 'project', roles: ['viewer', 'editor', 'owner'] }], roles: LADDER_ROLES, rules: [{ id: 'cap1', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'phantom', source: 'test' }] }), ['$domain', 'rbac', 'phantom']), refused('rule 10: a rule at: a type no adapter or scope resolver returns as an ancestor', rbacWorld({ ladders: [{ name: 'project', roles: ['viewer', 'editor', 'owner'] }], roles: LADDER_ROLES, rules: [{ id: 'th1', kind: 'threshold', scope: GLOBAL, ladder: 'project', at: 'galaxy', minRole: 'editor', permissions: ['file:read'], source: 'test' }] }), ['$domain', 'rbac', 'galaxy'])],
  },
  {
    name: 'abac',
    facets: ['engine', 'boot', 'abac', 'conditions'],
    lanes: ['L3'],
    note: 'Rule 10 for a policy condition.',
    cases: [refused('rule 10: a scope.<type>.* ref for a type no adapter or scope resolver returns as an ancestor', { permissions: [READ], principals: { alice }, combine: combine('deny-overrides', 'abac'), abac: { policies: [{ id: 'p1', effect: 'permit', permissions: ['file:read'], when: { attr: 'scope.galaxy.open', eq: true }, source: 'test' }] } }, ['$domain', 'abac', 'galaxy'])],
  },
  {
    name: 'sql',
    facets: ['engine', 'boot', 'rbac', 'sql'],
    lanes: ['L4b'],
    note: 'Rule 11.',
    cases: [refused('rule 11: a grant pattern SQL cannot express on a list-scoped type', rbacWorld({ roles: [role('reader', [{ permission: 'file:read', on: [{ type: 'file', id: 'a*b*' }] }])], assignments: [assignment('a1', alice, 'reader')] }, { adapters: [{ types: ['file'] }] }), ['$domain', 'rbac', 'file', 'file:read'])],
  },
  {
    name: 'orm',
    facets: ['orm', 'boot'],
    lanes: ['L4'],
    note: "Rule 6 (relationScope 'join' with a sync: 'never' model whose residual is not IO-free) needs @AccessResource models; L4 proposes the case by RFC.",
    cases: [],
  },
]);
