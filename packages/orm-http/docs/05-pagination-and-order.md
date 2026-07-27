# Pagination and ordering

Two small schema-validated DTOs. They carry and validate the values; applying them to a query is
left to you, because how a listing should page and sort is an application decision.

## `PaginationDTO`

```ts
@Schema({
  type: 'object',
  $id: 'arrow.common.PaginationDTO',
  properties: {
    limit: { type: 'number', minimum: 0 },
    page: { type: 'number', minimum: 0 },
  },
})
export class PaginationDTO {
  public limit: number;
  public page: number;
}
```

Both are non-negative numbers. Note the fields are `limit` and `page` — not `perPage` or
`offset`.

## `OrderDTO`

```ts
@Schema({
  type: 'object',
  $id: 'arrow.common.OrderDTO',
  properties: {
    order: { type: 'string', enum: ['ASC', 'DESC', 'asc', 'desc'] },
    column: { type: 'string' },
  },
})
export class OrderDTO {
  public order: SortOrder;
  public column: string;
}
```

Both cases are accepted for `order`. `column` is **not** constrained by the schema — validate it
against a whitelist yourself before passing it to the query builder, or a client can sort by any
column in the table.

## Using them

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
  /** GET /articles?page=0&limit=25&column=Title&order=ASC */
  @Get()
  public async list(@Query() pagination: PaginationDTO, @Query() sort: OrderDTO) {
    const limit = pagination?.limit && pagination.limit > 0 ? pagination.limit : 25;
    const page = pagination?.page ?? 0;

    const query = Article.select().take(limit).skip(page * limit);

    // `column` is unconstrained by the schema — whitelist it.
    if (sort?.column && SORTABLE.includes(sort.column)) {
      query.order(sort.column, sort.order ?? SortOrder.ASC);
    }

    const rows = await query;
    return new Ok(rows.map((r) => r.dehydrate()));
  }
}
```

## Counting for a paged response

A builder executes at most once, so `clone()` before turning it into a count — otherwise the
memoized result of the first execution comes back.

`count()` also **clears the column list**, which is another reason to work on a clone.

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
  public async list(@Query() pagination: PaginationDTO) {
    const limit = pagination?.limit && pagination.limit > 0 ? pagination.limit : 25;
    const page = pagination?.page ?? 0;

    const base = Article.select().where('Published', true);

    // Clone BEFORE paging, so the count reflects the whole filtered set.
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

`clone()` copies group-by statements too, which matters here — a cloned builder that silently
lost its `GROUP BY` would report the wrong total.

## `Model.all(page, perPage)`

For a plain offset page with no extra conditions, the ORM's own static is shorter. Pages are
zero-based, and paging is applied only when **both** arguments are valid.

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

## Ordering across a relation

`order`, `orderBy` and `orderByDescending` accept a dotted path, which populates the relation and
sorts inside it.

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

## `ITransformOptions`

A shape for handing paging metadata to a collection transformer. `@spinajs/orm-api` consumes it
— see [its docs](../../orm-api/docs/05-transformers-and-policies.md).

| Field | Meaning |
| --- | --- |
| `totalCount` | Rows matching before paging. |
| `currentPage` | Zero-based page index. |
| `perPage` | Page size. |
| `order` | `SortOrder`. |
| `orderBy` | Column name. |
| `model` | The model class. |
