# `@spinajs/orm-history`

Row history of SpinaJS ORM models, recorded as `data` events in an audit trail of `@spinajs/audit`:

- `@History(options?)` and `registerHistory(Model, options?)`: track a model's whole row or a list of its columns, in the trail `history` or one the options name; `@History(false)` opts a model and its subclasses out. The mark can sit on an abstract base class and covers its concrete subclasses.
- `audit.data.rules`: track models by class name, or every model, without a decorator. The package registers the schema of the `audit.data` section.
- `Model.history()` on a marked model, `historyOf(Model)` on any tracked one: `of(id)`, `asOf(id, at)`, `since(seq)`, `byActor(actor)` and `forget(id)`, and for many rows `latestBefore(ids, at)`, `latest(ids)`, `current(ids)` and `currentWhere(where, limit)`.
- `row.history()` and `historyOf(row)`: `entries()`, `asOf(at)` and `forget()` of one row.
- `toHistoryEntry(event)`: the history entry of an audit event read from the trail itself.
- `OrmHistory_2026_11_16_00_00_00`: the migration of the `history` trail's table; subclass it with your own `@Migration` for another connection.
- `HistoryCoverage`: `since(trail, connection, entity)`, from when on a trail holds every change of the columns an entity's registration records, and `record(models?)`; `OrmHistoryCoverage_2026_11_25_00_00_00`, the migration of its table `history_coverage`.
- `HistoryConfigError` (a declaration or a read the package refuses) and `HistoryWriteError` (a write whose history cannot be recorded).
- The types `HistoryOptions`, `TrackedModel`, `TrackedRow`, `ModelHistory`, `RowHistory`, `HistoryEntry`, `HistoryQuery`, `HistoryOp` and `AsOf`.

The package exports these names and nothing else.

Installing the package adds three migrations on the default connection, `orm_history`, `history_coverage` and the `audit_event` of `@spinajs/audit-orm`; with `db.MigrationCheck: 'fail'` (the default) the application does not boot until `npx spinajs migrate-up` has applied them, also with no model tracked. See the [documentation](../../docs/orm-history/README.md).

A marked model declares the members the mark installs:

```ts
export interface Invoice extends TrackedRow {}

@Model('invoice')
@History()
export class Invoice extends ModelBase<Invoice> {
  declare static history: TrackedModel['history'];
}
```
