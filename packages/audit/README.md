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

- A publish is `queue.publish` with outcome `attempt`: the hook runs before the transport is called and does not see the send. A message without an id gets one, and that id is the one it is sent with. On a `reject` trail the publish is written confirmed, and `emit()` throws when it cannot be recorded: an audit outage blocks those publishes.
- An execution is recorded once per delivery under the decorator's action as `ok`, `failed` or `denied` (a `PermanentJobFailure` with reason `access_denied`), with `data.ms` and, on a failure, `data.error` (the error's class name). The `onFailed` pass of a failed job and the callback of a job consumed with one are not recorded again.
- Events are per attempt: every retry of a job records its own events, and all of them share `subject.id`. `data.jobId` carries the job's id; the attempt number is not recorded.
- Every event has `subject: { type: <message class>, id: <MessageId> }` (a `MessageId` longer than 255 characters is recorded as its sha256 hex, with the id itself in `data.messageId`) and `data: { message, type, jobId?, initiator?, fields? }`. Only the properties listed in `fields` are copied from the message; the `omit`, `mask` and `hash` paths of `@Audited` name them `data.fields.<name>`.
- `data.initiator` is the emitter's claim of who started the message, as the message carries it; nothing verifies it. A trail that lists `data.initiator` in `hash` keeps it correlatable without printing it.
- On a `reject` trail a confirmed `attempt` is written before the handler, and the job does not run without it. The queue counts that as a failed attempt: it retries or dead-letters the job by its own rules, so an audit outage longer than a job's retries dead-letters jobs that never ran.
- The outcome is written after the handler and never fails the job: a write that fails is logged (on the `audit-queue` logger, or by the audit service for a deferred write) and the job keeps its result or its own error. A trail without a registered store fails the delivery before the handler runs, and the job's `onFailed` still runs.
- Hooks nest in import order. Imported after `@spinajs/authz-queue`, the events carry the job's principal, and a job refused by `@Job({ access })` never reaches this hook. Imported before it, the refusal is recorded as `denied` and the events are stamped `unattended`, with the initiator in `data.initiator`.
