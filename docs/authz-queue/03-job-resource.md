# Job rows as a resource

`import '@spinajs/authz-queue/jobs'` makes every `queue_jobs` row (`JobModel`) an authz resource of type `job`, owned by the principal that emitted the job. The `user` role gets `job:read` on the jobs it owns, so a user can read the status of their own jobs and no one else's. The queue's own reads and writes of the table run as `SYSTEM`.

The subpath needs `@spinajs/authz-orm`, an optional peer dependency. The package root (`import '@spinajs/authz-queue'`) registers none of this page.

## How it works

At the subpath import:

1. `registerAccessResource(JobModel, 'job', { owner: { column: 'InitiatorId', typeColumn: 'InitiatorType' } })` declares the model to `@spinajs/authz-orm`. The `owner` relation compares both columns, because an initiator may be any principal type. authz-orm's resource adapter then registers `job:read`, `job:create`, `job:update` and `job:delete` when the domain boots.
2. `JobGrantSource`, a `ConfigurationSource` with `Order` `0`, adds this grant when the `Configuration` loads its sources:
   `authz.rbac.roles.user.grants: [{ permission: 'job:read', relation: 'owner' }]`.
3. `AuthzQueueTrackingHook` registers as a `QueueTrackingHook`.

When a job is consumed:

1. The consumer writes `InitiatorType` and `InitiatorId` from `message.Initiator` when it inserts the row ([Job tracking](../queue/03-job-tracking.md#how-it-works)). A job emitted with no principal has both null and no owner.
2. Every row query of the consumer and of the retention purge goes through `tracked()`, which calls `AuthzQueueTrackingHook.aroundTracking(next)` ([Tracking hooks](../queue/07-tracking-hooks.md)).
3. `aroundTracking` runs `next` inside `runAs(SYSTEM, 'queue:tracking', ...)` of the `authz.queue.domain` domain. The row queries pass authz-orm's guard whatever principal the job runs as.

When a principal reads a job:

1. A check `can(principal, 'job:read', { type: 'job', id: String(row.Id) }, row)` reaches the RBAC model.
2. The `user` role's grant permits it when the `owner` relation holds: the row's `InitiatorType` equals the principal's type and `InitiatorId` its id.
3. `GET jobs/v1/:jobId/status` of `@spinajs/queue-http-progress` runs this check and answers 404 for a job the caller may not read ([Job status route](../queue-http-progress/01-job-status-route.md)).

## Configuration

This package adds no keys of its own here. It contributes a value to a key of `@spinajs/authz-rbac`:

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.rbac.roles.user.grants` | array of grants | `[{ permission: 'job:read', relation: 'owner' }]`, added by `JobGrantSource` | see [`@spinajs/authz-rbac`](../authz-rbac/README.md) | Arrays from different sources are concatenated, so the application's own grants for `user` are added after this one. |

```ts
export default {
  authz: {
    // needed only for lists: .accessible('job:read') on JobModel
    permissions: { 'job:read': { list: true } },
    rbac: {
      roles: {
        // concatenated after the job:read grant authz-queue contributes
        user: { grants: [{ permission: 'report:read' }] },
      },
    },
  },
};
```

`job:read` itself needs no `authz.permissions` entry: authz-orm's resource adapter registers it for the `job` type (step 1 of [How it works](#how-it-works)). Declare it only to add options such as `list`.

## Schema

`JobModel` and its migration belong to `@spinajs/queue` ([Job tracking schema](../queue/03-job-tracking.md#schema)). This package reads two of its columns.

### `queue_jobs`

| Column | Type | Meaning |
| --- | --- | --- |
| `InitiatorType` | string, nullable | Principal type of `message.Initiator`; the `typeColumn` of the `owner` relation. |
| `InitiatorId` | string, nullable | Principal id of `message.Initiator`; the `column` of the `owner` relation. |
| `Id` | integer, primary key | The resource id of the job: `{ type: 'job', id: String(Id) }`. It is not the `JobId` UUID. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Tracking hook | `QueueTrackingHook`, one entry of the list `tracked()` resolves with `Array.ofType(QueueTrackingHook)` on every call; singleton; registered by `@Injectable(QueueTrackingHook)` at the subpath import | `AuthzQueueTrackingHook` | none | Subclass it and override `aroundTracking(next)`, then `DI.unregister(AuthzQueueTrackingHook)` and `DI.register(MySubclass).as(QueueTrackingHook)`. The replacement must still run `next` under a principal that may touch `queue_jobs`. |
| Job grant | `ConfigurationSource`, registered by `@Injectable(ConfigurationSource)` at the subpath import; not exported | `JobGrantSource` | none | Not replaceable. Add grants under `authz.rbac.roles.<role>.grants` in your config instead. |

## Important behaviour

- **The grant comes with the subpath import, not the install and not the package root.** Every installed package's config folder is read whether it is imported or not, and a grant of a permission nothing registered fails boot, so the grant is a configuration source that only an import registers. It needs `job:read` and the `job` type's `owner` relation, which only the subpath's `job` resource provides, so the root does not load it.
- **Importing only the root leaves `job:read` ungranted.** `GET jobs/v1/:jobId/status` of `@spinajs/queue-http-progress` then fails boot on the unregistered permission or, when the app registers `job:read` itself, answers 403 to every caller. Granting `{ permission: 'job:read', relation: 'owner' }` in the app's own config does not help without the subpath: no `RelationResolver` serves `owner` on `job`, so the boot fails.
- **Import before the `Configuration` resolves.** The source is read when the `Configuration` collects its sources. A later import takes effect on the next resolve; `load()` alone reuses the sources it already has.
- **The application can override the grant's scalars.** The source loads before the config files (`Order` `0`), so the application's `authz.rbac.roles.user` keys win, and its grants are added.
- **Owner means type and id.** A `service` principal with id `alice` does not own a job that the `user` `alice` emitted.
- **A job emitted with no principal has no owner.** Only a principal with an unconditional `job:read` can read it.
- **Every other multi-row select on `JobModel` is guarded.** It needs `.accessible(permission)`, `.unscoped(reason)` or `runAs(SYSTEM, reason, fn)`; otherwise authz-orm's runtime guard throws `AuthzConfigError` in the `test` env and warns in development ([Access lists](../authz-orm/01-access-lists.md#important-behaviour)).
- **`queue_jobs` must live on the authz connection.** `JobModel` uses the connection `queue`; every `@AccessResource` model must use the connection that `db.Aliases.authz` names, or the domain boot throws `AuthzConfigError`.

## Best practices

- Load a job by `JobId` inside `runAs(SYSTEM, reason, fn)`, then check `job:read` on the loaded row, as `queue-http-progress` does. `JobId` is not the primary key, so a plain load is a guarded multi-row select.
- Answer 404, not 403, for a job the caller may not read, so a `JobId` cannot be probed.
- Grant an operator role an unconditional `job:read` (no `relation`) to let support staff read every job.

## Examples

### Show a user the progress of their own job

```ts sample
import '@spinajs/authz-queue/jobs';
import { SYSTEM, authz } from '@spinajs/authz';
import { JobModel } from '@spinajs/queue';

export async function progressOf(jobId: string): Promise<number | undefined> {
  const me = authz().current();
  const row = await authz().runAs(SYSTEM, 'job-progress:load', () => JobModel.where({ JobId: jobId }).first());
  if (!row) return undefined;

  const mine = await authz().can(me, 'job:read', { type: 'job', id: String(row.Id) }, row);
  return mine ? row.Progress : undefined;
}
```

### List the jobs the current user started that are still running

Declare `job:read` with `list: true` (see [Configuration](#configuration)).

```ts sample
import '@spinajs/authz-orm';
import '@spinajs/authz-queue/jobs';
import { JobModel } from '@spinajs/queue';

export async function myRunningJobs() {
  return await JobModel.where('Status', 'executing').accessible('job:read');
}
```

## Related

- [Job tracking](../queue/03-job-tracking.md): how the consumer writes `queue_jobs` and checks the row's initiator.
- [Tracking hooks](../queue/07-tracking-hooks.md): the hook chain `AuthzQueueTrackingHook` is part of.
- [Access lists](../authz-orm/01-access-lists.md): `.accessible()` and the `owner` relation in lists.
- [Job status route](../queue-http-progress/01-job-status-route.md): the HTTP route that checks `job:read`.
- [Job authorization](01-job-authorization.md): where `message.Initiator` comes from.
