# Database audit

`DbDecisionAudit` is a `DecisionAudit` that writes one `authz_audit` row per audit record: denials, `runAs`, `.unscoped()` lists, explains, admin commands and deleted resources. Use it when the audit trail must be queryable from the database instead of the log.

It lives in the entry point `@spinajs/authz-orm/audit`. Importing it does **not** make it the audit: you register and select it.

## How it works

1. Importing `@spinajs/authz-orm/audit` registers the `AuthzAuditEntry` model and the migration `AuthzAudit_2026_10_01_00_00_00`, both on the connection named `authz-audit` (`AUDIT_CONNECTION`).
2. The app registers `DbDecisionAudit` as a `DecisionAudit` and names it in `authz.audit.service`. The authz host then hands it every audit record of the domain.
3. `record(entry)` builds an `AuthzAuditEntry` and inserts it as `SYSTEM`, so app scoping and the runtime guard never touch the audit's own write.
4. Each value is cut to its column width before the insert. `trace` holds the record's trace as JSON; for an `admin` record without a trace it holds the command (secrets already removed by `AuthzAdmin`).
5. A failed write is logged on the `authz-audit` log (`writing a <kind> entry to authz_audit failed, the entry is dropped`) and the record is dropped. `record()` never rejects, so auditing never fails a check.

authz-orm itself records two kinds of entries through the domain's audit:

| `kind` | When | Fields |
| --- | --- | --- |
| `unscoped` | A `.unscoped(reason)` query runs and `authz.audit.unscoped` is on. | `principal`, `reason`, `resource: { type }` |
| `system` | A resource row was deleted ([The ancestor table](06-ancestor-table.md#forgetting-a-deleted-resource)). | `principal: SYSTEM`, `resource`, `reason: 'resource-deleted'` |

Both are fire-and-forget: a failure is logged (`authz-orm: audit record failed`) and the query is not affected.

## Configuration

| Key | Type | Default | Allowed values | Meaning |
| --- | --- | --- | --- | --- |
| `db.Aliases['authz-audit']` | `string` | none | a connection `Name` | The connection of `authz_audit`. Or configure a connection named `authz-audit`. |
| `authz.audit.service` | `string` | none: the last `DecisionAudit` registered | a registered `DecisionAudit` class name | Selects the audit of the root domain. `'DbDecisionAudit'` selects this one. |
| `authz.domains.<name>.audit.service` | `string` | the parent's | a registered `DecisionAudit` class name | The same for one domain. |
| `authz.audit.unscoped` | `boolean` | owned by `@spinajs/authz` | | Whether `.unscoped(reason)` queries write an entry. |

```ts
export default {
  db: { Aliases: { 'authz-audit': 'default' } },
  authz: { audit: { service: 'DbDecisionAudit', denials: true, runAs: true, unscoped: true } },
};
```

<!-- TODO(docs-hook): verify what the ORM does with the AuthzAudit migration when no connection answers to authz-audit (the package README says it is skipped with a warning) -->

## Schema

### `authz_audit`

Migration `AuthzAudit_2026_10_01_00_00_00`, model `AuthzAuditEntry`. Index `authz_audit_at` on `at`.

| Column | Type | Meaning |
| --- | --- | --- |
| `id` | varchar(36), PK | A UUID the model generates. |
| `at` | datetime | The instant the entry is written, in UTC. Read back as a luxon `DateTime` in UTC. |
| `kind` | varchar(16) | `deny`, `runAs`, `unscoped`, `explain`, `system` or `admin`. |
| `principal` | varchar(100) | `type:id` of the principal. |
| `permission` | varchar(160), null | The permission, when the record has one. |
| `resource` | varchar(255), null | `resourceKey(resource)`, when the record has one. |
| `reason` | varchar(255), null | The deny reason or the `runAs` / `unscoped` reason. |
| `trace` | text, null | The trace as JSON; the command for an `admin` record. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| `DbDecisionAudit` | `@Singleton()`; not registered. Register it under `DecisionAudit` in the root container or a domain's container. | | The log audit of `@spinajs/authz` | `DI.register(DbDecisionAudit).as(DecisionAudit)` plus `authz.audit.service: 'DbDecisionAudit'`. Subclass `DecisionAudit` for another sink. |
| `AuthzAuditEntry`, `AUDIT_TABLE`, `AUDIT_CONNECTION` | ORM model and constants from `@spinajs/authz-orm/audit` | | | Query the audit trail. |

## Important behaviour

- **Importing is not selecting.** Without `authz.audit.service`, the host takes the last `DecisionAudit` registered; registering `DbDecisionAudit` without naming it can silently replace the log audit. Name it.
- **A lost row never fails a check.** Write errors are logged and dropped; monitor the `authz-audit` log.
- **Values are cut, not rejected.** A value longer than its column is cut to the column width (by characters), so one long reason does not lose the whole row.
- **A trace that is not JSON is dropped.** The row is written without `trace`, and a warning is logged.
- **The audit has its own connection name.** `authz-audit` is separate from `authz`, so the audit trail can live in another database.

## Best practices

- Map `authz-audit` to a database with its own retention policy; the table grows with every denial.
- Query by `at` (indexed) and filter `kind` and `principal` from there.
- Keep `authz.audit.unscoped: true` so every `.unscoped(reason)` list leaves a row with its reason.

## Patterns and antipatterns

```ts
// Don't: registered but not selected; whichever DecisionAudit registers last wins
DI.register(DbDecisionAudit).as(DecisionAudit);

// Do: register and select it by name
DI.register(DbDecisionAudit).as(DecisionAudit);
// config: authz: { audit: { service: 'DbDecisionAudit' } }
```

## Examples

### Store the audit trail in the database and read the last denials

```ts sample
import { DecisionAudit } from '@spinajs/authz';
import { AuthzAuditEntry, DbDecisionAudit } from '@spinajs/authz-orm/audit';
import { DI } from '@spinajs/di';

// config: db: { Aliases: { 'authz-audit': 'default' } }, authz: { audit: { service: 'DbDecisionAudit' } }
DI.register(DbDecisionAudit).as(DecisionAudit);

// principalKey is `type:id`, such as 'user:42'
export async function recentDenialsOf(principalKey: string) {
  return await AuthzAuditEntry.where('principal', principalKey).where('kind', 'deny').orderByDescending('at').take(50);
}
```

`AuthzAuditEntry` is not an `@AccessResource` model, so the runtime guard does not flag the select. Authorize the route that serves it.

## Related

- [The ancestor table](06-ancestor-table.md#forgetting-a-deleted-resource): the `resource-deleted` entries.
- [Access lists](01-access-lists.md#builder-methods): `.unscoped(reason)` and its entry.
- [`@spinajs/authz` config](../authz/04-host-boot-and-configuration.md#configuration): `authz.audit.*`.
- [`@spinajs/orm` connections](../orm/01-connections.md): `db.Aliases`.
