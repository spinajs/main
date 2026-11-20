# `@spinajs/orm-history`

Row history of SpinaJS ORM models, recorded as `data` events in an audit trail of `@spinajs/audit`:

- `@History(options?)` and `registerHistory(Model, options?)`: track a model's whole row or a list of its columns, in the trail `history` or one the options name; `@History(false)` opts a model and its subclasses out.
- `audit.data.rules`: track models by class name, or every model, without a decorator. The package registers the schema of the `audit.data` section.
- `HistorySpecs`: which models are tracked and how, resolved at a model's first write.
- `toHistoryValue()` and `historyEntryOf()`: the encoding of a captured row change as a history entry.

A marked model declares the members the mark installs:

```ts
export interface Invoice extends TrackedRow {}

@Model('invoice')
@History()
export class Invoice extends ModelBase<Invoice> {
  declare static history: TrackedModel['history'];
}
```
