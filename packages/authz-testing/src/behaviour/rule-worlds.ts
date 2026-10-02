import { GLOBAL } from '@spinajs/authz';
import type { RuleDef } from '@spinajs/authz';

import { servicePrincipal, userPrincipal } from '../principals.js';
import { assignment, combine, ref, role } from './dsl.js';
import type { CheckStep, World } from './types.js';

// Worlds with RBAC rules on a list-scoped type (file), for check ⇔ filter (B06 with rules, B44): one
// world per rule kind, the same principals and rows in each. Files lie under projects under orgs, all
// rows of one adapter, so SQL lanes get the scope columns file → project → org.

const O1 = ref('org', 'o1');
const O2 = ref('org', 'o2');
const P1 = ref('project', 'p1');
const P2 = ref('project', 'p2');
const f = (id: string) => ref('file', id);

const PW = ['project', 'org'];

export const RULE_PRINCIPALS = ['alice', 'bob', 'carol', 'dave', 'svc'] as const;
export const RULE_PERMISSIONS = ['file:read', 'file:edit', 'file:inspect', 'file:repo'] as const;

const alice = userPrincipal('alice');
const bob = userPrincipal('bob');
const carol = userPrincipal('carol');
const dave = userPrincipal('dave');
const svc = servicePrincipal('svc');

const FILES = [
  { id: 'f1', name: 'notes' },
  { id: 'f2', name: 'plan' },
  { id: 'f3', name: 'release/1' },
  { id: 'f4', name: 'notes' },
  { id: 'f5', name: 'release/2/hotfix' },
  { id: 'f6', name: 'main' },
];

const ROLES = [role('viewer', ['file:read', { permission: 'file:inspect', requiresTag: 'inspect' }, { permission: 'file:repo', grantedAt: PW }], { ladder: 'project' }), role('commenter', [], { ladder: 'project' }), role('editor', ['file:edit'], { ladder: 'project' }), role('maintainer', [], { ladder: 'project' }), role('org.guest', [], { ladder: 'org' }), role('org.member', [], { ladder: 'org' })];

const ASSIGNMENTS = [assignment('a1', alice, 'editor', P1, { tags: ['inspect'] }), assignment('a2', alice, 'viewer', P2), assignment('b1', bob, 'viewer', GLOBAL), assignment('c1', carol, 'editor', f('f1')), assignment('c2', carol, 'org.member', O1), assignment('d1', dave, 'maintainer', O2), assignment('d2', dave, 'org.guest', O1), assignment('d3', dave, 'viewer', P1, { tags: ['inspect'] }), assignment('s1', svc, 'editor', GLOBAL)];

/** A world holding these rules (config rules: `authz.rbac.rules`). */
export function ruleWorld(rules: readonly Omit<RuleDef, 'source'>[]): World {
  return {
    permissions: RULE_PERMISSIONS.map((name) => ({ name, types: ['file', 'project', 'org'] })),
    principals: { alice, bob, carol, dave, svc },
    adapters: [
      {
        types: ['file', 'project', 'org'],
        rows: { file: FILES, project: [{ id: 'p1' }, { id: 'p2' }], org: [{ id: 'o1' }, { id: 'o2' }] },
        parents: [[f('f1'), P1] as const, [f('f2'), P1] as const, [f('f3'), P1] as const, [f('f4'), P2] as const, [f('f5'), P2] as const, [f('f6'), P2] as const, [P1, O1] as const, [P2, O2] as const],
        attributes: [[O1, { policies: { max_role: 'viewer', min_role: 'editor', locked: true } }] as const, [O2, { policies: { max_role: 'editor', min_role: 'viewer', locked: false } }] as const],
      },
    ],
    combine: combine('deny-overrides', 'rbac'),
    rbac: {
      ladders: [
        { name: 'project', roles: ['viewer', 'commenter', 'editor', 'maintainer'] },
        { name: 'org', roles: ['org.guest', 'org.member'] },
      ],
      roles: ROLES,
      assignments: ASSIGNMENTS,
      rules: rules.map((r) => ({ ...r, source: 'test' })),
    },
  };
}

export interface RuleProbe {
  readonly as: (typeof RULE_PRINCIPALS)[number];
  readonly permission: (typeof RULE_PERMISSIONS)[number];
  /** A file id; the check gets the file row as subject. */
  readonly file: string;
  readonly allowed: boolean;
}

export interface RuleSet {
  readonly name: string;
  readonly rules: readonly Omit<RuleDef, 'source'>[];
  /** The rules read resource.* or a when condition: they need the ConditionCompiler. */
  readonly conditions?: boolean;
  /**
   * Checks whose answer the rules flip against `ruleWorld([])`, plus at least one allowed check, so
   * that `agree` cannot pass on rules that do nothing or on an engine that denies everything. Each
   * holds for the config rules and for their `asDbRule` rows.
   */
  readonly probes: readonly RuleProbe[];
}

const probe = (as: RuleProbe['as'], permission: RuleProbe['permission'], file: string, allowed: boolean): RuleProbe => ({ as, permission, file, allowed });

/** One set per rule kind of B44: restrict, cap (constant, attribute ref, strip, drop), threshold (constant, ref, ladder/at, wildcard pattern). */
export const RULE_SETS: readonly RuleSet[] = [
  {
    name: 'restrict',
    rules: [
      { id: 'restrict-p1', kind: 'restrict', scope: P1, allow: [{ type: 'user', id: 'bob' }] },
      { id: 'restrict-f2', kind: 'restrict', scope: f('f2'), allow: [] },
    ],
    probes: [probe('svc', 'file:read', 'f1', false), probe('bob', 'file:read', 'f1', true), probe('bob', 'file:read', 'f2', false)],
  },
  { name: 'cap (constant)', rules: [{ id: 'cap-o1', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'viewer' }], probes: [probe('alice', 'file:edit', 'f1', false), probe('alice', 'file:read', 'f1', true)] },
  { name: 'cap (attribute ref)', rules: [{ id: 'cap-ref', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: { ref: 'scope.org.policies.max_role' } }], probes: [probe('alice', 'file:edit', 'f1', false), probe('svc', 'file:edit', 'f4', true)] },
  { name: 'cap (strip tags)', rules: [{ id: 'strip-p1', kind: 'cap', scope: P1, stripTags: true }], probes: [probe('alice', 'file:inspect', 'f1', false), probe('alice', 'file:edit', 'f1', true)] },
  { name: 'cap (drop)', rules: [{ id: 'drop-p2', kind: 'cap', scope: P2, ladder: 'project', maxRole: null }], probes: [probe('alice', 'file:read', 'f4', false), probe('alice', 'file:read', 'f1', true)] },
  {
    name: 'cap (subject selectors)',
    rules: [
      { id: 'cap-services', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'viewer', subjects: { principalTypes: ['service'] } },
      { id: 'cap-externals', kind: 'cap', scope: GLOBAL, ladder: 'project', maxRole: 'commenter', subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.member' } } },
    ],
    probes: [probe('svc', 'file:edit', 'f1', false), probe('carol', 'file:edit', 'f1', true)],
  },
  { name: 'threshold (constant)', rules: [{ id: 'thr-p2', kind: 'threshold', scope: P2, permissions: ['file:edit'], minRole: 'maintainer', reason: { code: 'policy' } }], probes: [probe('svc', 'file:edit', 'f4', false), probe('svc', 'file:edit', 'f1', true)] },
  { name: 'threshold (ref)', rules: [{ id: 'thr-ref', kind: 'threshold', scope: GLOBAL, permissions: ['file:read', 'file:repo'], minRole: { ref: 'scope.org.policies.min_role' }, reason: { code: 'policy' } }], probes: [probe('bob', 'file:read', 'f1', false), probe('bob', 'file:read', 'f4', true)] },
  { name: 'threshold (ladder/at)', rules: [{ id: 'thr-members', kind: 'threshold', scope: GLOBAL, permissions: ['*'], ladder: 'org', at: 'org', minRole: 'org.member', reason: { code: 'members_only' } }], probes: [probe('bob', 'file:read', 'f1', false), probe('carol', 'file:read', 'f1', true)] },
  {
    name: 'threshold (wildcard pattern)',
    conditions: true,
    rules: [{ id: 'thr-release', kind: 'threshold', scope: GLOBAL, resourceTypes: ['file'], permissions: ['file:edit'], resource: { attr: 'resource.name', wildcard: 'release/*' }, minRole: 'maintainer', reason: { code: 'branch_protected', pattern: 'release/*', priority: 700, sortKey: 'release/*' } }],
    probes: [probe('svc', 'file:edit', 'f3', false), probe('svc', 'file:edit', 'f1', true)],
  },
  {
    name: 'threshold (when on a scope attribute)',
    conditions: true,
    rules: [{ id: 'thr-locked', kind: 'threshold', scope: GLOBAL, permissions: ['file:edit'], minRole: 'maintainer', when: { attr: 'scope.org.policies.locked', eq: true }, reason: { code: 'policy' } }],
    probes: [probe('alice', 'file:edit', 'f1', false), probe('svc', 'file:edit', 'f4', true)],
  },
];

/** The probes of a set as checks with the file row as subject. */
export const probeSteps = (s: RuleSet): CheckStep[] => s.probes.map((p) => ({ check: { as: p.as, permission: p.permission, resource: f(p.file), subject: 'row' }, expect: { allowed: p.allowed } }));

/** The same rule as a DB row: config rules at GLOBAL move to o1, since `authz_rule` holds scoped rules. */
export const asDbRule = (r: Omit<RuleDef, 'source'>): Omit<RuleDef, 'source'> => (r.scope.type === GLOBAL.type ? { ...r, scope: O1 } : r);
