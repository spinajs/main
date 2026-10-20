// The `rules` array of design §8.5, verbatim (no scope: config rules apply at GLOBAL).
export const CANVAS_RULES: readonly unknown[] = [
  { id: 'file-grant-cap', kind: 'cap', ladder: 'project', maxRole: 'editor', assignments: { scopeTypes: ['file'] } },
  { id: 'link-cap', kind: 'cap', ladder: 'project', maxRole: 'commenter', assignments: { subjectTypes: ['link'] } },
  { id: 'link-org-cap', kind: 'cap', ladder: 'project', maxRole: { ref: 'scope.org.policies.max_link_role' }, assignments: { subjectTypes: ['link'] } },
  { id: 'guest-cap', kind: 'cap', ladder: 'project', maxRole: 'editor', subjects: { rank: { ladder: 'org', at: 'org', eq: 'org.guest' } } },
  { id: 'guest-org-cap', kind: 'cap', ladder: 'project', maxRole: { ref: 'scope.org.policies.guest_max_role' }, subjects: { rank: { ladder: 'org', at: 'org', eq: 'org.guest' } } },
  { id: 'external-cap', kind: 'cap', ladder: 'project', maxRole: { ref: 'scope.org.policies.external_max_role' }, subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.guest' } } },
  {
    id: 'external-sharing-off',
    kind: 'cap',
    ladder: 'project',
    maxRole: null,
    subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.guest' } },
    assignments: { subjectTypes: ['user', 'group'] },
    when: { attr: 'scope.org.policies.external_sharing', eq: false },
  },
  { id: 'guest-addons', kind: 'cap', stripTags: true, subjects: { principalTypes: ['user'], rank: { ladder: 'org', at: 'org', lt: 'org.member' } }, when: { attr: 'scope.org.policies.addons_for_guests', eq: false } },
  { id: 'link-addons', kind: 'cap', stripTags: true, assignments: { subjectTypes: ['link'] }, when: { attr: 'scope.org.policies.addons_for_guests', eq: false } },
  {
    id: 'link-members-only',
    kind: 'threshold',
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
  },
  { id: 'no-download', kind: 'threshold', permissions: ['project:export', 'repo:read'], minRole: 'editor', when: { attr: 'scope.org.policies.viewers_may_download', eq: false }, reason: { code: 'policy', rule: 'no_download' } },
  { id: 'editors-may-not-invite', kind: 'threshold', permissions: ['grants:invite'], minRole: 'maintainer', when: { attr: 'scope.org.policies.editors_may_invite', eq: false }, reason: { code: 'policy', rule: 'editors_may_not_invite' } },
  { id: 'delete-needs-org-admin', kind: 'threshold', permissions: ['project:delete'], ladder: 'org', at: 'org', minRole: 'org.admin', when: { attr: 'scope.org.policies.maintainers_may_delete', eq: false }, reason: { code: 'policy', rule: 'delete_needs_org_admin' } },
];
