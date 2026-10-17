# `@spinajs/queue-http-progress`

An HTTP route that reports the status and progress of a queue job: `GET jobs/v1/:jobId/status`. A client emits a job, keeps the `JobId` that `QueueJob.emit()` returns, and polls this route until the job finishes.

It does **not** track jobs itself: `@spinajs/queue` writes the `queue_jobs` row when a consumer picks the job up, and this route only reads it. It does **not** stream progress (no WebSocket, no server-sent events), and it does **not** track HTTP upload or download progress.

## Install

```sh
npm install @spinajs/queue-http-progress
```

The package needs:

- `@spinajs/http`, with an authentication middleware that sets `req.storage.Principal`;
- `@spinajs/queue` with job tracking, so `JobModel` rows exist in `queue_jobs`;
- `@spinajs/authz-queue` imported by the app: it registers `JobModel` as the `job` resource and grants the `user` role `job:read` on the jobs it emitted.

Installing the package mounts the route: its config adds its `controllers` directory to `system.dirs.controllers`.

## Features

| Feature | What it does |
| --- | --- |
| [Job status route](01-job-status-route.md) | `JobsController.getStatus()`: loads the job row, checks `job:read` on it, answers `IJobStatusResponse` or 404. |
| [Customising the status route](02-customising-the-status-route.md) | Extension points: replace `JobsController` in DI, override `canRead()` and `authzOf()`, move the route to another authz domain or path, unmount it. |

## Quick start

Emit a job from a route and hand the client the status URL.

```ts sample
import { BaseController, BasePath, Ok, Post } from '@spinajs/http';
import { Job, JobProgressCallback, QueueJob } from '@spinajs/queue';

@Job({ runAs: 'initiator' })
export class InvoiceExportJob extends QueueJob {
  public Month!: string;

  public async execute(progress: JobProgressCallback) {
    await progress(10, { phase: 'loading', message: `Invoices of ${this.Month}` });
    // ... build the CSV ...
    await progress(100, { phase: 'done' });
    return { file: `exports/invoices-${this.Month}.csv` };
  }
}

@BasePath('invoices')
export class InvoiceExportController extends BaseController {
  @Post('export')
  public async export() {
    // Emitted inside an authenticated request, so @spinajs/authz-queue stamps the caller as the job's owner.
    const jobId = await InvoiceExportJob.emit({ Month: '2026-09' });
    return new Ok({ jobId, statusUrl: `/jobs/v1/${jobId}/status` });
  }
}
```

The client then calls `GET /jobs/v1/<jobId>/status` until `status` is `success`, `dead` or `error`; see [Poll a job from a browser client](01-job-status-route.md#poll-a-job-from-a-browser-client).

## Related packages

- [`@spinajs/queue`](../queue/README.md): emits jobs, runs them, and writes the `JobModel` row this route reads.
- [`@spinajs/http`](../http/README.md): controllers, [controller discovery](../http/03-controller-discovery.md) and [controller overrides](../http/02-controllers-and-routing.md#overriding-a-package-controller).
- [`@spinajs/authz-http`](../../packages/authz-http/README.md): the `@Access` decorator that guards the route.
- [`@spinajs/authz-queue`](../../packages/authz-queue/README.md): the `job` resource, its `owner` relation, and the `job:read` grant for the `user` role.
