# `@spinajs/authz-queue`

Queue integration for SpinaJS authorization.

Importing the package registers `AuthzQueueHook` as a `QueueMessageHook` of `@spinajs/queue`.

- On emit it writes `message.Initiator` (`{ type, id, ceiling? }`) from the principal in the current async context. Nothing is written when there is none (unattended), and an `Initiator` the caller set is removed.
- A handler runs as `UNATTENDED` unless its job says otherwise. Every check it makes is denied.
  - `@Job({ runAs: 'initiator' })`: the handler runs as the principal that emitted the message. A message without a usable `Initiator` runs unattended.
  - `@Job({ runAs: 'system' })`: the handler runs as `SYSTEM`.
- Every handler run is wrapped in `runAs`, with the reason `job:<name>`, so it shows in the audit when `authz.domains.<domain>.audit.runAs` is on.

The hook uses the authz domain named by `authz.queue.domain` (default `root`).

`Initiator` crosses the broker as plain data, so the broker is trusted to carry it unchanged. The default `InitiatorPrincipalFactory` builds the principal from the stamp alone (no attributes, `source: 'queue'`). An app that must reload the user registers its own: `DI.register(MyFactory).as(InitiatorPrincipalFactory)`. The stamp does not carry `onBehalfOf` or `authn` facts, so an agent or impersonating principal is rebuilt without them.
