# `@spinajs/users`

> User identity for SpinaJS: user records, metadata, lifecycle actions, mails, profile and user CLI.

## Usage

```
import { User } from '@spinajs/users';

// TODO: DEMONSTRATE API
```

## Jobs run as their initiator

Import `@spinajs/users/queue` (it loads `@spinajs/authz-queue`) so a job with `runAs: 'initiator'` reloads its user: one
deactivated, banned or deleted since the job was queued runs it as `UNATTENDED`, and an active one gets its attributes.
