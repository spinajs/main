import { SYSTEM } from '@spinajs/authz';
import type { RuleDef } from '@spinajs/authz';

import { fixture, ref } from './dsl.js';
import { exec, pagesAreFull } from './model-steps.js';
import { RULE_PERMISSIONS, RULE_PRINCIPALS, RULE_SETS, asDbRule, probeSteps, ruleWorld } from './rule-worlds.js';
import type { Case } from './types.js';

const AGREE = { agree: { as: RULE_PRINCIPALS, permissions: RULE_PERMISSIONS, type: 'file' } } as const;

const configCases: Case[] = RULE_SETS.map((s) => ({ name: `${s.name} from config: check ⇔ filter`, world: ruleWorld(s.rules), steps: [AGREE, ...probeSteps(s)] }));

const dbCases: Case[] = RULE_SETS.map((s) => ({
  name: `${s.name} from authz_rule: check ⇔ filter`,
  world: ruleWorld([]),
  steps: [
    exec(
      SYSTEM,
      s.rules.map((r) => ({ kind: 'rule.put' as const, rule: asDbRule(r) })),
      'ok',
    ),
    AGREE,
    ...probeSteps(s),
  ],
}));

const restrict = RULE_SETS.find((s) => s.name === 'restrict')!;

const pageCases: Case[] = [
  {
    name: 'a page is never shorter than its limit unless it is the last',
    world: ruleWorld(restrict.rules),
    steps: [pagesAreFull('bob', 'file:read', 'file', 2), pagesAreFull('bob', 'file:read', 'file', 4), pagesAreFull('alice', 'file:read', 'file', 1)],
  },
];

const P1 = ref('project', 'p1');
const O1 = ref('org', 'o1');
const put = (rule: Omit<RuleDef, 'source'>) => exec(SYSTEM, [{ kind: 'rule.put', rule }], { failsAt: 0, code: 'rule_not_compilable' });

const writeCases: Case[] = [
  {
    name: 'a DB rule whose glob is more than a fixed prefix and one trailing * is refused',
    world: ruleWorld([]),
    steps: [put({ id: 'glob', kind: 'threshold', scope: P1, permissions: ['file:edit'], resource: { attr: 'resource.name', glob: 'a*b*' }, minRole: 'maintainer' })],
  },
  {
    name: 'a DB rule with more than one scope-attribute comparison in when is refused',
    world: ruleWorld([]),
    steps: [
      put({
        id: 'two-attrs',
        kind: 'threshold',
        scope: O1,
        permissions: ['file:edit'],
        minRole: 'maintainer',
        when: {
          all: [
            { attr: 'scope.org.policies.locked', eq: true },
            { attr: 'scope.org.policies.max_role', eq: 'viewer' },
          ],
        },
      }),
    ],
  },
  {
    name: 'the same rules in SQL form are accepted',
    world: ruleWorld([]),
    steps: [exec(SYSTEM, [{ kind: 'rule.put', rule: { id: 'prefix', kind: 'threshold', scope: P1, permissions: ['file:edit'], resource: { attr: 'resource.name', glob: 'release/*' }, minRole: 'maintainer' } }], 'ok'), exec(SYSTEM, [{ kind: 'rule.put', rule: { id: 'one-attr', kind: 'threshold', scope: O1, permissions: ['file:edit'], minRole: 'maintainer', when: { attr: 'scope.org.policies.locked', eq: true } } }], 'ok')],
  },
];

export const B44 = fixture('B44', [
  {
    name: 'config',
    facets: ['engine', 'rbac', 'ladders', 'rules', 'conditions', 'list', 'sql'],
    lanes: ['L4b', 'K1'],
    note: 'Every rule kind of B44 from config, the rows in SQLite and Postgres (plan L4b task 8 adds random states). B06.rulesSql repeats the cases of the sets without conditions. "No row is checked in Node" is not observable through the kit; L4b asserts it with a query counter.',
    cases: configCases,
  },
  {
    name: 'db',
    facets: ['engine', 'rbac', 'ladders', 'rules', 'conditions', 'list', 'sql', 'admin'],
    lanes: ['L4b'],
    note: 'The same rules written to authz_rule through AuthzAdmin rule.put (GLOBAL ones at o1), then listed in SQL. The probes after agree fail when neither the check side (DbRuleStore) nor the list side reads the rows.',
    cases: dbCases,
  },
  { name: 'pages', facets: ['engine', 'rbac', 'ladders', 'rules', 'list', 'sql'], lanes: ['L4b'], note: 'Lane handle sqlPages: an ORM list with limit and offset.', cases: pageCases },
  { name: 'write', facets: ['admin', 'rbac', 'ladders', 'rules'], lanes: ['L2', 'L9', 'L4b'], note: 'D24: a DB rule outside SQL form is refused at write (rule_not_compilable), through L2 toSqlForm in the L9 rule handler.', cases: writeCases },
]);
