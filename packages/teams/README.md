# @spinajs/teams

Teams, groups and invitations on authz-v3. Nothing here is app specific: teams and groups are ordinary
`@AccessResource` models, membership is `authz_assignment` rows and their closure, and every write goes through
`AuthzAdmin`.

## Model

- **Scope tree:** `team` → sub-`team` → `group` → sub-`group`, plus every resource an app declares with
  `@Parent('team')` or `@Parent('group')`. A role at a scope covers everything below it.
- **Subject tree:** a user in a nested group is a member of every outer group and of the team; a sub-team's members
  are members of the parent team (`teams.membership.subTeamsInParent`, default `true`, read when a link is written).
- **Subjects** accepted everywhere: `{ type, id }` (a principal), `{ group: id }` (`group:<id>#group.member`),
  `{ team: id }` (`team:<id>#team.member`). A whole team or group can hold any role anywhere, including on another
  team's resources (`TeamService.grant`).

## Setup

1. Depend on `@spinajs/teams`; its config fragment ships the roles (`team.member` < `team.admin` < `team.owner` on
   ladder `team`, `group.member`, `group.manager`), the permissions, the archived-team policy, the
   `authz.admin.permissions` mapping and `authz.admin.guard.keepHolders: [{ role: 'team.owner', scopeType: 'team' }]`.
   The ladder applies to every type below a team: grants you add to the team roles (e.g. `project:read` to
   `team.member`) reach your team-owned resources. Such a permission must also declare type `team` (see
   [App permissions on team roles](#app-permissions-on-team-roles)).
2. Run the migrations `Teams_2026_10_14_00_00_00` and `TeamsInvitations_2026_10_14_00_01_00` on the connection
   `default`, next to the authz-rbac, authz-orm and authz-abac tables (one connection: authz-orm checks it at boot).
3. Use `DbAssignmentStore` (the membership closure needs it) and `DbAuthzAdminBackend`.
4. Grant `team:create` at `$global` to whoever may create root teams (an app role).
5. For email invitations register a `VerifiedEmailSource` (teams ships none: it cannot know which of your
   principals' addresses are verified); without one they are refused with `InvalidOperation`.
6. Set `teams.invitations.secret` (≥ 32 characters, no default) and, for email invitations, `teams.invitations.url`
   (the page that accepts; the token is added as `?token=`), `teams.invitations.template` (else a plain text mail),
   `teams.invitations.subject`, `teams.invitations.connection` (else `email.defaultConnection`).
7. Archiving needs `@spinajs/authz-abac`; without an ABAC model the policy is not evaluated and archived teams stay
   writable.

## App permissions on team roles

Every app permission that a team role (`team.member`, `team.admin`, `team.owner`) grants must list `team` in its
`types`, next to the app's own type. The admin guard (`CheckRbacAdminFacts.covers`) checks each permission of a
granted role at the grant scope, which for a team role is the team. A permission whose `types` leave out `team`
counts as not held there, so every grant of that role by a user (adding a member, `setTeamRole`,
`transferOwnership`, creating an invitation) fails with `escalation`, even for the team's owner, and the `escalation`
message names the role, not the permission at fault. Only grants made as SYSTEM (the owner at team creation) skip the
guard. The same applies to group roles at a `group` scope: their app permissions list `group`.

```ts
// The app's config, merged with the teams fragment (role grants concatenate).
export default {
  authz: {
    permissions: {
      'project:read': { types: ['project', 'team'] },
      'project:update': { types: ['project', 'team'] },
    },
    rbac: {
      roles: {
        'team.member': { grants: ['project:read'] },
        'team.admin': { grants: ['project:update'] },
      },
    },
  },
};
```

## Services

`TeamService`, `GroupService`, `InvitationService` (DI tokens). Each method checks the actor first and throws
`AccessDenied`; refused admin batches throw `AuthzAdminFailure` with the guard's code (`escalation`, `last_holder`,
`set_cycle`, `forbidden`).

- People-facing writes (members, roles, transfers, grants) run as the actor, so the admin guard refuses escalation,
  removal of higher ranks and removing the last owner. Structural writes (owner on create, set links, archive,
  invitation accept) run as SYSTEM after the service's own check.
- Creating a team or group writes the authz batch first, then the row; a failed insert is undone by a second batch.
  A crash between the two leaves assignments at a scope with no row (inert, removable with `scope.forget`), never a
  team without an owner.
- `setTeamRole` replaces every role the subject holds at the team; `transferOwnership(actor, team, to, { keepAs })`
  grants the new owner first and leaves the previous owner `keepAs` (default `team.admin`, `null`: nothing).
- `grant`/`revoke` at a team or group need `team:roles.manage` there; at any other scope AuthzAdmin's permission for
  that scope type decides (`authz.admin.permissions`, default `authz:assignments.manage`).
- `teamsOf(principal)`: the principal's teams and groups with the roles held at each (directly or through a set).
- Lists (`listTeams`, `listGroups`, `members`, `InvitationService.list`) take `{ limit, offset }` (default 100, at most 500) and return `{ items, total }`; teams and groups use `.accessible('team:read')` / `.accessible('group:read').within(team)`.
- `InvitationRefused.code` (`INVITATION_REFUSALS`) is stable; map it in HTTP, not the message.

## Archive, delete, purge

- `archiveTeam` sets the scope attribute `archived`; `teams.archived.write` denies `*:create` and `*:update` on the
  team and its groups, `teams.archived.delete` denies `*:delete` on its groups. The team itself stays deletable.
  Both name their types (`scope.team.*` is indeterminate on a resource with no team ancestor): add the same
  condition for your own team-owned types to freeze them too. A sub-team is judged by its own `archived`.
  Do not mark a `*:create|update|delete` permission of those types `list: true`: ABAC cannot plan `scope.*` policies.
- `deleteTeam` is a soft delete: the team disappears from every service, its writes freeze, `restoreTeam` brings it
  back (needs `team:delete`); `purgeTeam(actor, id)` purges it at once. `purgeDue(now)` (call it from a scheduler) hard-deletes teams deleted more than
  `teams.deletion.graceDays` (default 30) ago, with their sub-teams, groups and invitations; authz-orm forgets their
  scopes; each purge publishes `TeamPurged` (`{ team, slug, teams, groups }`) to every `AuthzEventSink`. It returns
  `{ purged, failed }`: a team whose purge throws is logged (`teams` logger) and listed in `failed`, the run goes on
  with the other teams, and the next run retries it.

## Invitations

`create` needs `team:invitations.manage` and is judged as the accept command run by the inviter (AuthzAdmin dry
run), so nobody invites into a role they could not grant. The token (32 random bytes, base64url) is returned once
and stored as `v1:` + HMAC-SHA256. Email invitations are mailed at once (never queued) through `InvitationMailer`
and bound to the address; `accept` compares it with the app's `VerifiedEmailSource`. `resend` mails a new token.
`accept` is idempotent per user, honours `maxUses`, expiry and revocation, and runs as SYSTEM with reason
`invitation:<id>`. Before it grants, `accept` judges the inviter (`created_by`) again as `create` did:
`team:invitations.manage` at the team and the dry run, by the inviter's assignments at that moment. An inviter
demoted or removed since then gets `InvitationRefused` `inviter_lost_authority`, and no use is counted. New users
sign up through the app's own flow and then accept with the token they kept.

## Config (`teams.*`)

| Key | Default |
|---|---|
| `membership.subTeamsInParent` | `true` |
| `deletion.graceDays` | `30` |
| `invitations.secret` | none (required for invitations) |
| `invitations.defaultTtlHours` | `168` |
| `invitations.subject` | `You are invited to join a team` |
| `invitations.template`, `invitations.url`, `invitations.connection` | none |
