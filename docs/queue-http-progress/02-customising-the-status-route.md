# Customising the status route

`JobsController` is a plain `@spinajs/http` controller with two protected hooks, `canRead()` and `authzOf()`. Subclass it to change who may read a job, which authz domain decides, where the route lives, or what it returns. Register the subclass as an override so only it mounts.

## How it works

1. You declare `class MyJobs extends JobsController` and call `DI.register(MyJobs).as(JobsController)` before `Controllers` resolves (before `HttpServer` starts).
2. `FilesystemControllerSource` still lists `JobsController` from the package directory. `Controllers.resolve()` registers it as `BaseController`.
3. Resolving `Array.ofType(BaseController)` follows the `JobsController` registration to `MyJobs`, so DI creates one `MyJobs` singleton and no `JobsController`.
4. `Controllers` logs `Controller JobsController overridden by MyJobs` at info and mounts `MyJobs`.
5. `MyJobs` owns a copy of the parent's route descriptor and access descriptor: it inherits `@BasePath('jobs/v1')`, `@Get(':jobId/status')` and `@Access('job:read')`. A route it redeclares changes only the subclass.

Without the `DI.register(...).as(JobsController)` call both classes mount, `Controllers` logs a warning, and Express route order decides which one answers.

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `JobsController` | Class `JobsController`, listed by `FilesystemControllerSource`, registered as `BaseController` by `Controllers.resolve()`; singleton | `JobsController` | none shipped | `DI.register(Mine).as(JobsController)` before `Controllers` resolves. |
| `canRead(req, row)` hook | Protected method, called once per request after the row loads | `authzOf(req).can(principal, 'job:read', { type: 'job', id: String(row.Id) }, row)`; `false` without a principal | none shipped | Override in the subclass; return `false` to answer 404. Call `super.canRead()` to keep the `job:read` check. |
| `authzOf(req)` hook | Protected method, called by `getStatus()` and by `canRead()` | The domain of the route's `@Access` (`req.storage.AuthzHttpRoute.domain`): root `AuthzService`, else `AuthzDomains.service(domain)` | none shipped | Override to pick another `AuthzService`. It serves both the `SYSTEM` load and the row check. |
| `getStatus(jobId, req)` route | Public method with `@Get(':jobId/status')` and `@Access('job:read')` | see [Job status route](01-job-status-route.md) | none shipped | Redeclare it with `@Get` and `@Access` to change the domain, the permission or the response. |
| Route mounting | `Controllers`, singleton, from `@spinajs/http` | mounts every listed controller | your `Controllers` subclass | Override `listControllers()` and drop `JobsController` to unmount the route. |

### `canRead()`: hide old jobs

Override `canRead()` when the `job:read` decision needs a rule the authz model does not hold. This one keeps the owner check and hides jobs older than 30 days, so old results stop leaking through long-lived links.

```ts sample
import { DI } from '@spinajs/di';
import type { Request } from '@spinajs/http';
import { JobModel } from '@spinajs/queue';
import { JobsController } from '@spinajs/queue-http-progress';

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export class RecentJobsController extends JobsController {
  protected async canRead(req: Request, row: JobModel): Promise<boolean> {
    if (Date.now() - row.CreatedAt.toMillis() > MAX_AGE_MS) {
      return false; // answers 404, like an unknown job
    }
    return super.canRead(req, row);
  }
}

// At application start, before DI.resolve(Controllers) / HttpServer.start().
DI.register(RecentJobsController).as(JobsController);
```

Routes, base path and `@Access` are inherited; only the row decision changes.

### `getStatus()`: check in another authz domain

`authzOf()` follows the domain of the route's `@Access`. Redeclare the route with `@Access('job:read', { domain })` and both the policy and the row check run in that domain. Use it when jobs are a resource of a tenant domain, not of `root`.

```ts sample
import { DI } from '@spinajs/di';
import { Access } from '@spinajs/authz-http';
import { Get, Ok, Param, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { JobsController } from '@spinajs/queue-http-progress';

export class TenantJobsController extends JobsController {
  @Get(':jobId/status')
  @Access('job:read', { domain: 'tenants' })
  public getStatus(@Param() jobId: string, @Req() req: Request): Promise<Ok> {
    return super.getStatus(jobId, req);
  }
}

DI.register(TenantJobsController).as(JobsController);
```

The `tenants` domain must exist in `authz.domains`, and `JobModel` must be the `job` resource there (`authz.queue.domain` and `authz.orm.domain` of `@spinajs/authz-queue` and `@spinajs/authz-orm`).

### `authzOf()`: gate in one domain, decide in another

Override `authzOf()` when the route's type-level gate and the row decision belong to different domains. Here `@Access` stays in `root` (any user with `job:read` passes the gate), and the owner check runs in the `jobs` domain.

```ts sample
import { DI } from '@spinajs/di';
import { AuthzDomains, AuthzService } from '@spinajs/authz';
import type { Request } from '@spinajs/http';
import { JobsController } from '@spinajs/queue-http-progress';

export class JobsDomainController extends JobsController {
  protected async authzOf(_req: Request): Promise<AuthzService> {
    const domains = (await DI.resolve(AuthzDomains)) as AuthzDomains;
    return domains.service('jobs');
  }
}

DI.register(JobsDomainController).as(JobsController);
```

The `SYSTEM` load in `getStatus()` also runs through this service. The `jobs` domain must exist in `authz.domains` and hold `JobModel` as its `job` resource.

### `getStatus()`: return a smaller response

`Ok` keeps its data protected, so a subclass cannot edit what `super.getStatus()` returns. Redeclare the route and build the response with the hooks. This status route for a public progress widget returns no `result` and no `error`.

```ts sample
import { DI } from '@spinajs/di';
import { SYSTEM } from '@spinajs/authz';
import { Access } from '@spinajs/authz-http';
import { ResourceNotFound } from '@spinajs/exceptions';
import { Get, Ok, Param, Req } from '@spinajs/http';
import type { Request } from '@spinajs/http';
import { JobModel } from '@spinajs/queue';
import { JobsController } from '@spinajs/queue-http-progress';

export class ProgressOnlyJobsController extends JobsController {
  @Get(':jobId/status')
  @Access('job:read')
  public async getStatus(@Param() jobId: string, @Req() req: Request): Promise<Ok> {
    const authz = await this.authzOf(req);
    // Keep the lookup unscoped, as the default does; canRead() decides afterwards.
    const row = await authz.runAs(SYSTEM, 'job-status:load', () => JobModel.select().where('JobId', jobId).first());

    if (!row || !(await this.canRead(req, row))) {
      throw new ResourceNotFound(`Job ${jobId} not found`);
    }

    return new Ok({ jobId: row.JobId, status: row.Status, progress: row.Progress, phase: row.Phase ?? undefined });
  }
}

DI.register(ProgressOnlyJobsController).as(JobsController);
```

### `@BasePath`: move the route

Put `@BasePath` on the subclass to serve the route under another path. To prefix every route of the app, set `http.controllers.route.prefix` instead.

```ts sample
import { DI } from '@spinajs/di';
import { BasePath } from '@spinajs/http';
import { JobsController } from '@spinajs/queue-http-progress';

// GET /background-tasks/:jobId/status
@BasePath('background-tasks')
export class BackgroundTasksController extends JobsController {}

DI.register(BackgroundTasksController).as(JobsController);
```

### Unmount the route

Config arrays concatenate, so an app cannot drop the package's directory from `system.dirs.controllers`. Filter `JobsController` out of the list `Controllers` mounts instead.

```ts sample
import { ClassInfo, DI } from '@spinajs/di';
import { BaseController, Controllers } from '@spinajs/http';
import { JobsController } from '@spinajs/queue-http-progress';

export class AppControllers extends Controllers {
  protected async listControllers(): Promise<Array<ClassInfo<BaseController>>> {
    const all = await super.listControllers();
    return all.filter((c) => c.type !== JobsController);
  }
}

DI.register(AppControllers).as(Controllers);
```

## Important behaviour

- Register the override before `Controllers` resolves. A registration after the server started has no effect on the mounted routes.
- Register one subclass of `JobsController`. Combine several changes (hook, path, domain) in that one class.
- The subclass needs its own class name: `Controllers` keeps one controller per name.
- A subclass that redeclares `getStatus` without `@Access` keeps the inherited `@Access('job:read')`; with `@Access` it replaces the inherited one for that route.
- `canRead()` returning `false` answers 404, never 403, so a custom rule keeps the "unknown and denied answer alike" guarantee.
- `canRead()` gets the row loaded as `SYSTEM`; every column is there, including `InitiatorType`, `InitiatorId` and `Result`.

## Best practices

- Call `super.canRead()` in an override unless you deliberately drop the `job:read` row check.
- Change the domain by redeclaring `@Access(..., { domain })`, not by overriding `authzOf()`; then the policy and the row check agree.
- Keep the `runAs(SYSTEM, ...)` load when you redeclare `getStatus`; the authz scope of the ORM would otherwise filter the lookup before `canRead()` decides.
- Throw `ResourceNotFound` for denied rows in a redeclared `getStatus`, as the default does.

## Patterns and antipatterns

```ts
// Don't: subclass without registering; both controllers mount on jobs/v1 and route order decides.
@BasePath('jobs/v1')
export class MyJobsController extends JobsController {}

// Do: register the subclass as the override.
export class MyJobsController extends JobsController {}
DI.register(MyJobsController).as(JobsController);
```

```ts
// Don't: deny with 403; it tells the caller the job exists.
protected async canRead(req: Request, row: JobModel) {
  if (row.Name === 'PayrollExportJob') throw new Forbidden('payroll');
  return super.canRead(req, row);
}

// Do: return false, which answers 404 like an unknown job.
protected async canRead(req: Request, row: JobModel) {
  return row.Name !== 'PayrollExportJob' && super.canRead(req, row);
}
```

## Related

- [Job status route](01-job-status-route.md): the default flow and response.
- [Controllers and routing](../http/02-controllers-and-routing.md#overriding-a-package-controller): how `DI.register(Mine).as(Theirs)` replaces a package controller.
- [Controller discovery](../http/03-controller-discovery.md): `ControllerSource` and `Controllers.listControllers()`.
- [`@spinajs/authz-http`](../../packages/authz-http/README.md): `@Access` options (`domain`, `resource`, `subject`, `also`, `fields`).
- [`@spinajs/authz-queue`](../../packages/authz-queue/README.md): where the `job` resource and its domain come from.
