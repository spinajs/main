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
| | `fallbackSort` | The last sort; default the primary key ascending. |

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
