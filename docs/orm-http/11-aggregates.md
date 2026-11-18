# Aggregates

An aggregate request asks for totals instead of rows: one row per group of a column's values, with sums, averages, minimums, maximums or counts over the rows a filter keeps. The model decides which columns a request may group by and which functions it may apply to which column; `@Aggregate()` validates the request against that, and `SelectQueryBuilder.aggregate()` turns it into one `SELECT … GROUP BY` statement.

Both allow-lists are opt-in and empty by default. Grouping by a column lists its distinct values, and a sum exposes totals a page of rows does not show, so a column takes part only when the model says so.

## How it works

1. `@Groupable()` on a model property adds it to `IModelDescriptor.GroupableColumns`; `@Aggregatable(['sum', 'avg'])` records the functions in `IModelDescriptor.AggregatableColumns`.
2. `@Aggregate(Model)` on a route argument records a parameter of type `'AggregateModelRouteArg'`. `AggregateModelRouteArg.extract()` reads `req.query[<argument name>]`, then `req.body[<argument name>]`, parses a string as JSON (invalid JSON answers `400`) and validates the value against the schema `aggregateSchemaFor()` builds from the model's allow-lists. An absent value is `undefined`.
3. `query.aggregate(spec)` checks the request again, replaces the selected columns with the group columns and the measures, adds `GROUP BY`, the order and the limit.
4. Read the rows with `asRaw()` and pass them through `readAggregateRows(rows, spec)`: each row holds the group columns and the measures by name, with sums, averages and counts as numbers.

## Decorators

| Decorator | Applies to | Arguments | Effect |
| --- | --- | --- | --- |
| `@Groupable()` | Model property | none | The column may appear in `groupBy`, and be counted. |
| `@Aggregatable(functions)` | Model property | `AggregateFunction[]`, at least one | The column may be measured with these functions, and be counted. |
| `@Aggregate(ModelOrColumns)` | Route method parameter | a model class, or `IAggregateColumns` | Reads, parses and validates an `IAggregateRequest`. |

## Request shape

```json
{ "groupBy": ["Status"],
  "measures": [ { "name": "total", "fn": "sum", "column": "Amount" }, { "name": "orders", "fn": "count" } ],
  "order": [ { "column": "total", "order": "DESC" } ],
  "limit": 10 }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `groupBy` | `string[]`, at most 8 (`MAX_GROUP_COLUMNS`) | One result row per distinct combination of these `@Groupable` columns. None: one row over every matching row. |
| `measures` | at least 1, at most 16 (`MAX_MEASURES`) | The values each result row carries. |
| `measures[].name` | `^[A-Za-z_][A-Za-z0-9_]{0,62}$` | The key in each result row and the SQL alias; unique, and different from every group column. |
| `measures[].fn` | `sum`, `avg`, `min`, `max`, `count` | The function. |
| `measures[].column` | `string` | The measured column. Required, and `@Aggregatable` with that function, for every function but `count`. `count` without a column counts rows; with one it counts the column's non-null values and accepts any groupable or aggregatable column. |
| `order` | `{ column, order? }[]` | By group columns or measure names. |
| `limit` | integer `>= 1` | At most 1000 rows (`MAX_AGGREGATE_ROWS`); a larger value is clamped, and an absent one is 1000. |

A request outside these rules answers `400` naming the field: an unknown or not allowed column, function or measure name, a name used twice, no measures, an order column that is neither a group nor a measure.

## Helpers

| Helper | Returns |
| --- | --- |
| `Model.aggregateColumns()` | `IAggregateColumns`: `{ groupable, aggregatable }` of the model. |
| `Model.aggregateSchema()` | The JSON schema of an aggregate request over the model. |
| `aggregateSchemaFor(columns)` | The same for an `IAggregateColumns` you write by hand. |
| `query.aggregate(spec, columns?)` | The builder; `columns` replaces the model's allow-lists. |
| `readAggregateRows(rows, spec)` | Raw rows as answer rows: the group columns and the measures, numeric text of `sum`, `avg` and `count` as numbers (PostgreSQL hands a `bigint` count back as text). |

```ts sample
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { Aggregatable, Aggregate, Filter, Filterable, Groupable, IAggregateRequest, IFilterRequest, readAggregateRows } from '@spinajs/orm-http';

@Connection('default')
@Model('orders')
export class Order extends ModelBase<Order> {
  @Primary()
  public Id: number;

  @Groupable()
  @Filterable(['eq', 'in'])
  public Status: string;

  @Aggregatable(['sum', 'avg', 'min', 'max'])
  @Filterable(['gt', 'lt'])
  public Amount: number;
}

@BasePath('orders')
export class OrderSummaryController extends BaseController {
  /** GET /orders/summary?aggregate={"groupBy":["Status"],"measures":[{"name":"total","fn":"sum","column":"Amount"}]} */
  @Get('summary')
  public async summary(@Filter(Order) filter: IFilterRequest, @Aggregate(Order) aggregate: IAggregateRequest) {
    const spec: IAggregateRequest = aggregate ?? { measures: [{ name: 'orders', fn: 'count' }] };
    const rows = await Order.query().filter(filter?.filters, filter?.op).aggregate(spec).asRaw<Record<string, unknown>[]>();
    return new Ok(readAggregateRows(rows, spec));
  }
}
```

```
GET /orders/summary?aggregate={"groupBy":["Status"],"measures":[{"name":"total","fn":"sum","column":"Amount"},{"name":"orders","fn":"count"}],"order":[{"column":"total","order":"DESC"}]}
→ [{ "Status": "paid", "total": 750, "orders": 2 }, { "Status": "open", "total": 200, "orders": 3 }]
```

## Limits

- No relation paths: `Customer.Name` can be neither grouped nor measured.
- No date buckets (by day, month) and no `HAVING` on a measure.
- `readList` answers the aggregates of the same filter next to a page of rows; see [Lists and includes](12-lists-and-includes.md).

## Related

- [Filtering](03-filtering.md): the filter an aggregate is computed over.
- [Lists and includes](12-lists-and-includes.md): a page of rows, its total and its aggregates in one answer.
- [Model statics and builder extension](10-model-statics-and-builder-extension.md): `aggregateColumns()`, `aggregateSchema()` and `SelectQueryBuilder.prototype.aggregate`.
