# Tracking models

A model is tracked by its own `@History()`, by `registerHistory()`, or by an `audit.data.rules` entry. Every insert, update and delete of a tracked model that goes through the ORM is then recorded in its trail, inside the write's transaction. An untracked model's statements run as they did before: the package's write observer is not interested in them.

## `@History` and `registerHistory`

```ts sample
import { Hidden, Model, ModelBase, Primary } from '@spinajs/orm';
import { History, registerHistory } from '@spinajs/orm-history';
import type { TrackedModel, TrackedRow } from '@spinajs/orm-history';

export interface Subscription extends TrackedRow {}

@Model('subscription')
@History({ columns: ['plan', 'status'], trail: 'billing' })
export class Subscription extends ModelBase<Subscription> {
  declare static history: TrackedModel['history'];

  @Primary()
  public id: string;

  public plan: string;
  public status: string;
  public note: string;
}

@Model('session')
@History(false)
export class Session extends ModelBase<Session> {
  @Primary()
  public id: string;
}

@Model('member')
export class Member extends ModelBase<Member> {
  @Primary()
  public id: number;

  @Hidden()
  public password: string;

  public last_seen_at: Date;
}

// A model of another package cannot carry the declarations; track it from the application instead.
registerHistory(Member, { exclude: ['last_seen_at'] });
```

| Option | Default | Meaning |
| --- | --- | --- |
| `columns` | every column | Record only these columns, with the key. An update that writes none of them, nor the key, is not recorded. At least one column. |
| `exclude` | none | Columns left out of every recorded row and of `changed`; an update that changes only these records nothing. Cannot be combined with `columns`. |
| `entity` | the table name | The subject type of the events, 1 to 128 characters. Subclasses that share a table share it. |
| `trail` | `history` | The audit trail the events go to. |
| `hidden` | `mask` | `mask`: a `@Hidden()` column is named in `changed`, its value is never stored. `record`: its value is stored like any other. A `@Hidden()` column listed in `columns` is recorded. |

- `@History()` without options records the whole row in the trail `history`.
- The model's `@SoftDelete()` column is always recorded: it is added to `columns`, and `exclude` drops it from its list. Setting it is recorded as `soft_delete`, clearing it as `restore`.
- A subclass is tracked as its nearest marked base class is, under the same entity. `@History(false)` or `registerHistory(Model, false)` opts a model and its subclasses out, also under a rule that matches every model.
- `registerHistory(Model, options)` does what the decorator does, for a class that cannot be decorated. Called again, it replaces the earlier options; `registerHistory(Model, false)` takes the mark back and removes `history()` from the model.
- A combination the options refuse (`columns` with `exclude`, an empty `columns`, an `entity` that is too long, an empty `trail`) throws `HistoryConfigError` when the class is decorated. A model without a single-column primary key is refused with `HistoryConfigError` at its first tracked write.

`@History()` needs the two declarations `history()` is typed by: the interface merged with the class for its rows, and the `declare static` line for the class ([Reading history](02-reading-history.md)). `@History(false)` needs neither.

## `audit.data.rules`

A rule tracks models by class name without a decorator, for example every model of an application:

```ts
// config/audit.ts
export default {
  audit: {
    data: {
      rules: [
        { models: ['Customer', 'Order'], trail: 'billing' },
        { models: '*' },
      ],
    },
  },
};
```

- `models` is `'*'` or a list of class names; a name of a base class covers its subclasses. `trail` is optional and defaults to `history`.
- The first rule that matches wins. A matched model is tracked as `@History({ trail })` would track it: the whole row, `@Hidden()` columns masked.
- A model's own `@History(...)` or `registerHistory()` wins over every rule; `@History(false)` opts it out.
- A matched model without a single-column primary key is left untracked, with a warning on the logger `orm-history`. With its own `@History()` the same model fails its writes instead.
- The rules are read on each use; setting `audit.data.rules` at run time takes effect at the next write.
- The package registers the schema of the section `audit.data`. A malformed rule list, or a misspelt key in the section or in a rule, fails the boot with `InvalidConfiguration`, and a later `Configuration.set` of one is refused. The section's keys are `rules` and `onUnknownKeys`; a rule's keys are `models` and `trail`.

## Choosing a trail

A model writes to one trail: its `@History({ trail })`, else the trail of the rule that matched it, else `history`. The trail decides everything about storage: its table, retention, masking (`data.after.<column>` and `data.before.<column>` are paths of `omit`, `mask` and `hash`), sealing and shipping ([Trails and guarantees](../audit/01-trails-and-guarantees.md)).

The trail's store must join the write's transaction: `TableAuditStore` (the default) and `OutboxAuditStore` do. A tracked write to a trail of `LogAuditStore` is refused with `AuditConfigError` and rolled back. A trail name that is not configured fails the tracked write with the `AuditConfigError` of the audit service, inside the write's transaction, so the statement is rolled back.

## Who migrates the trail table

A trail's table must exist on every connection that holds a model tracked in it: events are written in the write's transaction, on the model's connection, and nowhere else.

- **Trail `history` on the default connection: nothing to do.** The package declares `OrmHistory_2026_11_16_00_00_00` (`@Migration('default')`), which creates `orm_history`. Importing the package also imports `@spinajs/audit-orm`, which declares `AuditEvent_2026_11_16_00_00_00` for its table `audit_event` on the same connection. Both are created by the next `migrate-up`, also when no model is tracked.
- **Trail `history` on another connection:** a subclass of the package's migration, decorated for that connection.
- **Another trail:** a subclass of `AuditTrailTableMigration` whose `table()` returns the trail's table, on each connection that holds a model tracked in it.

```ts sample
import { AuditTrailTableMigration } from '@spinajs/audit-orm';
import { Migration } from '@spinajs/orm';
import { OrmHistory_2026_11_16_00_00_00 } from '@spinajs/orm-history';

@Migration('reports')
export class ReportsHistory_2026_11_21_00_00_00 extends OrmHistory_2026_11_16_00_00_00 {}

@Migration('default')
export class BillingTrail_2026_11_21_00_00_01 extends AuditTrailTableMigration {
  protected override table(): string {
    return 'audit_billing';
  }
}
```

A tracked write on a connection without the table fails with `AuditWriteFailed` (`... is the table migrated there (AuditTrailTableMigration)?`) and is rolled back.

## Failures

A tracked write fails when its record cannot be written, whatever the trail's `onFailure` says: the record is part of the write's transaction, which a failed statement leaves unusable on Postgres. The write throws `AuditWriteFailed` (or the `AuditConfigError` of the trail) and neither the row nor its event is stored. Inside a transaction of your own, roll back on that error as on any other.

## The event

Each changed row is one `AuditInput`: `kind: 'data'`, `action` the operation, `subject: { type: <entity>, id: <primary key as text> }`, `at` the instant history recorded the statement, right after it ran (one per statement), and the payload in `data`. The operations are `insert`, `update`, `delete`, `soft_delete`, `restore` and `lost`.

```json
{ "after": { "id": "i1", "status": "draft", "deleted_at": null } }
```

```json
{ "before": { "status": "draft" }, "after": { "id": "i1", "status": "paid", "deleted_at": null }, "changed": ["secret", "status"] }
```

```json
{ "before": { "id": "n1", "body": "x" } }
```

- An insert holds `after`, a delete `before`, an update (and a soft delete or restore) all three. An update that changes nothing writes nothing.
- `changed` lists every changed column, masked ones included (`secret` above, a `@Hidden()` column). `before` holds the previous values of the changed columns that are not masked.
- `after` holds the whole row in full mode, and the key with every tracked column in column mode, so each entry is self-contained.
- Values are what the driver returned, before the model's converters, as JSON: a `Date` becomes its ISO string (an invalid one `null`), a `bigint` its decimal text, bytes `{ "$bytes": "<base64>" }`. Column names are the table's.
- The payload is stored as canonical JSON, so its keys come back sorted, whatever the order of the table's columns.
- The primary key is the subject id: a string as it is, a number or bigint in decimal.

## Inserts whose keys are not reported

A multi-row insert records one event per row when the driver reports the keys it wrote (`RETURNING` on sqlite, PGlite and Postgres; the first id of a batch on MySQL). An insert whose keys are unknown (a multi-row insert on MSSQL without supplied keys, an insert split into several statements, an insert builder made without `ModelBase.insert`) is handled by `audit.data.onUnknownKeys`:

| Value | What happens |
| --- | --- |
| `warn` (default) | The rows are written. One event `action: 'lost'`, `subject: { type: <entity>, id: '*' }`, `data: { reason: 'unknown_keys' }` is recorded per such insert, and the logger `orm-history` warns once per model. |
| `throw` | The insert fails with `HistoryWriteError` and is rolled back. |

After a `lost` event, `asOf` answers `unknown` for the rows of that entity until a later entry of the row decides again ([As-of and erasure](03-as-of-and-erasure.md)). Supply the keys, or insert one row at a time, to keep a complete history.
