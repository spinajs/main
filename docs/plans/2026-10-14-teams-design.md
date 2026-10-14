# Teams and groups: design

Date: 2026-10-14. Status: accepted direction, not built.

Builds on `2026-10-14-authz-resource-access-design.md` (cited as *resource-access §n*) and its implementation plan
`docs/superpowers/plans/2026-10-14-authz-resource-access/`. Requirements input:
`agent-conductor/docs/superpowers/specs/2026-10-14-teams-requirements.md`, generalised: nothing here depends on a
specific application, UI kit, identity provider or external service.

## 1. Decision

1. **Teams and groups are first-class, general entities** in two new packages, `@spinajs/teams` (models, services,
   migrations, invitations) and `@spinajs/teams-http` (REST API). They are built only on authz-v3 primitives:
   resources with `@Parent`, assignments, subject sets, the membership closure and `AuthzAdmin`.
2. **One hierarchy: team → group → member.** A team may have a parent team. A group belongs to a team and may contain
   groups. A member is a user or a group.
3. **Roles are assigned to a subject at a scope.** Subjects are users, group sets and team sets; scopes are `$global`,
   teams, groups and any resource. Role definitions stay global (config), may `extend` each other, and are limited to
   scope types.
4. **Membership flows upward, roles flow downward.** A member of a nested group is a member of every outer group and of
   the team; a member of a sub-team is a member of the parent team (switchable). A role at a scope covers everything
   below that scope.
5. **Whole teams and groups can hold roles anywhere**, including on another team's resources (cross-team sharing).
6. **A user may be a direct team member, a member through groups, or both.**
7. **Invitations are part of v1.**
8. **Team-owned machine principals are deferred** (`docs/plans/TODO.md`).

## 2. The two trees

| Tree | Answers | Mechanism (resource-access) |
|---|---|---|
| Scope tree (resources) | "a role at X applies to everything below X" | `authz_resource_ancestor` (§4.1). `team` → sub-`team` → `group` → sub-`group`, and every resource with `@Parent('team')` or `@Parent('group')`. |
| Subject tree (people) | "who belongs to X" | `authz_subject_membership` (§4.3). user ∈ group ∈ outer group ∈ team ∈ parent team. |

Both are closure tables, so neither checks nor lists walk a tree at request time.

## 3. Subjects and sets

| Set | Key | Members |
|---|---|---|
| Group members | `group:<id>#group.member` | users and groups added to the group; every holder of a role that extends `group.member` at the group |
| Team members | `team:<id>#team.member` | direct members; every group of the team (as a set); every sub-team (as a set) when `teams.membership.subTeamsInParent` is true; every holder of a role that extends `team.member` at the team |

- Adding a user to a group is `set.addMember { set: { role: 'group.member', scope: group:G }, member: user:U }`.
- Linking a group into its team is `assignment.grant { subject: { set: { role: 'group.member', scope: group:G } }, role: 'team.member', scope: team:T }` (`set.addMember` takes principals only). `@spinajs/teams` writes these links itself on create and move; apps never write them.
- A nested group is linked into its outer group the same way (`group:Inner#group.member` granted `group.member` at `group:Outer`).
- Cycles are refused by the membership closure (`set_cycle`, resource-access L6).

## 4. Roles

Defaults shipped as a config fragment in `@spinajs/teams` (apps extend, replace or drop them through config):

```ts
authz: { rbac: {
  ladders: { team: { roles: ['team.member', 'team.admin', 'team.owner'], resourceTypes: ['team', 'group'] } },
  roles: {
    'team.member':   { subjectSet: true, scopeTypes: ['team'], ladder: 'team',
                       grants: ['team:read', 'group:read'] },
    'team.admin':    { scopeTypes: ['team'], ladder: 'team', extends: ['team.member'],
                       grants: ['team:update', 'team:members.manage', 'team:roles.manage', 'team:invitations.manage',
                                'group:create', 'group:update', 'group:delete', 'group:members.manage'] },
    'team.owner':    { scopeTypes: ['team'], ladder: 'team', extends: ['team.admin'],
                       grants: ['team:delete', 'team:archive', 'team:ownership.transfer', 'team:create'] },
    'group.member':  { subjectSet: true, scopeTypes: ['group'], grants: ['group:read'] },
    'group.manager': { scopeTypes: ['group'], extends: ['group.member'],
                       grants: ['group:update', 'group:members.manage'] },
  },
} },
admin: { guard: { keepHolders: [{ role: 'team.owner', scopeType: 'team' }] } }
```

- Team roles held at `team:T` cover T's groups (they are below T in the scope tree) and every resource T owns.
- Group roles cover only that group and what it owns.
- Roles held by a group or team set reach every member of that set, nested members included.
- `team:create` at a team allows creating sub-teams under it. Creating a root team needs `team:create` at `$global`.
- Every permission above is registered by `@spinajs/teams` (`authz.permissions` fragment). `team:read` and `group:read`
  are `list: true`.

## 5. Guard rules

- **Keep holders** (resource-access lane L8 addition): `authz.admin.guard.keepHolders: [{ role, scopeType }]` refuses
  (`last_holder`) a batch that leaves a scope of `scopeType` without a live holder of `role` (directly or through a set
  with at least one live member). Default for teams: one `team.owner` per team.
- The guard runs before each command of a batch, not once at its end, so a batch that replaces the last owner must
  grant the new owner before revoking the old one. `TeamService.transferOwnership` orders its batch that way.
- **Archived teams**: an ABAC deny policy shipped by `@spinajs/teams`, `effect: 'deny'`,
  `permissions: ['*:create', '*:update', '*:delete']` except `team:archive`/`team:update` for unarchiving, condition
  `scope.team.archived eq true`; `archived` is a scope attribute (`authz_scope_attribute`) written by
  `TeamService.archive`. This needs `scope.team.*` conditions (scope attributes), which ABAC already evaluates for
  checks; for lists it is principal-independent and is applied by the service, not by the list plan (resource-access
  decision 17 refuses scoped ABAC on list permissions). `team:read`/`group:read` stay allowed on archived teams.

## 6. Data model (`@spinajs/teams`)

```
teams(
  id            varchar(36)  PK (uuid),
  parent_id     varchar(36)  null  → teams.id      -- @Parent('team', { nullable: true })
  slug          varchar(64)  not null unique,
  name          varchar(128) not null,
  description   text,
  archived_at   datetime,
  deleted_at    datetime,                         -- soft delete; purge after teams.deletion.graceDays
  created_by    varchar(100),
  created_at    datetime not null,
  updated_at    datetime not null
)
groups(
  id            varchar(36)  PK,
  team_id       varchar(36)  not null → teams.id   -- @Parent('team')
  parent_id     varchar(36)  null  → groups.id     -- @Parent('group', { nullable: true })
  slug          varchar(64)  not null,             -- unique per team
  name          varchar(128) not null,
  description   text,
  created_by    varchar(100),
  created_at    datetime not null,
  updated_at    datetime not null,
  UNIQUE(team_id, slug)
)
team_invitations(
  id            varchar(36)  PK,
  team_id       varchar(36)  not null → teams.id,
  group_id      varchar(36)  null → groups.id,     -- join a group instead of the team directly
  role          varchar(128) not null,             -- assigned on accept (team role, or group role when group_id)
  email         varchar(255) null,                 -- null = shareable link
  token_hash    varchar(128) not null unique,      -- 'v1:' + HMAC-SHA256(token, teams.invitations.secret)
  max_uses      int          null,                 -- 1 = single use; null = unlimited until expiry
  uses          int          not null default 0,
  expires_at    datetime     not null,
  revoked_at    datetime,
  created_by    varchar(100) not null,
  created_at    datetime not null,
  last_sent_at  datetime
)
team_invitation_uses(invitation_id, principal, used_at)  UNIQUE(invitation_id, principal)
```

- `Team` and `Group` are `@AccessResource('team')` / `@AccessResource('group')`, so checks, lists (`.accessible()`)
  and the closure tables work without extra code.
- A group's parent group must belong to the same team (service check, `InvalidArgument`).
- Membership and roles have no tables of their own: they are `authz_assignment` rows and their closure.

## 7. Services

`TeamService` and `GroupService` (DI singletons). Every authorization write goes through `AuthzAdmin.execute` in one
batch with the model write's transaction where possible; each method checks its permission first (`assert`).

| Method | Permission (at) | Does |
|---|---|---|
| `createTeam(actor, { slug, name, description?, parentId? })` | `team:create` at parent or `$global` | insert team; assign `team.owner` to actor; link into parent's set when enabled |
| `updateTeam`, `moveTeam(actor, id, parentId)` | `team:update` at team (+ `team:create` at new parent) | update; move re-parents (closure) and re-links sets |
| `archiveTeam` / `unarchiveTeam` | `team:archive` | set `archived_at`, scope attribute `archived` |
| `deleteTeam` / `purgeTeam` | `team:delete` | soft delete; purge after grace: hard delete (resource-access delete clean-up forgets the scopes) and emits `TeamPurged` |
| `addTeamMember(actor, teamId, subject, role = 'team.member')` | `team:members.manage` | assignment of `role` at team |
| `removeTeamMember`, `setTeamRole` | `team:members.manage` / `team:roles.manage` | revoke / replace; guard keeps one owner |
| `transferOwnership(actor, teamId, to, { keepAs = 'team.admin' })` | `team:ownership.transfer` | one batch: grant owner to `to`, then revoke owner from actor; actor keeps `keepAs` (null = leaves the team) |
| `createGroup(actor, teamId, { slug, name, parentId? })` | `group:create` at team | insert; link group set into team set (or outer group set) |
| `moveGroup`, `updateGroup`, `deleteGroup` | `group:update` / `group:delete` | as for teams |
| `addGroupMember(actor, groupId, subject)` / `removeGroupMember` | `group:members.manage` at group | `set.addMember` / `set.removeMember` |
| `grant(actor, subject, role, scope)` / `revoke` | `team:roles.manage` at the scope's team, or the command permission at the scope | general role assignment, e.g. a group or a whole team on another team's resource |
| `teamsOf(principal)` | — | the principal's teams and groups with effective roles (reads assignments + membership) |

Subjects accepted everywhere: `{ type: 'user', id }`, `{ group: id }`, `{ team: id }` (mapped to set subjects).

## 8. Invitations

- `InvitationService.create(actor, { teamId, groupId?, role, email?, maxUses?, expiresIn })`: needs
  `team:invitations.manage`; the inviter must cover `role` (`AuthzService.covers`, no escalation through invites).
  Returns the token once. Email invitations are mailed through `@spinajs/email` with a template from
  `teams.invitations.template`; resend updates `last_sent_at`.
- `accept(principal, token)`: an authenticated user principal; checks expiry, revocation, `max_uses`, and (for email
  invitations) that the principal's verified email equals the invitation email. Assigns the role (team) or adds the
  member (group) through `AuthzAdmin` as `SYSTEM` with reason `invitation:<id>`; records the use; idempotent for the
  same principal.
- New users: the app's sign-up flow (local password, OIDC, anything) ends with a normal login; the client then calls
  accept with the token it kept. `@spinajs/teams` does not hook into sign-up.
- `list`, `revoke`, `resend` for `team:invitations.manage`.
- Tokens: 32 random bytes base64url; stored as HMAC like share links; `teams.invitations.secret` (≥ 32 chars, no
  default; checked on first use).

## 9. HTTP (`@spinajs/teams-http`)

REST under `/teams`, every route with `@Access`, Swagger schemas:

- `GET/POST /teams`, `GET/PATCH/DELETE /teams/:team`, `POST /teams/:team/archive|unarchive|move|transfer`
- `GET/POST /teams/:team/members`, `PATCH/DELETE /teams/:team/members/:subject` (subject `user:<id>`, `group:<id>`)
- `GET/POST /teams/:team/groups`, `GET/PATCH/DELETE /groups/:group`, `POST /groups/:group/move`
- `GET/POST /groups/:group/members`, `DELETE /groups/:group/members/:subject`
- `GET/POST /teams/:team/invitations`, `DELETE /teams/:team/invitations/:id`, `POST /teams/:team/invitations/:id/resend`
- `POST /invitations/accept` (body `{ token }`)
- `GET /user/teams` — the caller's teams and groups with effective roles
- Lists use `.accessible()` and `.within(team)` (resource-access L4 addition).

## 10. Additions to the resource-access plan

| Lane | Addition |
|---|---|
| L4 authz-orm lists | `.within(ref)` list helper: keeps rows that are `ref` or descend from it (ancestor table), usable for any scope (active team, project, folder). |
| L6 rbac storage | Tests and, if needed, fixes for set-in-set membership: team ⊃ group ⊃ group ⊃ user, sub-team ⊃ parent team, membership through a role that extends a subject-set role, move of a group between teams (re-link) keeping the closure right. |
| L8 rbac model + guard | `authz.admin.guard.keepHolders` rule (§5). |

## 11. Not in v1

Team-owned machine principals and team-owned API/agent tokens, external directory sync, quotas: `docs/plans/TODO.md`.
