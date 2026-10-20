/** Rule shapes for the DbRuleStore tests: the kit's rule sets of B06.rules and design §8.5. */
import { GLOBAL } from '@spinajs/authz';
import type { ResourceRef, RuleDef } from '@spinajs/authz';
import { BEHAVIOUR_FIXTURES, mergeFixtures } from '@spinajs/authz-testing';

import type { LadderDef } from '../../src/index.js';

export type Rule = Omit<RuleDef, 'source'>;

export const O1: ResourceRef = { type: 'org', id: 'o1' };
export const P1: ResourceRef = { type: 'project', id: 'p1' };
export const F1: ResourceRef = { type: 'file', id: 'f1' };

/** The ladders of the kit's rule worlds. */
export const KIT_LADDERS: LadderDef[] = [
  { name: 'project', roles: ['viewer', 'commenter', 'editor', 'maintainer'] },
  { name: 'org', roles: ['org.guest', 'org.member'] },
];

/** Design §8.5. */
export const CANVAS_LADDERS: LadderDef[] = [
  { name: 'project', roles: ['viewer', 'commenter', 'editor', 'maintainer'], resourceTypes: ['project', 'file', 'branch'] },
  { name: 'org', roles: ['org.file_guest', 'org.guest', 'org.member', 'org.admin', 'org.owner'] },
];

/**
 * The B06.rules cases (the kit's `RULE_SETS` without conditions) with their world's ladders, each rule
 * as `asDbRule` writes it: GLOBAL moves to o1. Read from `BEHAVIOUR_FIXTURES`, since the kit root does
 * not export `rule-worlds`.
 */
export function kitRuleSets(): { name: string; rules: Rule[]; ladders: LadderDef[] }[] {
  const part = mergeFixtures(BEHAVIOUR_FIXTURES)
    .get('B06')!
    .parts.find((p) => p.name === 'rules')!;
  return part.cases.map((c) => ({
    name: c.name,
    rules: (c.world!.rbac!.rules ?? []).map(({ source: _source, ...r }) => (r.scope.type === GLOBAL.type ? { ...r, scope: O1 } : r)),
    ladders: (c.world!.rbac!.ladders ?? []) as LadderDef[],
  }));
}

/** Design §8.5: the config rules, moved to org o1 as DB rows, and the data rows (file restriction, branch rules). */
export const CANVAS_RULES: Rule[] = [
  { id: 'file-grant-cap', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'editor', assignments: { scopeTypes: ['file'] } },
  { id: 'link-cap', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'commenter', assignments: { subjectTypes: ['link'] } },
  { id: 'link-org-cap', kind: 'cap', scope: O1, ladder: 'project', maxRole: { ref: 'scope.org.policies.max_link_role' }, assignments: { subjectTypes: ['link'] } },
  { id: 'guest-cap', kind: 'cap', scope: O1, ladder: 'project', maxRole: 'editor', subjects: { rank: { ladder: 'org', at: 'org', eq: 'org.guest' } } },
  { id: 'guest-org-cap', kind: 'cap', scope: O1, ladder: 'project', maxRole: { ref: 'scope.org.policies.guest_max_role' }, subjects: { rank: { ladder: 'org', at: 'org', eq: 'org.guest' } } },
  { id: 'external-cap', kind: 'cap', scope: O1, ladder: 'project', maxRole: { ref: 'scope.org.policies.external_max_role' }, subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.guest' } } },
  {
    id: 'external-sharing-off',
    kind: 'cap',
    scope: O1,
    ladder: 'project',
    maxRole: null,
    subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.guest' } },
    assignments: { subjectTypes: ['user', 'group'] },
    when: { attr: 'scope.org.policies.external_sharing', eq: false },
  },
  { id: 'guest-addons', kind: 'cap', scope: O1, stripTags: true, subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.member' } }, when: { attr: 'scope.org.policies.addons_for_guests', eq: false } },
  { id: 'link-addons', kind: 'cap', scope: O1, stripTags: true, assignments: { subjectTypes: ['link'] }, when: { attr: 'scope.org.policies.addons_for_guests', eq: false } },
  { id: 'no-download', kind: 'threshold', scope: O1, permissions: ['project:export', 'repo:read'], minRole: 'editor', when: { attr: 'scope.org.policies.viewers_may_download', eq: false }, reason: { code: 'policy', rule: 'no_download' } },
  { id: 'editors-may-not-invite', kind: 'threshold', scope: O1, permissions: ['grants:invite'], minRole: 'maintainer', when: { attr: 'scope.org.policies.editors_may_invite', eq: false }, reason: { code: 'policy', rule: 'editors_may_not_invite' } },
  { id: 'delete-needs-org-admin', kind: 'threshold', scope: O1, permissions: ['project:delete'], ladder: 'org', at: 'org', minRole: 'org.admin', when: { attr: 'scope.org.policies.maintainers_may_delete', eq: false }, reason: { code: 'policy', rule: 'delete_needs_org_admin' } },
  // data rows
  { id: 'restrict:file:f1', kind: 'restrict', scope: F1, allow: [{ type: 'user', id: 'u1' }, { set: { role: 'group.member', scope: { type: 'group', id: 'g1' } } }] },
  {
    id: 'branch:p1:release/*:push',
    kind: 'threshold',
    scope: P1,
    resourceTypes: ['branch'],
    permissions: ['repo:push', 'branch:create', 'mr:create'],
    resource: { attr: 'resource.name', wildcard: 'release/*' },
    minRole: 'editor',
    reason: { code: 'branch_protected', pattern: 'release/*', needed: 'editor', priority: 700, sortKey: 'release/*' },
  },
  {
    id: 'branch:p1:release/*:merge',
    kind: 'threshold',
    scope: P1,
    resourceTypes: ['branch'],
    permissions: ['branch:merge'],
    resource: { attr: 'resource.name', wildcard: 'release/*' },
    minRole: 'maintainer',
    reason: { code: 'branch_protected', pattern: 'release/*', needed: 'maintainer', priority: 700, sortKey: 'release/*' },
  },
];

/** §8.5's `link-members-only`: its `when` ORs a principal attribute with a scope attribute, which only config rules may do. */
export const LINK_MEMBERS_ONLY: Rule = {
  id: 'link-members-only',
  kind: 'threshold',
  scope: O1,
  permissions: ['*'],
  subjects: { principalTypes: ['link'] },
  when: {
    any: [
      { attr: 'principal.attributes.org_only', eq: true },
      { attr: 'scope.org.policies.public_links', eq: false },
    ],
  },
  ladder: 'org',
  at: 'org',
  minRole: 'org.guest',
  reason: { code: 'link_invalid', priority: 300 },
};
