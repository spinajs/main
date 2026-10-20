# Model statics and builder extension

The package extends `@spinajs/orm` in three ways: statics bound onto every model (`MODEL_STATIC_MIXINS`), a `filter()` method on `SelectQueryBuilder.prototype`, and `declare module '@spinajs/orm'` typings for both. You can add your own statics through the same object and wrap the prototype method.

## How it works

1. Importing the package runs `builders.ts`, which assigns `SelectQueryBuilder.prototype.filter`. Every select builder of every model has it from then on.
2. `extension.ts` augments `@spinajs/orm` types:
   - `IModelDescriptor.FilterableColumns?: Map<string, IColumnFilter<unknown>>`
   - `ISelectQueryBuilder.filter(filter?, logicalOperator?, filters?): this`
   - `ModelBase.filterSchema()`, `ModelBase.filterColumns()`, `ModelBase.filter(filterRequest?)`
3. When the ORM resolves, `OrmHttpBootstrapper` iterates `MODEL_STATIC_MIXINS` with `for...in` and sets `Model[key] = MODEL_STATIC_MIXINS[key].bind(Model)` on every model in `orm.Models`.

| Static | Returns |
| --- | --- |
| `filterColumns()` | `[{ column, operators, query }]` for every filterable column; `[]` when none. |
| `filterSchema()` | JSON schema of an `IFilterRequest` over those columns; `{}` when none. |
| `filter(request?)` | `Promise` of the rows: a new select builder with `filter(request.filters, request.op)` applied, awaited. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Model statics | `MODEL_STATIC_MIXINS`, exported object, copied onto each model once per ORM resolve | `filter`, `filterColumns`, `filterSchema` | your keys | Add a function under a new key before the ORM resolves; declare its type in `declare module '@spinajs/orm' { namespace ModelBase { ... } }`. Replacing an existing key changes it for every model. |
| `SelectQueryBuilder.filter()` | prototype method, set at import | `builders.ts` | none | Keep the original and assign a wrapper after importing `@spinajs/orm-http`. |
| Type augmentation | `declare module '@spinajs/orm'` in `extension.ts` | as listed above | none | Add your own `declare module '@spinajs/orm'` block for statics you add. |

### MODEL_STATIC_MIXINS: add a `filterPage()` static to every model

Each function is bound to the model class, so `this` is the model. Add the key at import time of your module: the bootstrapper copies keys when the ORM resolves, and later keys are not copied.

```ts sample
import { ModelBase } from '@spinajs/orm';
import { IFilterRequest, MODEL_STATIC_MIXINS } from '@spinajs/orm-http';

declare module '@spinajs/orm' {
  namespace ModelBase {
    /** One page of rows matching a client filter. Added by the application, not by orm-http. */
    export function filterPage<T extends ModelBase<unknown>>(filterRequest: IFilterRequest | undefined, page: number, perPage: number): Promise<Array<T>>;
  }
}

(MODEL_STATIC_MIXINS as Record<string, unknown>).filterPage = async function (this: typeof ModelBase, filterRequest: IFilterRequest | undefined, page: number, perPage: number) {
  return await this.select()
    .filter(filterRequest?.filters, filterRequest?.op)
    .take(perPage)
    .skip(page * perPage);
};
```

Use it on any model once the ORM has resolved:

```ts
const rows = await Article.filterPage<Article>(filter, 0, 25);
```

### SelectQueryBuilder.filter(): log every client filter

Wrap the method instead of replacing it, so validation and SQL stay in `builders.ts`. Import `@spinajs/orm-http` first; the wrapper must see its method.

```ts sample
import { SelectQueryBuilder } from '@spinajs/orm';
import { FilterableLogicalOperators, IColumnFilter, IFilterEntry } from '@spinajs/orm-http';

const proto = SelectQueryBuilder.prototype as unknown as {
  filter(filters?: IFilterEntry[] | null, op?: FilterableLogicalOperators, columns?: IColumnFilter<unknown>[]): SelectQueryBuilder;
};

const applyFilter = proto.filter;

proto.filter = function (this: SelectQueryBuilder, filters?: IFilterEntry[] | null, op?: FilterableLogicalOperators, columns?: IColumnFilter<unknown>[]) {
  if (filters && filters.length > 0) {
    console.info('client filter', { model: this.Model?.name, op: op ?? 'and', filters });
  }
  return applyFilter.call(this, filters, op, columns);
};
```

## Important behaviour

- Statics are copied once, on the first `Orm` resolve. A key added after that is not on the models.
- A model class not in `orm.Models` has none of the statics; `.filter()` on its builder then fails unless you pass the columns.
- The typings for `filterColumns()`, `filterSchema()` and `filter()` exist as soon as you import the package, before the statics do. Calling them before the ORM resolves type-checks and throws `TypeError` at run time.
- `ISelectQueryBuilder.filter()` and `IFilterRequest.filters` are typed `IFilterEntry[]`: plain conditions (`IFilter`) and nested groups (`IFilterGroup`).
- `filter()` on a model's static side is `async` and returns rows, not a builder. Use `Model.select().filter(...)` when you need to chain.

## Best practices

- Put added statics in one module imported next to `@spinajs/orm-http`, so the key exists before any bootstrapper runs.
- Give added statics a name that cannot collide with ORM statics (`select`, `where`, `all`...): the bootstrapper overwrites without checking.

## Patterns and antipatterns

```ts
// Don't: replace the prototype method outright; you lose column checks and the 100-entry limit
(SelectQueryBuilder.prototype as any).filter = function (filters: any[]) { /* own SQL */ return this; };

// Do: wrap it and call the original
const applyFilter = (SelectQueryBuilder.prototype as any).filter;
(SelectQueryBuilder.prototype as any).filter = function (...args: any[]) { return applyFilter.apply(this, args); };
```

## Related

- [Bootstrapping](01-bootstrapping.md): when the statics are copied.
- [Filtering](03-filtering.md): what `filter()`, `filterColumns()` and `filterSchema()` do.
- [Scopes and builder extensions](../orm/16-scopes-and-builder-extensions.md): the ORM's own ways to add builder methods.
