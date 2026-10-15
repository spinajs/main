# `@spinajs/authz-queue`

Queue integration for SpinaJS authorization.

Importing the package registers `AuthzQueueHook` as a `QueueMessageHook` of `@spinajs/queue`.

- On emit it writes `message.Initiator` (`{ type, id, ceiling? }`) from the principal in the current async context. Nothing is written when there is none (unattended), and an `Initiator` the caller set is removed.
- A handler runs as `UNATTENDED` unless its job says otherwise. Every check it makes is denied.
  - `@Job({ runAs: 'initiator' })`: the handler runs as the principal that emitted the message. A message without a usable `Initiator` runs unattended.
  - `@Job({ runAs: 'system' })`: the handler runs as `SYSTEM`.
- Every handler run is wrapped in `runAs`, with the reason `job:<name>`, so it shows in the audit when `authz.domains.<domain>.audit.runAs` is on.

The hook uses the authz domain named by `authz.queue.domain` (default `root`).

`Initiator` crosses the broker as plain data, so the broker is trusted to carry it unchanged. The default `InitiatorPrincipalFactory` builds the principal from the stamp alone (no attributes, `source: 'queue'`) and warns once about it. `authz.queue.stampedInitiatorWarning: false` silences the warning; a wrapper built with `new` that does reload the user passes `{ warn: false }` instead, which never reads the config. An app that must reload the user registers its own: `DI.register(MyFactory).as(InitiatorPrincipalFactory)`. The stamp does not carry `onBehalfOf` or `authn` facts, so an agent or impersonating principal is rebuilt without them.

## Change bus

`QueueChangeBus` retries a failed listen every 5 s and then drops all caches. It carries `AuthzChange`s to the other nodes as `AuthzChangeEvent` queue events. Importing the package registers it as a `ChangeBus`, so it becomes the default bus of every domain without `authz.bus.service`; set that key to choose explicitly (`'QueueChangeBus'` or `'InProcessChangeBus'`). Subscribers on the publishing node hear a change at once and skip the copy that returns from the broker. A publish the queue refuses rejects. `authz.bus.topic`, when set and `queue.routing` has no route for `AuthzChangeEvent`, becomes that route's channel.

## Job rows

Importing the package registers `JobModel` (`queue_jobs`) as the `job` resource; its `owner` is the initiator (`InitiatorType` and `InitiatorId`), so a principal owns a job only when both its type and its id match. It also contributes, as a configuration source registered at import, the grant that gives the `user` role `job:read` on `owner` in `authz.rbac.roles`. The grant comes with the import, not with the install: a package that is installed but never imported adds nothing, so the boot does not fail on a permission nobody registered. The source loads before the config files, so the application's own `authz.rbac.roles.user` still adds grants and overrides scalar keys. It is read when the `Configuration` resolves its sources, so import the package before that; a later import takes effect on the next `Configuration` resolve, and `load()` alone reuses the sources already collected. The queue's own reads and writes of job rows (tracking, progress, retention) run as `SYSTEM` through `QueueTrackingHook`, with the reason `queue:tracking`. Any other multi-row select on `JobModel` follows the usual rules: it needs `.accessible(permission)`, `.unscoped(reason)` or `runAs(SYSTEM)`, or authz-orm's runtime guard flags it (an `AuthzConfigError` in the `test` env, a warning in development). `queue-http-progress`'s `GET jobs/v1/:jobId/status` checks `job:read` on the row and answers 404 for an unknown job and for one the caller may not read.
