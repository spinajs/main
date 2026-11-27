# Injecting your own builders

Query builders are DI services too. Register a subclass of `SelectQueryBuilder` (or `InsertQueryBuilder`, `UpdateQueryBuilder`, `DeleteQueryBuilder`, ...) under the base class, and drivers, model statics and relations hand out your class instead. Use it when a method needs builder state; for a stateless method, a [query extension](../orm/16-scopes-and-builder-extensions.md#query-extensions) is simpler.

## How it works

1. **Registration.** `SelectQueryBuilder` registers itself with `@Injectable(SelectQueryBuilder)`. `DI.register(MySelectQueryBuilder).as(SelectQueryBuilder)` adds a later registration under the same key; the container returns the last one.
2. **Lookup.** Every DI site resolves from the connection's container (`driver.Container`). The child container answers first and falls back to its parent. No shipped driver registers a builder in its own container, so a root registration reaches every connection, and a registration in a driver subclass's `resolve()` reaches only that connection.
3. **Construction.** The container injects itself first (`@Inject(Container)`, inherited from `Builder`) and appends the call's arguments: `resolve(SelectQueryBuilder, [driver, model])` becomes `new MySelectQueryBuilder(container, driver, model)`. Query middlewares' `afterQueryCreation()` runs in the `SelectQueryBuilder` constructor.
4. **Model statics.** `createQuery()` resolves the builder from the model's connection container with `[driver, model]`, then binds the model's query scope methods onto the instance, adds the discrimination-map middleware, the table, the soft-delete and archive filters, and the database.
5. **Sites that use `new`.** A few places construct `SelectQueryBuilder` directly and never return your class (see the table below).

### Where each builder comes from

| Builder | Resolved through DI (your class is used) | Created with `new` (your class is not used) |
| --- | --- | --- |
| `SelectQueryBuilder` | `driver.select()`; `createQuery()` behind `Model.query()`, `where()`, `select()`, `get()`, `all()`, ...; relation queries (`populate()`, many-to-many junctions) via the string `'SelectQueryBuilder'`; the sub-builder of a join callback; `clone()` | `CreateViewQueryBuilder.as(callback)`; the deep-clone source of `CloneTableQueryBuilder` |
| `InsertQueryBuilder` | `driver.insert()`; `createQuery()` behind `Model.insert()`, the unit of work, relation objects | the `OnDuplicateQueryBuilder` it creates |
| `UpdateQueryBuilder`, `DeleteQueryBuilder` | `driver.update()`, `driver.del()`; `createQuery()` behind `Model.update()`, `destroy()`, soft delete, the unit of work | |
| `TruncateTableQueryBuilder`, `IndexQueryBuilder`, `SchemaQueryBuilder` | `driver.truncate()`, `driver.index()`, `driver.schema()` | every builder `SchemaQueryBuilder` returns (`createTable`, `alterTable`, `createView`, ...) |
| `WhereBuilder` | | nested `where(function () { ... })` groups |

Errors: none of its own. A subclass whose constructor signature differs from the base receives the wrong arguments; a subclass method missing on a `new` site fails with `... is not a function`.

## Services and extension points

| Service | Role | Default implementation | How to override |
| --- | --- | --- | --- |
| `SelectQueryBuilder` | SELECT queries | `SelectQueryBuilder` | `DI.register(Sub).as(SelectQueryBuilder)`, or `this.Container.register(Sub).as(SelectQueryBuilder)` in a driver subclass |
| `InsertQueryBuilder`, `UpdateQueryBuilder`, `DeleteQueryBuilder` | Writes | the `@spinajs/orm` classes | Same |
| `TruncateTableQueryBuilder`, `IndexQueryBuilder`, `SchemaQueryBuilder` | DDL entry points | the `@spinajs/orm` classes | Same |
| `ISelectQueryBuilder<T>` | The type model statics return | `@spinajs/orm` interface | Module augmentation, so your methods type-check on `Model.where(...)` |

Constructor signatures to keep:

| Class | Constructor |
| --- | --- |
| `SelectQueryBuilder` | `(container, driver, model?, owner?, applyMiddlewares = true, execution?)` |
| `InsertQueryBuilder`, `UpdateQueryBuilder`, `DeleteQueryBuilder` | `(container, driver, model)` |
| `IndexQueryBuilder`, `TruncateTableQueryBuilder`, `SchemaQueryBuilder` | `(container, driver)` |

## Important behaviour

- **`clone()` keeps your class, not your fields.** `SelectQueryBuilder.clone()` resolves the copy from the same container as its source and copies the core fields. A field your subclass adds starts at its default in the clone, unless you override `clone()` to copy it.
- `clone()` is called by the ORM itself, not only by your code: `SqlLazyQueryStatement.build()` clones the query on every compile of a `Lazy` where statement; `SqlWithRecursiveStatement`, `SqlExistsQueryStatement` and `SqlInQueryStatement` clone their sub-selects; `SqlJoinStatement.clone()` clones the builder of a join that has a callback, whenever a query with such a join is cloned; pagination helpers clone for the count; every relation load and every page of a keyset `stream()` runs on a clone.
- `clone()` runs no query middleware: the copy keeps exactly the statements of the original.
- A root registration is global: every connection, every model, every relation query gets your class.
- Query scope methods are bound onto the instance by `createQuery()` only; your subclass methods are on the prototype and work on every DI-created instance.
- `SelectQueryBuilderC` is an empty subclass in `@spinajs/orm`; nothing resolves it.
- `UpdateQueryBuilder` and `DeleteQueryBuilder` have no `clone()` of their own. The one they carry comes from the `WhereBuilder` mixin and returns a plain `WhereBuilder` with their conditions, not a copy of the update or delete.

## Best practices

- Keep the base constructor; add no required constructor parameters. A constructor of your own passes every argument to `super`: the ORM hands relation and join builders their `execution` as the last argument, and a subclass that drops it makes every merged builder read `{ kind: 'own' }` (see [Scopes and builder extensions](../orm/16-scopes-and-builder-extensions.md)).
- Override `clone()` when your subclass has fields of its own: take the `owner` argument, pass it to `super.clone(owner)` and copy your fields. The ORM passes an owner when it copies a populated relation together with its query; an override that drops the argument gives that relation a query owned by the relation it was copied from.
- Declare your methods on `ISelectQueryBuilder<T>` with module augmentation so model statics expose them with types.
- Register the subclass once, at startup, before `Orm` resolves, in the same module that declares it.
- Prefer a prototype extension when the method keeps no state, and `QueryMiddleware` when callers must not be able to skip it. See [Scopes and builder extensions](../orm/16-scopes-and-builder-extensions.md).

## Patterns and antipatterns

```ts
// Don't: the clone has your class, but PageSize is back at its default
const query = (Invoice.where('Status', 'unpaid') as PagedSelectQueryBuilder).pageSize(50);
query.clone().page(2); // skips 50 rows, not 100

// Do: override clone() to copy the fields your subclass adds
public clone(owner?: IOrmRelation): this {
  const copy = super.clone(owner);
  copy.PageSize = this.PageSize;
  return copy;
}
```

```ts
// Don't: a required extra parameter shifts every argument DI passes
constructor(container: IContainer, tenant: string, driver: OrmDriver) { ... }

// Do: take what the base takes and pass all of it on; read extra context from DI or from the driver
constructor(...args: ConstructorParameters<typeof SelectQueryBuilder>) {
  super(...args);
}
```

## Examples

### Paginate every select with a per-query page size

```ts sample
import { DI, NewInstance } from '@spinajs/di';
import { Connection, Model, ModelBase, Primary, SelectQueryBuilder } from '@spinajs/orm';
import type { IOrmRelation } from '@spinajs/orm';

declare module '@spinajs/orm' {
  interface ISelectQueryBuilder<T> {
    /** Rows of page `index` (0-based), `pageSize(n)` rows per page. */
    page(index: number): this;

    /** Rows per page for page(); 25 by default. */
    pageSize(size: number): this;
  }
}

@NewInstance()
export class PagedSelectQueryBuilder<T = any> extends SelectQueryBuilder<T> {
  public PageSize = 25;

  public pageSize(size: number): this {
    this.PageSize = size;
    return this;
  }

  public page(index: number): this {
    return this.skip(index * this.PageSize).take(this.PageSize);
  }

  public clone(owner?: IOrmRelation): this {
    const copy = super.clone(owner);
    copy.PageSize = this.PageSize;
    return copy;
  }
}

DI.register(PagedSelectQueryBuilder).as(SelectQueryBuilder);

@Connection('default')
@Model('invoices')
export class Invoice extends ModelBase<Invoice> {
  @Primary()
  public Id: number;

  public Status: string;
}

export async function unpaidInvoicesPage(index: number): Promise<Invoice[]> {
  const query = Invoice.where('Status', 'unpaid').pageSize(50);

  // the clone keeps the class and the page size
  return await query.clone().page(index);
}
```

### Use the subclass on one connection only

```ts sample
import { Injectable, NewInstance } from '@spinajs/di';
import { SelectQueryBuilder } from '@spinajs/orm';
import type { IOrmRelation } from '@spinajs/orm';
import { SqliteOrmDriver } from '@spinajs/orm-sqlite';

@NewInstance()
export class AuditedSelectQueryBuilder<T = any> extends SelectQueryBuilder<T> {
  public Purpose = 'unspecified';

  public because(purpose: string): this {
    this.Purpose = purpose;
    return this;
  }

  public clone(owner?: IOrmRelation): this {
    const copy = super.clone(owner);
    copy.Purpose = this.Purpose;
    return copy;
  }
}

@Injectable('orm-driver-sqlite-audited-reads')
@NewInstance()
export class AuditedReadsSqliteDriver extends SqliteOrmDriver {
  public resolve() {
    super.resolve();

    // only connections with Driver: 'orm-driver-sqlite-audited-reads' build AuditedSelectQueryBuilder
    this.Container.register(AuditedSelectQueryBuilder).as(SelectQueryBuilder);
  }
}
```

## Related

- [Scopes and builder extensions](../orm/16-scopes-and-builder-extensions.md): query scopes and prototype extensions, the lighter alternatives.
- [Query builder](../orm/05-query-builder.md): builder methods and `QueryMiddleware`.
- [Statements](03-statements.md): the statement `clone()` contract that `SelectQueryBuilder.clone()` relies on.
- [Extending an existing dialect](08-extending-an-existing-dialect.md): driver subclasses for per-connection registrations.
