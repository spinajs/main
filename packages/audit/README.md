# `@spinajs/audit`

The audit trail of a SpinaJS application: who did what to what, with which outcome, in which request.

- `audit().record(input, options)`: one event shape for data changes, reads, actions, security events and the application's own events.
- Trails (`audit.trails`): named destinations with their own store, failure mode, retries, masking and retention.
- Ports: `AuditStore`, `AuditReader`, `AuditEventSink`, `AuditContext`. `LogAuditStore` ships here; the table store is `@spinajs/audit-orm`.
- `canonicalJson`, `payloadHash`: how the `data_hash` of an event is computed, wherever a copy of it is stored.
- `@spinajs/audit/testing`: an in-memory store and reader and a settable context for tests.

This package depends on neither the ORM nor http.

## Queue jobs

`import '@spinajs/audit/queue'` registers `QueueAuditHook`, a `QueueMessageHook` of `@spinajs/queue` (an optional peer: the main entry never loads it). It records only message classes marked `@Audited`:

```ts
@Job()
@Audited('report.send', { trail: 'actions', fields: ['ReportId'] })
class SendReport extends QueueJob { ... }
```

- A publish is `queue.publish` with outcome `attempt`: the hook runs before the transport is called and does not see the send. A message without an id gets one, and that id is the one it is sent with.
- An execution is recorded under the decorator's action as `ok`, `failed` or `denied` (a `PermanentJobFailure` with reason `access_denied`), with `data.ms` and, on a failure, `data.error`. The `onFailed` pass of a failed delivery is not recorded again.
- Every event has `subject: { type: <message class>, id: <MessageId> }` and `data: { message, type, initiator?, fields? }`; only the properties listed in `fields` are copied from the message.
- On a `reject` trail a confirmed `attempt` is written before the handler, and the job does not run without it: the queue then retries or dead-letters it by its own rules.
- Hooks nest in import order. Imported after `@spinajs/authz-queue`, the events carry the job's principal, and a job refused by `@Job({ access })` never reaches this hook. Imported before it, the refusal is recorded as `denied` and the events are stamped `unattended`, with the initiator in `data.initiator`.
