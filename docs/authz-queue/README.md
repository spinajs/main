# `@spinajs/authz-queue`

Connects [`@spinajs/authz`](../authz/README.md) to [`@spinajs/queue`](../queue/README.md). It records which principal emitted each message, and it decides which principal each handler runs as, from the handler's `@Job({ runAs })`.

It also makes `queue_jobs` rows an authz resource (`job`), so a user can read the jobs they started, and it ships `QueueChangeBus`, a `ChangeBus` that carries authz changes between nodes over the queue.

It does **not** authenticate anyone, and it does **not** sign the `Initiator` it writes on a message: the broker is trusted to carry it unchanged. The default factory does **not** reload the user when a job runs. An event handler (`@Event()`) never runs as its emitter.

## Install

```sh
npm install @spinajs/authz-queue
```

Import the package once, in the entry of every process that emits or consumes messages, before the `Configuration` resolves:

```ts
import '@spinajs/authz-queue';
// only with @spinajs/authz-orm installed: the job resource, the tracking hook and the job:read grant
import '@spinajs/authz-queue/jobs';
```

The root import registers the message hook and the change bus. The `@spinajs/authz-queue/jobs` subpath registers the `job` resource, the tracking hook and the `user` role's `job:read` grant ([Job rows as a resource](03-job-resource.md)); it needs `@spinajs/authz-orm`, an optional peer dependency. Without the subpath nothing registers `job:read` and no role holds it: an app that serves `GET jobs/v1/:jobId/status` of `@spinajs/queue-http-progress` fails boot on the unregistered permission or, when it registers `job:read` itself, answers 403 to every caller. Installing the package without importing it adds nothing.

## Features

| Feature | What it does |
| --- | --- |
| [Job authorization](01-job-authorization.md) | `AuthzQueueHook`: stamps `message.Initiator` on emit, and runs each handler as the initiator, as `SYSTEM` or unattended, from `@Job({ runAs })`. |
| [Initiator principal factory](02-initiator-principal-factory.md) | `InitiatorPrincipalFactory`: rebuilds the principal a `runAs: 'initiator'` job runs as; replace it to reload the user. |
| [Job rows as a resource](03-job-resource.md) | `@spinajs/authz-queue/jobs`: `JobModel` is the `job` resource owned by its initiator, the `user` role gets `job:read` on its own jobs, and the queue's own row queries run as `SYSTEM`. |
| [Queue change bus](04-queue-change-bus.md) | `QueueChangeBus`: sends `AuthzChange`s to the other nodes as `AuthzChangeEvent` messages, so their decision caches drop stale entries. |

## Quick start

A job that exports a project report with the rights of the user who asked for it.

```ts sample
import '@spinajs/authz-queue';
import { NewInstance } from '@spinajs/di';
import { authz } from '@spinajs/authz';
import { Job, QueueJob } from '@spinajs/queue';

@NewInstance()
@Job({ runAs: 'initiator' })
export class ExportProjectReport extends QueueJob {
  public ProjectId: string;

  public async execute() {
    const me = authz().current();
    await authz().assert(me, 'project:export', { type: 'project', id: this.ProjectId });
    return { file: `exports/project-${this.ProjectId}.csv` };
  }
}

// Call it where the user's principal is current, such as an HTTP request: the principal is stamped on the message.
export async function requestExport(projectId: string) {
  return ExportProjectReport.emit({ ProjectId: projectId });
}
```

Without `runAs`, the same job runs as `UNATTENDED` and `assert()` throws `AccessDenied`.

## Related packages

- [`@spinajs/authz`](../authz/README.md): principals, `runAs`, `SYSTEM` and `UNATTENDED`, domains, the change bus contract. This package adapts them to the queue.
- [`@spinajs/queue`](../queue/README.md): the [message hooks](../queue/06-message-hooks.md) and [tracking hooks](../queue/07-tracking-hooks.md) this package plugs into, `@Job()`, and [job tracking](../queue/03-job-tracking.md), which turns `Initiator` into the job row's owner.
- [`@spinajs/authz-orm`](../authz-orm/README.md): `registerAccessResource()`, the `owner` relation and `.accessible()`, used for the `job` resource.
- [`@spinajs/authz-rbac`](../authz-rbac/README.md): reads the `authz.rbac.roles.user` grant this package adds.
- [`@spinajs/queue-http-progress`](../queue-http-progress/README.md): `GET jobs/v1/:jobId/status` checks `job:read` on the job row.
- [`@spinajs/users`](../users/16-jobs-run-as-initiator.md): `@spinajs/users/queue` replaces the initiator factory with one that reloads the user.
- [`@spinajs/http-socket`](../http-socket/11-access-change-push.md): pushes the changes the change bus delivers to connected clients.
