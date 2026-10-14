# Authz follow-ups

Items deliberately left out of a design, with the reason. Pick one up by writing a design note first.

## Teams (from `2026-10-14-teams-design.md`)

- **Team-owned machine principals.** A team service principal (`{ type: 'team', id }`) that speaks for
  `team:<id>#team.service`, and API / agent tokens owned by a team instead of a user, so a job's agent can act
  `onBehalfOf` the team and never with a person's rights. Needs an owner change in `authn-token`
  (`rbac_access_tokens.user_id` is a foreign key to `users`) and a principal factory for team principals.
- **External directory sync.** Map an external group (any provider) to a team or group and role; sync at login through
  `ExternalLoginHook` and on a schedule; synced assignments marked with `authz_assignment.source = 'sync:<provider>'`
  and removed when the external membership ends.
- **Per-team quotas** (concurrent jobs, sessions, accounts, storage).

## Resource access (from `2026-10-14-authz-resource-access-design.md`)

- **Client fs ids** from a UI file manager (URI-encoded paths in ids); waits for a client that needs it.
- **RBAC change pushes with exact objects** (an ancestor index port for authz-rbac); today an RBAC change makes clients
  refetch everything.
