# `@spinajs/audit`

The audit trail of a SpinaJS application: who did what to what, with which outcome, in which request. Every event has one shape, whether it records a data change, a read, an action, a security event or the application's own business event. A producer calls `audit().record()`; the service stamps the actor, trace and client address from the request, masks the payload and hands the event to the store of a named **trail**. A trail decides where events go (the log, a table, a buffer that ships them to another database or service), what happens when they cannot be written, how long they are kept, and whether they are sealed into a hash chain that a verifier can recompute.

Nothing is recorded until code asks for it: `@spinajs/audit` and `@spinajs/audit-orm` add no producer of their own.

## Packages

| Package | Holds |
| --- | --- |
| `@spinajs/audit` | `audit()` and `AuditService`, the event and trail contracts, the ports `AuditStore`, `AuditReader`, `AuditEventSink` and `AuditContext`, `LogAuditStore`, masking, `canonicalJson`, `payloadHash`, `eventDigest`, `sealHash`. No ORM, http or queue import. |
| `@spinajs/audit/testing` | `MemoryAuditStore`, `MemoryAuditReader` and a settable context for the tests of packages that record. |
| `@spinajs/audit-orm` | `TableAuditStore`, `TableAuditReader`, the trail table migration, `Model.audit()` and `row.audit()`, retention (`pruneAudit`), shipping (`OutboxAuditStore`, `shipAudit`, `auditBacklog`, `ArchiveAuditSink`, `ArchiveAuditReader`), sealing (`sealAudit`, `verifyTable`) and the `spinajs audit:verify` command. |
| `@spinajs/audit-orm/scheduler` | `AuditRetentionTask`, `AuditShipTask`, `AuditSealTask` for `@spinajs/scheduler`. |
| `@spinajs/audit-orm/queue` | `QueueAuditSink`, `AuditBatchRecorded` and `consumeAuditBatches()` for `@spinajs/queue`. |
| `@spinajs/audit-orm/testing` | `TestDb`: one ORM over sqlite, PGlite and the Postgres and MySQL servers that answer. |

Importing `@spinajs/audit-orm` registers `TableAuditStore`, `OutboxAuditStore`, the readers and sinks, and the migration `AuditEvent_2026_11_16_00_00_00`, which creates `audit_event` on the `default` connection.

## Pages

| Page | What it covers |
| --- | --- |
| [Trails and guarantees](01-trails-and-guarantees.md) | The event, the trail options, the built-in trails, the three write modes, failures, masking, retention. |
| [Reading the trail](02-reading-the-trail.md) | `audit().trail(name)`, `Model.audit()`, `row.audit()`, `StoredAuditEvent`, `source`. |
| [Shipping](06-shipping.md) | The buffer table, the shipper, archives on another connection, shipping through a queue to an audit service. |
| [Integrity and verification](07-integrity-and-verification.md) | Sealed trails, what a seal covers, the keyless chain and its threat model, `verify()` and `spinajs audit:verify`. |
| [Erasure](08-erasure.md) | `forget()`: what is blanked and kept, the `erasure` event, erasure windows of a shipping trail. |
| [Limits](09-limits.md) | Everything a reader of the trail must not assume. |
| [Custom stores and sinks](10-custom-stores-and-sinks.md) | Writing an `AuditEventSink`, an `AuditStore` and an `AuditReader`. |

New to the package: read [Trails and guarantees](01-trails-and-guarantees.md), then [Limits](09-limits.md).

## Quick start

```ts sample
import { audit } from '@spinajs/audit';
import '@spinajs/audit-orm';

// config/audit.ts: a trail of its own table that refuses the action when it cannot record it.
export default {
  audit: {
    trails: {
      billing: { table: 'audit_billing', onFailure: 'reject', retentionDays: 3650 },
    },
  },
};

export async function markPaid(invoiceId: string): Promise<void> {
  await audit().record({ kind: 'action', action: 'invoice.paid', subject: { type: 'invoice', id: invoiceId }, data: { method: 'card' } }, { trail: 'billing' });
}

export async function paymentsBy(actor: string) {
  return audit().trail('billing').byActor(actor, { actions: ['invoice.paid'], limit: 50 });
}
```

The trail `billing` needs its table: extend `AuditTrailTableMigration` (see [Trails and guarantees](01-trails-and-guarantees.md#tables)). Because the trail rejects, `record` writes in the confirmed mode and throws `AuditWriteFailed` when the event cannot be stored.

## Related

- [`@spinajs/orm`](../orm/README.md): the connections, transactions and migrations the table stores use.
- [`@spinajs/scheduler`](../scheduler/README.md): runs retention, shipping and sealing on the leader.
- [`@spinajs/queue`](../queue/README.md): the transport of a trail shipped to an audit service.
- [`@spinajs/authn`](../authn/README.md): the principal that becomes an event's `actor`.
