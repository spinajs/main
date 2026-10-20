const team = (description: string, extra: Record<string, unknown> = {}) => ({ types: ['team'], description, ...extra });
// Team roles grant group permissions at a team, and DefaultAdminGuard checks a granted role's permissions at the
// grant scope (an undeclared type counts as not held), so they declare team too.
const group = (description: string, extra: Record<string, unknown> = {}) => ({ types: ['group', 'team'], description, ...extra });

/**
 * Teams design §4-5. Apps extend, replace or drop any part through their own config; arrays (policies,
 * keepHolders) are concatenated by the configuration merge.
 */
const teamsConfig = {
  authz: {
    permissions: {
      'team:read': team('Read a team', { list: true }),
      'team:update': team('Rename or move a team'),
      'team:members.manage': team('Add and remove team members'),
      'team:roles.manage': { types: ['team', 'group'], description: 'Change the roles held at a team or its groups' },
      'team:invitations.manage': team('Invite to a team'),
      'team:delete': team('Delete a team'),
      'team:archive': team('Archive and unarchive a team'),
      'team:ownership.transfer': team('Hand the team to another owner'),
      'team:create': team('Create a sub-team here (at $global: a root team)'),
      'group:read': group('Read a group', { list: true }),
      'group:create': group('Create a group in a team'),
      'group:update': group('Rename or move a group'),
      'group:delete': group('Delete a group'),
      'group:members.manage': group('Add and remove group members'),
    },
    rbac: {
      // No resourceTypes: the ladder's grants apply to every type below a team, app types included.
      ladders: { team: { roles: ['team.member', 'team.admin', 'team.owner'] } },
      roles: {
        'team.member': { subjectSet: true, scopeTypes: ['team'], ladder: 'team', grants: ['team:read', 'group:read'] },
        'team.admin': {
          scopeTypes: ['team'],
          ladder: 'team',
          extends: ['team.member'],
          grants: ['team:update', 'team:members.manage', 'team:roles.manage', 'team:invitations.manage', 'group:create', 'group:update', 'group:delete', 'group:members.manage'],
        },
        'team.owner': { scopeTypes: ['team'], ladder: 'team', extends: ['team.admin'], grants: ['team:delete', 'team:archive', 'team:ownership.transfer', 'team:create'] },
        'group.member': { subjectSet: true, scopeTypes: ['group'], grants: ['group:read'] },
        'group.manager': { scopeTypes: ['group'], extends: ['group.member'], grants: ['group:update', 'group:members.manage'] },
      },
    },
    abac: {
      // scope.team.* on a resource without a team ancestor is indeterminate, so both policies name their types;
      // apps add their own team-owned types with the same condition.
      policies: [
        {
          id: 'teams.archived.write',
          effect: 'deny',
          // team:archive matches neither, so an archived team can still be unarchived.
          permissions: ['*:create', '*:update'],
          resourceTypes: ['team', 'group'],
          when: { attr: 'scope.team.archived', eq: true },
          reason: 'team_archived',
        },
        {
          id: 'teams.archived.delete',
          effect: 'deny',
          // Not on team: archiving must never block deleting the team.
          permissions: ['*:delete'],
          resourceTypes: ['group'],
          when: { attr: 'scope.team.archived', eq: true },
          reason: 'team_archived',
        },
      ],
    },
    scopes: {
      attributes: {
        team: { schema: { type: 'object', properties: { archived: { type: 'boolean' } } }, defaults: { archived: false } },
      },
    },
    admin: {
      // AuthzAdmin checks these at team and group scopes instead of authz:*; SYSTEM batches are checked too.
      permissions: {
        'assignment.*': { team: 'team:members.manage', group: 'team:roles.manage' },
        'set.*': { team: 'team:members.manage', group: 'group:members.manage' },
        'scope.setAttributes': { team: 'team:archive' },
        'list.assignments': { team: 'team:read', group: 'group:read' },
      },
      guard: { keepHolders: [{ role: 'team.owner', scopeType: 'team' }] },
    },
  },
};

export default teamsConfig;
