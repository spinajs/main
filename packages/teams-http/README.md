# `@spinajs/teams-http`

REST API over `@spinajs/teams` (teams, groups, members, invitations). Every route calls
`TeamService`, `GroupService` or `InvitationService` with the request principal as the actor; the
services are the authority, the routes add the HTTP surface.

## Routes

| Route | Access | Service |
|---|---|---|
| `GET /teams?parentId=&root=&page=&size=` | `team:read` (type level) | `listTeams` (`.accessible('team:read')`) |
| `POST /teams` `{ slug, name, description?, parentId? }` | `team:create` (type level; exact scope in the service) | `createTeam` |
| `GET` / `PATCH` / `DELETE /teams/:team` | `team:read` / `team:update` / `team:delete` at the team | `getTeam` / `updateTeam` / `deleteTeam` (soft) |
| `POST /teams/:team/restore` | `team:delete` | `restoreTeam` |
| `POST /teams/:team/archive`, `…/unarchive` | `team:archive` | `archiveTeam` / `unarchiveTeam` |
| `POST /teams/:team/move` `{ parentId }` | `team:update` (+ `team:create` at the new parent, in the service) | `moveTeam` |
| `POST /teams/:team/transfer` `{ to: 'user:<id>', keepAs? }` (the caller keeps `keepAs`, default `team.admin`; `null`: nothing) | `team:ownership.transfer` | `transferOwnership` |
| `GET /teams/:team/members?page=&size=` | `team:read` | `members` |
| `POST /teams/:team/members` `{ subject, role? }` | `team:members.manage` | `addTeamMember` |
| `PATCH /teams/:team/members/:subject` `{ role }` | `team:roles.manage` | `setTeamRole` |
| `DELETE /teams/:team/members/:subject` | `team:members.manage` | `removeTeamMember` |
| `GET /teams/:team/groups?page=&size=` | `team:read` | `listGroups` (`.accessible('group:read').within(team)`) |
| `POST /teams/:team/groups` `{ slug, name, description?, parentId? }` | `group:create` at the team | `createGroup` |
| `GET` / `PATCH` / `DELETE /groups/:group` | `group:read` / `group:update` / `group:delete` | `getGroup` / `updateGroup` / `deleteGroup` |
| `POST /groups/:group/move` `{ teamId?, parentId }` | `group:update` | `moveGroup` |
| `GET /groups/:group/members?page=&size=` | `group:read` | `members` |
| `POST /groups/:group/members` `{ subject }`, `DELETE /groups/:group/members/:subject` | `group:members.manage` | `addGroupMember` / `removeGroupMember` |
| `GET /teams/:team/invitations?page=&size=` | `team:invitations.manage` | `InvitationService.list` |
| `POST /teams/:team/invitations` `{ groupId?, role, email?, maxUses?, expiresInHours? }` | `team:invitations.manage` | `InvitationService.create` |
| `DELETE /teams/:team/invitations/:invitation`, `POST …/:invitation/resend` | `team:invitations.manage` | `revoke` / `resend` |
| `POST /invitations/accept` `{ token }` | authenticated | `InvitationService.accept` |
| `GET /user/teams` | authenticated | `TeamService.teamsOf` |

- Subjects are `user:<id>`, `group:<id>` or `team:<id>` (any `<type>:<id>` names a principal), in
  bodies and (URL-encoded) in paths.
- Every list is paged: `page` from 0 (default 0), `size` 1 to 200 (default 50); the answer is
  `{ items, total }`, `total` counting every row the caller may see.
- Granting a role to a whole team or group on another team's resource (cross-team sharing) has no
  route here: use `@spinajs/authz-http-admin`'s `POST /authz/assignments` (subject
  `{ set: { role: 'team.member', scope: { type: 'team', id } } }` or `group.member` at the group) and
  `DELETE /authz/assignments/:id`. The teams fragment maps those commands at team and group scopes to
  the teams permissions, so team admins need no `authz:*` permission. `TeamService.grant` / `revoke`
  are the same for in-process callers.
- Writes on a team, group or invitation answer it; membership changes, deletes and revocations answer
  `{ ok: true }`. Dates are ISO 8601 strings.

## Access

- The route's `@Access` checks at the team or group in the path, or at type level for `GET /teams` and
  `POST /teams`; the service checks the exact scope again (a root team needs `team:create` at
  `$global`, a sub-team at its parent). A caller who can read no team gets 403 from `GET /teams`:
  `GET /user/teams` is "my teams" for everyone.
- `POST /invitations/accept` and `GET /user/teams` check authentication only: the token is the
  authorisation of the first, the second answers about the caller only. No route allows anonymous
  callers.
- Lists are filtered in SQL by the services (`.accessible()`, `.within()` of `@spinajs/authz-orm`).

## Errors

A refused service call answers `{ error: { code, message, field? } }`:

| Status | Codes |
|---|---|
| 400 | `invalid_request` and the AuthzAdmin validation codes (`unknown_role`, `wrong_scope_type`, `not_assignable`, `set_cycle`, `set_too_deep`, …) |
| 403 | `forbidden`, `escalation`, `last_holder`, `self_lockout`, `protected_role`, `invitation_email_mismatch`, `invitation_not_a_user` |
| 404 | `not_found`, `invitation_unknown` |
| 409 | `conflict`, `invitation_expired`, `invitation_revoked`, `invitation_used_up` |

The AuthzAdmin codes answer as on `@spinajs/authz-http-admin`. A body or query parameter that does
not match its schema answers http's validation 400; a refusal of the route's `@Access` answers
authz-http's 403 `{ error: 'forbidden', permission, resource, reason }`.

## Invitations

The token is in the answer of `POST /teams/:team/invitations` (sent with `Cache-Control: no-store`)
or in the invitation mail, nowhere else; lists and resends never carry it or its hash. A resend mails
a new token and the old one stops working. A new user signs up through any login flow, then calls
`POST /invitations/accept` with the token the client kept; an email invitation opens only for a
principal whose verified email (`VerifiedEmailSource`) is the invited one.

## Setup

- Install the package: its config fragment adds `lib/<mjs|cjs>/controllers` to
  `system.dirs.controllers`. An app that mounts controllers by hand registers
  `TEAMS_HTTP_CONTROLLERS`.
- `@spinajs/teams` brings the roles, permissions, migrations, guard rules and the archived policies;
  the app wires RBAC (`registerRbac`), an ABAC model over `authz.abac.policies`, a scope attribute
  store and the admin backend as for any authz app, registers a `VerifiedEmailSource` (email
  invitations fail without one), gives some role `team:create` at `$global`, and sets
  `teams.invitations.secret`.

## Swagger

http-swagger documents every route: the `@Access` permission (`x-authz-*`), the request bodies (the
`@Schema` DTO classes), the query parameters and the answers (`Teams*` schemas served by
`TeamsHttpSchemaProvider`).
