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
| [Teams and tenancy](#teams-and-tenancy) | With `@spinajs/tenancy` the app must set `teams.tenancy`; in this release only `false` boots, and teams stay global. |

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

`false` keeps one global tree of teams: a team can hold users of several tenants, and a team id of one tenant is found
from another. Teams, groups and invitations are not confined to a tenant: `listTeams` lists the readable teams of every
tenant, and `getTeam` serves a team of another tenant to an actor the authz check allows. `false` is the only value
that boots with `@spinajs/tenancy` until `@spinajs/tenancy-orm/teams` ships in a later release; `true` then puts teams
inside tenants. In this release `true` refuses the boot.

`TeamsTenancyCheck`, an `AuthzContributor`, checks the key when the authz domain boots: it refuses `teams.tenancy` unset
(or empty, `null`) while tenancy is imported, and any value but `true` or `false`. An HTTP app boots that domain when
the server starts listening; a worker or a CLI without HTTP boots it at the first team operation the authz service
checks, so the refusal comes there, not at process start. `teamsOf` and `teammatesOf` read the role stores without
the authz service and never reach the check. Without `@spinajs/tenancy` the key may stay unset.

## Related packages

- [`@spinajs/authz`](../authz/README.md): `AuthzService` and `AuthzAdmin`, which check every call and write every membership.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): the team and group roles and the `DbAssignmentStore` membership needs.
- [`@spinajs/authz-orm`](../authz-orm/README.md): the ancestor table that puts groups and app resources under a team.
- [`@spinajs/authz-abac`](../authz-abac/README.md): the archived-team policies.
- [`@spinajs/email`](../email/README.md): sends invitation mails.
