# `@spinajs/users`

> User identity for SpinaJS: user records, metadata, lifecycle actions, mails, profile and user CLI.

## Documentation

Full documentation is in [docs/users](../../docs/users/README.md):

- [User model and metadata](../../docs/users/01-user-model.md) and a [custom user model](../../docs/users/02-custom-user-model.md)
- [User actions](../../docs/users/03-user-actions.md), [create middleware](../../docs/users/04-create-middleware.md), [lifecycle mails](../../docs/users/05-lifecycle-mails.md), [user events](../../docs/users/06-user-events.md)
- authn integration: [identity and password stores](../../docs/users/07-identity-and-password-stores.md), [authn event sinks](../../docs/users/08-authn-event-sinks.md), [principal factory](../../docs/users/09-principal-factory.md), [principal attribute providers](../../docs/users/10-principal-attribute-providers.md)
- authz integration: [resources and relations](../../docs/users/11-authz-resources-and-relations.md), [default roles](../../docs/users/12-default-roles.md), [impersonation and credential admin guards](../../docs/users/13-impersonation-and-credential-admin-guards.md), [role switch and access response](../../docs/users/14-role-switch-and-access-response.md)
- [User profile](../../docs/users/15-user-profile.md), [jobs run as their initiator](../../docs/users/16-jobs-run-as-initiator.md), [CLI commands](../../docs/users/17-cli-commands.md)

## Credential administration

users registers `users:credentials` (the default `authz.credentials.permission` of its credential admin guard), and its
`admin.users` role holds it through `users:*` by design (§8.2, §22.11, A25): the guard, not a missing right, keeps a user
administrator off accounts it does not cover (SR-10); revoke the permission from that role to narrow it.

## Jobs run as their initiator

Install `@spinajs/authz-queue` (an optional peer dependency) and import `@spinajs/users/queue` (it loads authz-queue) so
a job with `runAs: 'initiator'` reloads its user: one deactivated, banned or deleted since the job was queued runs it as
`UNATTENDED`, and an active one gets its attributes. Importing authz-queue (this subpath does) also grants the `user` role
`job:read` on the jobs it started; installing it without an import adds nothing. Import it before the `Configuration`
resolves, or the grant waits for the next resolve.
