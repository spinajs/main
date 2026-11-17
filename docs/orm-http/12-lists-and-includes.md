# Lists and includes

A list endpoint answers one page of rows, the number of rows the filter matches, and, when asked, the aggregates of those rows. `readList` does all of it in SQL from the arguments `@Filter`, `@Query`, `@Aggregate` and `@Include` hand the handler. `@Includable` decides which relations a request may load with the rows.

## How it works

1. `@Includable()` on a relation property adds it to `IModelDescriptor.IncludableRelations`.
2. `@Include(Model)` records a route parameter of type `'IncludeModelRouteArg'`. It reads `req.query.include` (or `_include`, or the body's `include`) and answers the relation names through `readInclude`, each checked against the model's `@Includable` relations. An absent value is `[]`.
3. `readList(model, request, options)` builds a filtered builder for each statement it runs:
   1. the count of the filtered rows;
   2. unless `pagination.limit` is `0`, one page of rows, sorted by `readSorting` over `model.sortableColumns()` with the primary key last, the relations of `include` populated;
   3. when `aggregate` is set, the aggregates of the same filter, whatever the page.
4. It answers `{ rows, total, aggregates? }`; `aggregates` is absent when the request asked for none.

## Decorators

| Decorator | Applies to | Arguments | Effect |
| --- | --- | --- | --- |
| `@Includable()` | Model relation property | none | A request may load the relation through `include`. |
| `@Include(ModelOrNames)` | Route method parameter | a model class, or the relation names | The checked relation names of `?include=`, `[]` when absent. |

`readInclude(input, includable, options?)` accepts `"A,B"`, `'["A","B"]'` or a list of names. Repeats are dropped. A name outside `includable`, a value that is no text or list of text, or more than 16 names (`MAX_INCLUDES`) goes to `invalid` (default: `InvalidArgument`, `400`), and the message names the allowed relations.

`@FromModel` keeps its behaviour for a model with no `@Includable` relation: `?include=` populates any relation named. Once the model marks at least one relation `@Includable`, `@FromModel` populates only those and answers `400` for any other.

## readList

| Argument | Field | Meaning |
| --- | --- | --- |
| `request` | `filter` | `IFilterRequest`, as `@Filter` hands it. |
| | `pagination` | `{ limit, page }` or `{ limit, offset }`, read with `readPage`; `limit: 0` answers no rows, for a request that wants the total or the aggregates alone. |
| | `sorting` | `{ by }`, as `SortingDTO` carries it, read with `readSorting`. |
| | `aggregate` | `IAggregateRequest`, as `@Aggregate` hands it. |
| | `include` | Relation names already checked, as `@Include` hands them. |
| `options` | `defaultLimit`, `maxLimit`, `invalid` | As for `readPage`. |
| | `fallbackSort` | The last sort; default the first primary key column ascending. |
| | `scope`, `columns`, `signal` | See [Scope, projection and cancellation](#scope-projection-and-cancellation). |

## Scope, projection and cancellation

`readList` takes three options for a caller that wraps it, such as a query service that applies row security:

| Option | Type | Effect |
| --- | --- | --- |
| `scope` | `(query: SelectQueryBuilder) => void` | Runs on each statement the list builds (the count, the page, the aggregates), before the request's filter. What it adds becomes one bracketed condition ANDed with the filter, so `total`, `rows` and `aggregates` all describe the scoped rows, and an `or` in the request cannot widen them. |
| `columns` | `readonly string[]` | The only columns `rows` answer, plus the primary key. A request that filters (at any depth), sorts, groups or measures by another column is refused with a `400` naming it, so a hidden column cannot be probed. |
| `signal` | `AbortSignal` | Checked before each statement; an aborted signal rejects with `CanceledException` from `@spinajs/util`, its `cause` the signal's reason. |

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { Filterable, IListRequest, readList } from '@spinajs/orm-http';

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  public TenantId: number;

  @Filterable(['eq'])
  public Status: string;

  @Filterable(['gt', 'lt'])
  public Amount: number;
}

export async function listOrders(request: IListRequest, tenantId: number) {
  return readList(Order, request, {
    scope: (query) => {
      query.where('TenantId', tenantId);
    },
    columns: ['Status', 'Amount'],
    signal: AbortSignal.timeout(5_000),
    maxLimit: 1000,
  });
}
```

With `@spinajs/authz-orm`, the scope can carry row security. `.accessible()` marks the builder; the access plan is made when each statement runs, for the principal of the current request:

```ts
await readList(Order, request, { scope: (query) => query.accessible('order.read') });
```

### Limits

- The ORM cannot cancel a statement or give it a timeout, so after an abort the statement in flight runs to its end and the next one does not start. On PostgreSQL a connection-wide `statement_timeout` can be set through `PGOPTIONS` (for example `-c statement_timeout=5000`), which the driver passes on with its connection options; there is no timeout per query.
- `include` cannot be combined with `columns`: a relation answers columns of another model that the projection does not govern. Run two lists if you need both.
- `columns` names columns of the model's table. A relation path (`Customer.Name`) or a filter-only column cannot be listed, so a projection refuses filters on them. A name that is no column throws `InvalidOption`.
- `scope` runs once per statement: three times for a list with aggregates. Keep it free of side effects.
- Every statement is built, and every refusal made, before the first one runs.
- `readList` does not validate the filter against the model's schema; that is `@Filter`'s job, and it is where the group depth is bounded.

## Typed responses

`ListResponseDTO<T>` is the answer's class, and `listResponseSchema(id, row, { aggregates? })` its JSON schema: `rows` of the given row schema, `total` an integer, `aggregates` a list of objects unless `aggregates: false`. Declare a subclass per model and name it in `@returns`, so the OpenAPI document types the rows.

```ts sample
import { BaseController, BasePath, Get, Ok, Query } from '@spinajs/http';
import { BelongsTo, Connection, Model, ModelBase, Primary, SingleRelation } from '@spinajs/orm';
import { Schema } from '@spinajs/validation';
import {
  Aggregatable,
  Aggregate,
  Filter,
  Filterable,
  Groupable,
  IAggregateRequest,
  IFilterRequest,
  Include,
  Includable,
  ListResponseDTO,
  PaginationDTO,
  Sortable,
  SortingDTO,
  listResponseSchema,
  readList,
} from '@spinajs/orm-http';

@Connection('default')
@Model('customers')
export class Customer extends ModelBase<Customer> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  @Sortable()
  public Id: number;

  public CustomerId: number;

  @Groupable()
  @Sortable()
  @Filterable(['eq', 'in'])
  public Status: string;

  @Aggregatable(['sum', 'avg'])
  @Sortable()
  @Filterable(['gt', 'lt'])
  public Amount: number;

  @Includable()
  @BelongsTo(Customer, 'CustomerId')
  public Customer: SingleRelation<Customer>;
}

@Schema({ $id: 'shop.OrderRow', type: 'object', properties: { Id: { type: 'integer' }, Status: { type: 'string' }, Amount: { type: 'number' } } })
export class OrderRow {}

@Schema(listResponseSchema('shop.OrderList', { $ref: 'shop.OrderRow' }))
export class OrderListDto extends ListResponseDTO<OrderRow> {}

@BasePath('orders')
export class OrderController extends BaseController {
  /**
   * List orders
   * @returns {OrderListDto} One page of rows, the number of matching rows and the aggregates asked for
   */
  @Get()
  public async list(
    @Filter(Order) filter: IFilterRequest,
    @Query() pagination: PaginationDTO,
    @Query() sorting: SortingDTO,
    @Aggregate(Order) aggregate: IAggregateRequest,
    @Include(Order) include: string[],
  ) {
    return new Ok(await readList(Order, { filter, pagination, sorting, aggregate, include }, { maxLimit: 200 }));
  }
}
```

```
GET /orders?pagination={"limit":2}&sorting={"by":[{"column":"Amount","order":"DESC"}]}&aggregate={"measures":[{"name":"total","fn":"sum","column":"Amount"}]}
→ { "rows": [ { "Id": 5, … }, { "Id": 2, … } ], "total": 5, "aggregates": [ { "total": 950 } ] }
```

## Important behaviour

- The primary key is always the last sort, so a page boundary never splits rows that tie on the requested columns.
- `total` counts every row the filter matches, before paging.
- The aggregates are computed over the filtered rows, not over the page.

## Related

- [Filtering](03-filtering.md), [Pagination and ordering](05-pagination-and-order.md), [Aggregates](11-aggregates.md): the parts `readList` combines.
- [Route arguments](02-route-args.md): `@FromModel` and its `include`.
