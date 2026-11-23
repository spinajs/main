# `@spinajs/orm-history`

Row history of SpinaJS ORM models, recorded as `data` events in an audit trail of `@spinajs/audit`:

- `@History(options?)` and `registerHistory(Model, options?)`: track a model's whole row or a list of its columns, in the trail `history` or one the options name; `@History(false)` opts a model and its subclasses out. The mark can sit on an abstract base class and covers its concrete subclasses.
- `audit.data.rules`: track models by class name, or every model, without a decorator. The package registers the schema of the `audit.data` section.
- `HistorySpecs`: which models are tracked and how, resolved at a model's first write.
- `toHistoryValue()` and `historyEntryOf()`: the encoding of a captured row change as a history entry.
- `Model.history()` on a marked model, `historyOf(Model)` on any tracked one: `of(id)`, `asOf(id, at)`, `since(seq)`, `byActor(actor)` and `forget(id)`.
- `row.history()` and `historyOf(row)`: `entries()`, `asOf(at)` and `forget()` of one row.
- `toHistoryEntry(event)`: the history entry of an audit event read from the trail itself.

Installing the package adds two migrations on the default connection, `orm_history` and the `audit_event` of `@spinajs/audit-orm`; with `db.MigrationCheck: 'fail'` (the default) the application does not boot until `npx spinajs migrate-up` has applied them, also with no model tracked. See the [documentation](../../docs/orm-history/README.md).

A marked model declares the members the mark installs:

```ts
export interface Invoice extends TrackedRow {}

@Model('invoice')
@History()
export class Invoice extends ModelBase<Invoice> {
  declare static history: TrackedModel['history'];
}
```
