# `@spinajs/users`

> User identity for SpinaJS: user records, metadata, lifecycle actions, mails, profile and user CLI.

## Usage

```
import { User } from '@spinajs/users';

// TODO: DEMONSTRATE API
```

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
