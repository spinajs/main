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

## Related packages

- [`@spinajs/authz`](../authz/README.md): `AuthzService` and `AuthzAdmin`, which check every call and write every membership.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): the team and group roles and the `DbAssignmentStore` membership needs.
- [`@spinajs/authz-orm`](../authz-orm/README.md): the ancestor table that puts groups and app resources under a team.
- [`@spinajs/authz-abac`](../authz-abac/README.md): the archived-team policies.
- [`@spinajs/email`](../email/README.md): sends invitation mails.
