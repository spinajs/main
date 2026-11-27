# `@spinajs/teams`

Teams, groups and invitations on authz-v3. Teams and groups are `@AccessResource` models, membership is `authz_assignment` rows, and every write goes through `AuthzAdmin`.

It ships no HTTP routes and no `VerifiedEmailSource`: the app provides both.

## Install

```sh
npm install @spinajs/teams
```

## Features

| Feature | What it does |
| --- | --- |
| [Invitations](01-invitations.md) | Link and email invitations into a team or group: create, revoke, resend, and accept once per user under a use limit. |
| [Teams and tenancy](#teams-and-tenancy) | With `@spinajs/tenancy`, `teams.tenancy` says whether teams live inside tenants; `true` needs `@spinajs/tenancy-orm/teams` |

## Quick start

```ts sample
import type { Principal } from '@spinajs/authz';
import { DI } from '@spinajs/di';
import { InvitationService } from '@spinajs/teams';

/** Invites a colleague by email as a team member; the mail goes out at once. */
export async function inviteColleague(owner: Principal, teamId: string, email: string): Promise<void> {
  const invitations = (await DI.resolve(InvitationService)) as InvitationService;
  await invitations.create(owner, { teamId, role: 'team.member', email });
}
```

Email invitations need `teams.invitations.secret`, a registered `VerifiedEmailSource` and an email connection; see [Invitations](01-invitations.md#configuration).

## Teams and tenancy

A root team (one without a parent) hangs at the scope the `TeamRootScope` port answers: `createTeam` checks
`team:create` there, and so does `moveTeam` for a team moved to the root. The default, `GlobalTeamRootScope`, answers
`$global`, so a role that grants `team:create` at `$global` creates root teams.

An app that imports `@spinajs/tenancy` must set `teams.tenancy`:

```json
{ "teams": { "tenancy": false } }
```

- `false` keeps one global tree of teams, as without tenancy.
- `true` puts teams, groups and invitations inside tenants and needs `import '@spinajs/tenancy-orm/teams'`, which
  registers a root scope inside the tenant.

The authz domain boot (`TeamsTenancyCheck`, an `AuthzContributor`) refuses `teams.tenancy` unset while tenancy is
imported, `true` without the teams bridge and `false` with it. Without `@spinajs/tenancy` the key may stay unset.

## Related packages

- [`@spinajs/authz`](../authz/README.md): `AuthzService` and `AuthzAdmin`, which check every call and write every membership.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): the team and group roles and the `DbAssignmentStore` membership needs.
- [`@spinajs/authz-orm`](../authz-orm/README.md): the ancestor table that puts groups and app resources under a team.
- [`@spinajs/authz-abac`](../authz-abac/README.md): the archived-team policies.
- [`@spinajs/email`](../email/README.md): sends invitation mails.
- [`@spinajs/tenancy-orm`](../tenancy-orm/README.md): `@spinajs/tenancy-orm/teams` puts teams, groups and invitations inside tenants.
