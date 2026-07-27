# `@spinajs/orm-http` documentation

Glue between `@spinajs/orm` and `@spinajs/http`. It adds route-argument decorators that load or
build models straight from a request, a declarative filtering layer, and DTO fields that resolve
to database entities.

It does **not** generate controllers or routes. You write ordinary `@spinajs/http` controllers;
this package removes the boilerplate inside them.

## Pages

| | Page | Covers |
| --- | --- | --- |
| 01 | [Overview](01-overview.md) | What it adds, bootstrapping, the extension points |
| 02 | [Route arguments](02-route-args.md) | `@FromModel`, `@AsModel`, `DbModelHydrator`, model params |
| 03 | [Filtering](03-filtering.md) | `@Filterable`, `@Filter`, every operator, the generated schema |
| 04 | [DTO relations](04-dto-relations.md) | `@Relation` on a DTO, `RelationResolverHydrator` |
| 05 | [Pagination and ordering](05-pagination-and-order.md) | `PaginationDTO`, `OrderDTO` |
| 06 | [Repository middleware](06-repository-middleware.md) | `RepositoryMiddleware`, error responses |

## At a glance

```ts sample
import { BaseController, BasePath, Get, Ok, Query } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { FromModel, Filter, IFilterRequest } from '@spinajs/orm-http';
import { Filterable } from '@spinajs/orm-http';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  @Filterable(['eq', 'like'])
  public Title: string;

  @Filterable(['eq', 'gt', 'lt'])
  public Views: number;
}

@BasePath('articles')
export class ArticleController extends BaseController {
  /** GET /articles/:article — loaded by primary key, 404 when missing. */
  @Get(':article')
  public byId(@FromModel() article: Article) {
    return new Ok(article.dehydrate());
  }

  /** GET /articles?filter={"op":"and","filters":[{"Column":"Title","Operator":"like","Value":"x"}]} */
  @Get()
  public async list(@Filter(Article) filter: IFilterRequest, @Query() _page: number) {
    const rows = await Article.select().filter(filter.filters, filter.op);
    return new Ok(rows.map((r) => r.dehydrate()));
  }
}
```

## Related

- [`@spinajs/orm`](../../orm/docs/) — the core
- [`@spinajs/orm-api`](../../orm-api/docs/) — CRUD controller building blocks built on the same ideas

## A note on this package's tests

`npm test` in this package currently fails during bootstrap with
`No __file_provider_instance__ registered, make sure fs package is imported in your
application` — the test harness does not register `@spinajs/fs`. That is a test-configuration
gap, not a defect in the package. The behaviour documented here is read from the source and from
the test fixtures.
