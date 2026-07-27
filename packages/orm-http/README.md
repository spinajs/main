# `@spinajs/orm-http`

Glue between [`@spinajs/orm`](../orm) and `@spinajs/http`: route arguments that load or build
models straight from a request, a declarative filtering layer, and DTO fields that resolve to
database entities.

It does **not** generate controllers or routes. You write ordinary `@spinajs/http` controllers;
this package removes the boilerplate inside them.

## Install

```bash
npm install @spinajs/orm-http
```

Importing it is enough — its bootstrapper registers itself with DI and runs when the ORM
resolves.

## Usage

```ts
import { BaseController, BasePath, Get, Post, Ok } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { FromModel, AsModel, Filter, Filterable, IFilterRequest } from '@spinajs/orm-http';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  @Filterable(['eq', 'like'])
  public Title: string;
}

@BasePath('articles')
export class ArticleController extends BaseController {
  /** GET /articles/:article — loaded by primary key, 404 when missing. */
  @Get(':article')
  public one(@FromModel() article: Article) {
    return new Ok(article.dehydrate());
  }

  /** GET /articles?filter={"op":"and","filters":[{"Column":"Title","Operator":"like","Value":"x"}]} */
  @Get()
  public async list(@Filter(Article) filter: IFilterRequest) {
    const rows = await Article.select().filter(filter.filters, filter.op);
    return new Ok(rows.map((r) => r.dehydrate()));
  }

  /** POST /articles — hydrated from the body, not fetched or saved. */
  @Post()
  public async create(@AsModel() article: Article) {
    await article.insert();
    return new Ok(article.dehydrate());
  }
}
```

## What it adds

| Feature | Entry point |
| --- | --- |
| Load a model from a route / query / body / header parameter | `@FromModel()` |
| Build an unsaved model from the request body | `@AsModel()` |
| Declarative, schema-validated filtering | `@Filterable()` + `@Filter()` |
| DTO fields that resolve to entities | `@Relation()` |
| Pagination and ordering DTOs | `PaginationDTO`, `OrderDTO` |
| `404` for `OrmNotFoundException` | `OrmNotFound` |

It also installs `filter()`, `filterColumns()` and `filterSchema()` onto every model class.

## Documentation

Full documentation lives in **[docs/](docs/)**.

| | Page |
| --- | --- |
| 01 | [Overview](docs/01-overview.md) |
| 02 | [Route arguments](docs/02-route-args.md) |
| 03 | [Filtering](docs/03-filtering.md) |
| 04 | [DTO relations](docs/04-dto-relations.md) |
| 05 | [Pagination and ordering](docs/05-pagination-and-order.md) |
| 06 | [Repository middleware](docs/06-repository-middleware.md) |

## Known issues

- `RepositoryMiddleware` is defined in `src/middleware.ts` but re-exported from neither
  `src/index.ts` nor the `exports` map, so it is currently unreachable. Use `QueryMiddleware`
  from the core instead — see [docs/06](docs/06-repository-middleware.md).
- `npm test` fails during bootstrap with `No __file_provider_instance__ registered`: the test
  harness does not register `@spinajs/fs`. That is a test-configuration gap, not a defect in the
  package.

## Development

```bash
npm run build
npm run docs:check   # from the repo root
```
