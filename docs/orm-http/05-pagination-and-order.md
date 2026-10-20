# Pagination and ordering

`PaginationDTO` and `OrderDTO` are schema-validated DTOs for paging and sorting input. They carry and validate the values; applying them to a query is your code, because page size limits and sortable columns are application decisions.

`readPage` and `readSort` are pure helpers that turn that input, or raw query-string values, into a defaulted, clamped page and a whitelisted sort. They do not touch the request or the query builder.

## How it works

1. A route argument typed `PaginationDTO` or `OrderDTO`, read with `@Query()`, takes `req.query[<argument name>]`: one JSON-encoded object per argument, `?pagination={"page":2,"limit":25}`.
2. `RouteArgs.tryHydrateParam()` builds `new PaginationDTO(JSON.parse(value))` and validates it against the class `@Schema`.
3. An absent argument is `undefined` and is not validated.
4. The handler reads `limit`, `page`, `column`, `order` and builds the query.

## Decorators

`PaginationDTO` schema, `$id` `arrow.common.PaginationDTO`:

| Field | Type | Constraint | Required |
| --- | --- | --- | --- |
| `limit` | `number` | `minimum: 0` | no |
| `page` | `number` | `minimum: 0` | no |

`OrderDTO` schema, `$id` `arrow.common.OrderDTO`:

| Field | Type | Constraint | Required |
| --- | --- | --- | --- |
| `order` | `SortOrder` | `ASC`, `DESC`, `asc`, `desc` | no |
| `column` | `string` | none | no |

`ITransformOptions` is a type for handing paging metadata to a collection transformer:

| Field | Type | Meaning |
| --- | --- | --- |
| `totalCount` | `number?` | Rows matching before paging. |
| `currentPage` | `number?` | Zero-based page index. |
| `perPage` | `number?` | Page size. |
| `order` | `SortOrder?` | Sort direction. |
| `orderBy` | `string?` | Sort column. |
| `model` | `Class<ModelBase>` | The model class. |

## Helpers

`readPage(input, options?)` returns `{ limit, offset }`.

| Input | Result |
| --- | --- |
| `undefined`, `null`, `{}` | `{ limit: defaultLimit, offset: 0 }` |
| `{ limit, offset }` | as given, `limit` clamped to `maxLimit` |
| `{ limit, page }` (a `PaginationDTO`) | `offset = page * limit`, after the clamp |
| digit strings (`'20'`) | read as numbers, so raw `req.query` values work |
| `limit < 1`, a negative, fractional or non-numeric value, an array, `offset` and `page` together, a non-object | `invalid(field, message)` |

| Option | Default | Meaning |
| --- | --- | --- |
| `defaultLimit` | `DEFAULT_PAGE.limit` (50) | Limit when the input has none; itself clamped to `maxLimit`. |
| `maxLimit` | `MAX_PAGE_LIMIT` (500) | A larger `limit` is clamped, not rejected. |
| `invalid` | throws `InvalidArgument(message, field)` | Map a malformed value to your own error. Must throw. |

`readSort(input, sortable, fallback, options?)` returns `{ column, order }`. A column outside `sortable` (case-sensitive) or an order other than `ASC` / `DESC` (any case) goes to `invalid`. A missing column is `fallback.column`; a missing order is `fallback.order`, else `SortOrder.ASC`. The order comes back upper case.

`DEFAULT_PAGE` is the frozen `{ limit: 50, offset: 0 }`.

```ts sample
import { BaseController, BasePath, Get, Ok, Query } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary, SortOrder } from '@spinajs/orm';
import { OrderDTO, PaginationDTO, readPage, readSort } from '@spinajs/orm-http';

@Connection('default')
@Model('invoices')
export class Invoice extends ModelBase<Invoice> {
  @Primary()
  public Id: number;

  public IssuedAt: string;

  public Total: number;
}

const SORTABLE = ['Id', 'IssuedAt', 'Total'];

@BasePath('invoices')
export class InvoiceController extends BaseController {
  /** GET /invoices?pagination={"page":2,"limit":25}&order={"column":"Total","order":"desc"} */
  @Get()
  public async list(@Query() pagination?: PaginationDTO, @Query() order?: OrderDTO) {
    const { limit, offset } = readPage(pagination, { defaultLimit: 25, maxLimit: 100 });
    const sort = readSort(order, SORTABLE, { column: 'IssuedAt', order: SortOrder.DESC });

    const rows = await Invoice.select().order(sort.column, sort.order).take(limit).skip(offset);
    return new Ok(rows.map((r) => r.dehydrate()));
  }
}
```

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Paging input | none: a plain DTO class with `@Schema` | `PaginationDTO` | your subclass | Subclass it with a stricter `@Schema` (for example `maximum` on `limit`) and type the argument with the subclass. |
| Sorting input | none: a plain DTO class with `@Schema` | `OrderDTO` | your subclass | Subclass it with an `enum` on `column` to whitelist sortable columns in the schema. |

### PaginationDTO and OrderDTO: stricter subclasses

Subclass when one endpoint needs limits the shared DTO does not have. The subclass `@Schema` is validated instead of the base one; the fields and constructor are inherited.

```ts sample
import { BaseController, BasePath, Get, Ok, Query } from '@spinajs/http';
import { Schema } from '@spinajs/validation';
import { Connection, Model, ModelBase, Primary, SortOrder } from '@spinajs/orm';
import { OrderDTO, PaginationDTO } from '@spinajs/orm-http';

@Connection('default')
@Model('invoices')
export class Invoice extends ModelBase<Invoice> {
  @Primary()
  public Id: number;

  public Number: string;

  public IssuedAt: string;

  public Total: number;
}

/** At most 100 invoices per page. */
@Schema({
  type: 'object',
  $id: 'app.InvoicePagination',
  properties: {
    limit: { type: 'number', minimum: 1, maximum: 100 },
    page: { type: 'number', minimum: 0 },
  },
})
export class InvoicePagination extends PaginationDTO {}

/** Only indexed columns are sortable; anything else answers 400. */
@Schema({
  type: 'object',
  $id: 'app.InvoiceOrder',
  properties: {
    order: { type: 'string', enum: ['ASC', 'DESC', 'asc', 'desc'] },
    column: { type: 'string', enum: ['Id', 'IssuedAt', 'Total'] },
  },
})
export class InvoiceOrder extends OrderDTO {}

@BasePath('invoices')
export class InvoiceController extends BaseController {
  /** GET /invoices?pagination={"page":0,"limit":50}&order={"column":"IssuedAt","order":"DESC"} */
  @Get()
  public async list(@Query() pagination?: InvoicePagination, @Query() order?: InvoiceOrder) {
    const limit = pagination?.limit ?? 25;
    const page = pagination?.page ?? 0;

    const rows = await Invoice.select()
      .order(order?.column ?? 'Id', order?.order ?? SortOrder.DESC)
      .take(limit)
      .skip(page * limit);

    return new Ok(rows.map((r) => r.dehydrate()));
  }
}
```

## Important behaviour

- Each DTO is one query-string argument named after the handler parameter, JSON-encoded. `?page=2&limit=25` does **not** fill a `PaginationDTO` argument.
- Both fields of each DTO are optional. A client may send `{}`, `{ "page": 2 }`, or nothing.
- `limit: 0` passes the schema. Guard it before `take()`, or read the page with `readPage`, which rejects it.
- `OrderDTO.column` is not constrained. Without a whitelist a client can sort by any column of the table.
- Pages are zero-based in every example here; nothing in the DTO enforces either base.

## Best practices

- Default `limit` and cap it, with `readPage` or in a subclass schema.
- Whitelist `column` with `readSort`, or with an `enum` in a subclass schema so a bad column answers `400` before your handler runs.
- Count on a `clone()` of the builder taken before `take()` / `skip()`, so the total covers the whole filtered set.

## Patterns and antipatterns

```ts
// Don't: OrderDTO.column goes straight into order(); any column is sortable
query.order(sort.column, sort.order);

// Do: whitelist the column
if (sort?.column && SORTABLE.includes(sort.column)) {
  query.order(sort.column, sort.order ?? SortOrder.ASC);
}
```

## Examples

### Page and sort a listing

```ts sample
import { BaseController, BasePath, Get, Ok, Query } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary, SortOrder } from '@spinajs/orm';
import { PaginationDTO, OrderDTO } from '@spinajs/orm-http';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Title: string;

  public Views: number;
}

const SORTABLE = ['Id', 'Title', 'Views'];

@BasePath('articles')
export class ArticleController extends BaseController {
  /** GET /articles?pagination={"page":0,"limit":25}&sort={"column":"Title","order":"ASC"} */
  @Get()
  public async list(@Query() pagination?: PaginationDTO, @Query() sort?: OrderDTO) {
    const limit = pagination?.limit && pagination.limit > 0 ? pagination.limit : 25;
    const page = pagination?.page ?? 0;

    const query = Article.select().take(limit).skip(page * limit);

    if (sort?.column && SORTABLE.includes(sort.column)) {
      query.order(sort.column, sort.order ?? SortOrder.ASC);
    }

    const rows = await query;
    return new Ok(rows.map((r) => r.dehydrate()));
  }
}
```

### Return a page with its total

A builder runs once and memoises its result, and `count()` clears the column list, so count on a `clone()`. `clone()` copies `GROUP BY` too, so the total stays correct for grouped queries.

```ts sample
import { BaseController, BasePath, Get, Ok, Query } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { PaginationDTO } from '@spinajs/orm-http';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Published: boolean;

  public Title: string;
}

@BasePath('articles')
export class PagedController extends BaseController {
  @Get()
  public async list(@Query() pagination?: PaginationDTO) {
    const limit = pagination?.limit && pagination.limit > 0 ? pagination.limit : 25;
    const page = pagination?.page ?? 0;

    const base = Article.select().where('Published', true);

    // Clone BEFORE paging, so the count covers the whole filtered set.
    const total = await base.clone().selectCount();
    const rows = await base.take(limit).skip(page * limit);

    return new Ok({
      Data: rows.map((r) => r.dehydrate()),
      Total: total,
      Page: page,
      Limit: limit,
    });
  }
}
```

### Page with `Model.all()` when there are no conditions

The ORM's `all(page, perPage)` pages are zero-based; paging applies only when both arguments are valid.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Title: string;
}

export async function page(n: number) {
  return await Article.all(n, 25); // take(25).skip(n * 25)
}
```

### Sort by a column of a relation

`order`, `orderBy` and `orderByDescending` accept a dotted path: the relation is populated and sorted inside.

```ts sample
import { Connection, Model, ModelBase, Primary, BelongsTo, SingleRelation } from '@spinajs/orm';

@Connection('default')
@Model('authors')
export class Author extends ModelBase<Author> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public author_id: number;

  @BelongsTo(Author, 'author_id', 'Id')
  public Author: SingleRelation<Author>;
}

export async function byAuthorName() {
  return await Article.select().orderBy('Author.Name');
}
```

## Related

- [Filtering](03-filtering.md): filter the same listing with `@Filter()`.
- [Query builder](../orm/05-query-builder.md): `take`, `skip`, `order`, `clone`, `selectCount`.
- [Route arguments in http](../http/04-route-arguments.md): how `@Query()` reads and validates a DTO.
