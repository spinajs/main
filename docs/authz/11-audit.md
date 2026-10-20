# Audit

The engine and `AuthzAdmin` record what an operator must be able to trace afterwards: denials, `runAs`, `SYSTEM` checks, `explain` calls, unscoped lists and every admin command. They hand each entry to a `DecisionAudit`; the default writes it to the log.

## How it works

1. The engine calls `DecisionAudit.record(entry)` at the end of a check ([How a check works](01-check-flow.md#how-it-works)), `DefaultAuthzService.runAs()` before it runs `fn`, and `AuthzAdmin` after a committed batch.
2. Each domain uses the class named by `authz.audit.service`, else the last `DecisionAudit` registration.
3. `record` may return a promise. A throw or a rejection is logged and never fails the check or the batch.
4. A decision served from L1 is not audited twice; one served from L2 is audited like a fresh one.

| Kind | Recorded when | Switch |
| --- | --- | --- |
| `deny` | A check denies; `reason` is the deny code. | `authz.audit.denials` |
| `system` | A check runs as `SYSTEM`. | always |
| `explain` | An `explain()` call; carries the `trace`. | always |
| `runAs` | `runAs(principal, reason, fn)`; carries the `reason`. | `authz.audit.runAs` |
| `unscoped` | An adapter runs a list without a filter (`.unscoped(reason)`, `@Unscoped`). | `authz.audit.unscoped`, read by the adapter |
| `admin` | One per committed `AuthzAdmin` command; carries the permission, the resource, the batch `reason` and the command with secrets removed. | always |

Entries carry the requesting principal (before delegation), never the `identity` object.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `authz.audit.denials` | `boolean` | `true` | | Record every denial. |
| `authz.audit.runAs` | `boolean` | `true` | | Record every `runAs`. |
| `authz.audit.unscoped` | `boolean` | `true` | | Record unscoped lists. |
| `authz.audit.service` | `string` | the last registration | a registered `DecisionAudit` class name | The sink. |

Each key may be overridden per domain under `authz.domains.<name>.audit`.

```ts
export default {
  authz: {
    audit: { denials: true, runAs: true, unscoped: true, service: 'DbDecisionAudit' },
  },
};
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `DecisionAudit` | `DecisionAudit`, `@Singleton`, chosen by name or last registration | `LogDecisionAudit`: a `warn` line for `deny`, `info` for the rest, on the `authz-audit` log | `DbDecisionAudit` in [`@spinajs/authz-orm`](../authz-orm/README.md) (table `authz_audit`); `RecordingAudit` in [`@spinajs/authz-testing`](../authz-testing/README.md) | Register a class and name it in `authz.audit.service`. |

### `DecisionAudit`: custom implementation

```ts sample
import { Injectable, Singleton } from '@spinajs/di';
import { DecisionAudit } from '@spinajs/authz';

type AuditEntry = Parameters<DecisionAudit['record']>[0];

/** Sends denials and admin commands to the SIEM; the rest is dropped. */
@Singleton()
@Injectable(DecisionAudit)
export class SiemDecisionAudit extends DecisionAudit {
  async record(e: AuditEntry): Promise<void> {
    if (e.kind !== 'deny' && e.kind !== 'admin') return;
    await fetch('https://siem.example.com/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: e.kind, principal: e.principal, permission: e.permission, resource: e.resource, reason: e.reason }),
    });
  }
}
```

Select it with `authz: { audit: { service: 'SiemDecisionAudit' } }`. One sink serves a domain; to keep the log too, call a `LogDecisionAudit` from your class.

## Important behaviour

- **Auditing never fails a check.** A sink error is logged at `error` and dropped.
- **Log lines are injection-safe.** `LogDecisionAudit` passes values as log fields, so user input cannot forge a field or a line.
- **`summary()` and `covers()` checks are quiet**: they audit nothing, but a denial they cached is audited by the first audited check that reuses it.
- **`inspect()` is never audited** ([Holders](13-holders.md#inspect)).
- **Unattended queries show in the audit.** With `DbDecisionAudit`, `authz:audit-unattended` (`@spinajs/authz-orm`) counts the `authz_audit` rows with the reason `unattended` by resource type, the most frequent first. It reads the table on the `authz-audit` connection that `DbDecisionAudit` writes, and fails when the ORM has no such connection or the table does not exist.

## Related

- [How a check works](01-check-flow.md): where denials are recorded.
- [AuthzAdmin](10-authz-admin.md): admin entries and the separate `AuthzEventSink` events.
- [`@spinajs/authz-orm`](../authz-orm/README.md): `DbDecisionAudit` and the `authz_audit` table.
