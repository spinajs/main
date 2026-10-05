# `@spinajs/users`

> User identity for SpinaJS: user records, metadata, lifecycle actions, mails, profile and user CLI.

## Usage

```
import { User } from '@spinajs/users';

// TODO: DEMONSTRATE API
```

## Jobs run as their initiator

Install `@spinajs/authz-queue` (an optional peer dependency) and import `@spinajs/users/queue` (it loads authz-queue) so
a job with `runAs: 'initiator'` reloads its user: one deactivated, banned or deleted since the job was queued runs it as
`UNATTENDED`, and an active one gets its attributes. Installing authz-queue also loads its config fragment, which grants
`job:read` to the `user` role; authz-rbac refuses that grant at boot unless the app imports authz-queue or this subpath.
