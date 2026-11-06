# Scopes and builder extensions

Add your own methods to query builders. A **scope** adds methods to the builders of one model: `Invoice.query().overdue(now)`. A **query extension** adds a method to every builder of a class, for all models: `.createdWithin(7)`.

| Need | Use |
| --- | --- |
| Conditions reused for one model (status, tenant, ownership) | [Query scope](#query-scopes) |
| A method on every select builder, also in `populate()` callbacks and `driver.select()` | [Query extension](#query-extensions) |
| Logic on every query without calling a method (tenant filter, audit) | [`QueryMiddleware`](05-query-builder.md#querymiddleware-hooks) |
| Different SQL for a statement | [Compiler or statement override](12-architecture.md) |

## How it works

### Query scopes

1. You write a class that implements `QueryScope` and assign an instance to `public static readonly _queryScopes` on the model.
2. A model static (`query()`, `where()`, `update()`, `destroy()`, ...) calls `createQuery()` in `builders/create-query.ts`.
3. `createQuery()` resolves the builder from the connection's container.
4. For a `SelectQueryBuilder`, `UpdateQueryBuilder` or `DeleteQueryBuilder`, it copies every method of the scope's class onto the builder instance, bound to the builder. `InsertQueryBuilder` gets none: it has no `WHERE`.
5. You call the scope method on the builder. Inside it, `this` is the builder; return `this` to keep chaining.

The model statics declare `T['_queryScopes']` in their return types, so scope methods type-check on `Invoice.where(...)`, `Invoice.update(...)` and `Invoice.destroy(...)`.

### Query extensions

The way `@spinajs/orm-http` (`.filter()`), `@spinajs/intl-orm` (`.translate()`) and `@spinajs/authz-orm` (`.accessible()`, `.within()`) add methods:

1. Declare the method with module augmentation of `ISelectQueryBuilder<T>` (and `IUpdateQueryBuilder<T>` / `IDeleteQueryBuilder<T>` when it applies to writes).
2. Write a subclass of the base for the builder you extend, `SelectQueryExtension`, `UpdateQueryExtension`, `DeleteQueryExtension` or `InsertQueryExtension`, with a `name` and the `methods`, and register it with `@Injectable(<that base>)`. A method for several builders is several classes sharing one `methods` object. `defineQueryExtension({ name, target, methods, onClone })` builds such a class from a plain object and picks the base from `target`; register it with `DI.register(MyExtension).as(SelectQueryExtension)` (or the matching base).
3. `Orm.resolve()` installs every registered extension once, before it opens a connection. Every builder of that class then has the methods: model queries, relation queries, `driver.select()` and clones.
4. A method runs with `this` set to the builder. `this.state()` gives it the builder's model, relations, container, owner relation and connection.
5. `onClone(source, clone)` runs whenever a select builder is cloned, so state the extension keeps per builder can follow the copy.

### Builder subclass

`OrmDriver` and `createQuery()` resolve builders from DI (`SelectQueryBuilder`, `UpdateQueryBuilder`, ...). Registering a subclass under the base class makes DI return it everywhere, relation queries included. See the caveats in [Important behaviour](#important-behaviour); prefer a query extension. The full guide, including how to keep your class across `clone()`, is [Injecting your own builders](../orm-sql/09-injecting-your-own-builders.md).

## Services and extension points

| Service | Role | Default implementation | How to override |
| --- | --- | --- | --- |
| `QueryScope` | Marker base class for scope classes | none | Implement it; set `public static readonly _queryScopes` on the model. |
| `SelectQueryBuilder`, `UpdateQueryBuilder`, `DeleteQueryBuilder`, `InsertQueryBuilder` | Build one statement | `@spinajs/orm` classes | Add methods with a query extension, or `DI.register(MyBuilder).as(SelectQueryBuilder)`. |
| `SelectQueryExtension`, `UpdateQueryExtension`, `DeleteQueryExtension`, `InsertQueryExtension` | Add methods to one builder class | none; each package registers its own | `@Injectable(SelectQueryExtension)` (or the matching base) on a subclass. A subclass of a registered extension replaces it. |
| `ISelectQueryBuilder<T>`, `IUpdateQueryBuilder<T>`, `IDeleteQueryBuilder<T>` | Types the model statics return | `@spinajs/orm` interfaces | Module augmentation: `declare module '@spinajs/orm' { interface ISelectQueryBuilder<T> { ... } }`. |

## Important behaviour

- Scope methods are bound only by `createQuery()`, so only builders made by model statics have them. They are **missing** on `driver.select()`, on the query inside a `populate()` or `whereExist()` callback, and on a `clone()`.
- Only methods declared on the scope instance's own class are bound. Methods inherited from a parent scope class and arrow-function properties are **not**.
- Scope methods are copied per builder, on every model query. Keep the scope class small.
- A query extension is global: its methods are on every builder of its class in the process, for every model and connection.
- Extension methods exist from the first `Orm.resolve()` on. A method name that the builder already has, or that two extensions add to the same builder, fails `Orm.resolve()` with `ExtensionMethodCollision`.
- An extension whose class extends another registered extension's class replaces it. That is how you change a method a package adds.
- `SelectQueryBuilder.clone()` always builds a plain `SelectQueryBuilder` and copies only the core fields. A subclass type is lost on clone unless you override `clone()`; extension state follows the copy through `onClone`.
- `clone()` runs no query middleware, so a clone keeps exactly what the original declared.

## Best practices

- Name scopes after the business rule: `overdue()`, `ofCustomer()`, `visibleTo(user)`. Not `whereStatus()`.
- Type `this` as a generic `This extends MyScope` when the scope must also work on `update()` and `destroy()`; type it as `ISelectQueryBuilder<Model[]> & MyScope` when it is select-only.
- Use a scope for one model, a query extension for a cross-model concept, and `QueryMiddleware` when callers must not be able to forget it.
- Put the extension class in the package's entry module, next to the `declare module` block, so the type and the method load together.
- Keep extension state in a `WeakMap` keyed by the builder and copy it in `onClone`, as `@spinajs/authz-orm` does.

## Patterns and antipatterns

```ts
// Don't: scope methods do not exist inside populate() callbacks; this throws at runtime
await Customer.where('Id', 5).populate('Invoices', function () {
  (this as any).overdue(now);
});

// Do: repeat the condition in the callback, or move it into a query extension
await Customer.where('Id', 5).populate('Invoices', function () {
  this.where('Status', 'unpaid').where('DueAt', '<', now);
});
```

```ts
// Don't: an inherited scope method is not bound; Invoice.query().active() is undefined
class BaseScope implements QueryScope {
  public active(this: IWhereBuilder<unknown>) { return this.where('Active', true); }
}
class InvoiceScope extends BaseScope {}

// Do: declare the method on the class you assign to _queryScopes
class InvoiceScope implements QueryScope {
  public active<This extends InvoiceScope>(this: This): This {
    (this as unknown as IWhereBuilder<unknown>).where('Active', true);
    return this;
  }
}
```

```ts
// Don't: state set on the builder is lost when the query is cloned
function traced(this: QueryBuilder, label: string) {
  (this as unknown as { _label: string })._label = label;
  return this;
}

// Do: keep state in a WeakMap and carry it across clone() with onClone
const labels = new WeakMap<QueryBuilder, string>();
export const Traced = defineQueryExtension({
  name: 'app.traced',
  target: 'select',
  methods: {
    traced(this: QueryBuilder, label: string) {
      labels.set(this, label);
      return this;
    },
  },
  onClone(source, clone) {
    const label = labels.get(source);
    if (label !== undefined) labels.set(clone, label);
  },
});
DI.register(Traced).as(SelectQueryExtension);
```

## Examples

### Reuse overdue and customer filters with a scope

```ts sample
import { Connection, IWhereBuilder, ISelectQueryBuilder, Model, ModelBase, Primary, QueryScope } from '@spinajs/orm';
import { DateTime } from 'luxon';

export class InvoiceQueryScope implements QueryScope {
  // select builders only
  public overdue(this: ISelectQueryBuilder<Invoice[]> & InvoiceQueryScope, now: DateTime): ISelectQueryBuilder<Invoice[]> & InvoiceQueryScope {
    this.where('Status', 'unpaid').where('DueAt', '<', now);
    return this;
  }

  // generic `this`: binds to select, update and delete builders alike
  public ofCustomer<This extends InvoiceQueryScope>(this: This, customerId: number): This {
    (this as unknown as IWhereBuilder<Invoice>).where('CustomerId', customerId);
    return this;
  }
}

@Connection('default')
@Model('invoices')
export class Invoice extends ModelBase<Invoice> {
  public static readonly _queryScopes: InvoiceQueryScope = new InvoiceQueryScope();

  @Primary()
  public Id: number;

  public CustomerId: number;

  public Status: string;

  public DueAt: DateTime;
}

export async function overdueForCustomer(customerId: number): Promise<Invoice[]> {
  return await Invoice.query().ofCustomer(customerId).overdue(DateTime.now()).take(100);
}

export async function deleteCustomerDrafts(customerId: number, ids: number[]): Promise<void> {
  await Invoice.destroy(ids).ofCustomer(customerId);
}
```

### Add `createdWithin()` to every select builder

```ts sample
import { Injectable } from '@spinajs/di';
import { Connection, Model, ModelBase, Primary, QueryBuilder, QueryExtension, SelectQueryBuilder, SelectQueryExtension } from '@spinajs/orm';
import { DateTime } from 'luxon';

declare module '@spinajs/orm' {
  interface ISelectQueryBuilder<T> {
    /** Rows whose `CreatedAt` falls in the last `days` days. */
    createdWithin(days: number): this;
  }
}

function createdWithin(this: QueryBuilder, days: number) {
  return (this as SelectQueryBuilder).where('CreatedAt', '>=', DateTime.now().minus({ days }));
}

@Injectable(SelectQueryExtension)
export class CreatedWithinExtension extends SelectQueryExtension {
  public readonly name = 'app.created-within';
  public readonly methods: QueryExtension['methods'] = { createdWithin };
}

@Connection('default')
@Model('support_tickets')
export class SupportTicket extends ModelBase<SupportTicket> {
  @Primary()
  public Id: number;

  public Status: string;

  public CreatedAt: DateTime;
}

export async function openTicketsThisWeek(): Promise<SupportTicket[]> {
  return await SupportTicket.where('Status', 'open').createdWithin(7);
}
```

### Replace the select builder with a subclass

```ts
import { DI } from '@spinajs/di';
import { SelectQueryBuilder } from '@spinajs/orm';

// Every SelectQueryBuilder resolved from DI is now a LimitedSelectQueryBuilder.
// clone() still returns a plain SelectQueryBuilder.
export class LimitedSelectQueryBuilder<T = any> extends SelectQueryBuilder<T> {
  public page(index: number, size = 25): this {
    return this.skip(index * size).take(size);
  }
}

DI.register(LimitedSelectQueryBuilder).as(SelectQueryBuilder);
```

## Related

- [Model API](03-model-api.md): the model statics that create scoped builders.
- [Query builder](05-query-builder.md): builder methods and `QueryMiddleware`.
- [Relations](06-relations.md): `populate()` and `whereExist()` callbacks, where scopes are not bound.
- [Architecture](12-architecture.md): compilers and statements, for changing the SQL itself.
- [`@spinajs/orm-http`](../orm-http/03-filtering.md): `.filter()`, a query extension.
- [`@spinajs/authz-orm`](../../packages/authz-orm/README.md): `.accessible()`, `.within()`, with clone-safe state.
