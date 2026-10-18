# `@spinajs/orm-http`

Glue between `@spinajs/orm` and `@spinajs/http`: route arguments that load or build models from a request, schema-validated filtering, and DTO fields that resolve to database rows.

It does **not** generate controllers, routes or CRUD endpoints. You write ordinary `@spinajs/http` controllers; this package removes the lookup and validation code inside them.

## Install

```sh
npm install @spinajs/orm-http
```

Importing the package is enough. Its classes register themselves with DI on import, and `OrmHttpBootstrapper` finishes the setup when the ORM resolves.

## Features

| Feature | What it does |
| --- | --- |
| [Bootstrapping](01-bootstrapping.md) | `OrmHttpBootstrapper`: what importing the package registers, and what happens to every model when the ORM resolves |
| [Route arguments](02-route-args.md) | `@FromModel` loads a row by a request value (404 when absent); `@AsModel` and `@Body` build an unsaved model from the body |
| [Filtering](03-filtering.md) | `@Filterable`, `@Filter`, every operator, nested groups, the generated JSON schema, `SelectQueryBuilder.filter()` |
| [DTO relations](04-dto-relations.md) | `@Relation` on a DTO field: the incoming id is replaced with the resolved model, 404 when absent |
| [Pagination and ordering](05-pagination-and-order.md) | `PaginationDTO`, `OrderDTO`: schema-validated paging and sorting input; `readPage`, `readSort`, `DEFAULT_PAGE`: default, clamp and whitelist it |
| [Repository middleware](06-repository-middleware.md) | `RepositoryMiddleware` (defined, not exported) and the ORM's `QueryMiddleware` that works instead |
| [Custom filter columns](07-custom-filter-columns.md) | `IColumnFilter.query`: your own SQL for a filter column; inline column sets for models you cannot decorate |
| [Custom route arguments and hydrators](08-custom-route-args-and-hydrators.md) | Replace or extend `FromDbModel`, `AsDbModel`, `FilterModelRouteArg`, `DbModelHydrator`, `RelationResolverHydrator` through DI |
| [Not-found response](09-not-found-response.md) | `OrmNotFound` turns `OrmNotFoundException` into `404`; replace it with your own response |
| [Model statics and builder extension](10-model-statics-and-builder-extension.md) | `MODEL_STATIC_MIXINS`, `SelectQueryBuilder.prototype.filter`, the `@spinajs/orm` type augmentation; add your own statics |

## Quick start

```ts sample
import { BaseController, BasePath, Get, Ok, Post } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { AsModel, Filter, Filterable, FromModel, IFilterRequest } from '@spinajs/orm-http';

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
  /** GET /articles/:article: loaded by primary key, 404 when missing. */
  @Get(':article')
  public byId(@FromModel() article: Article) {
    return new Ok(article.dehydrate());
  }

  /** GET /articles?filter={"op":"and","filters":[{"Column":"Title","Operator":"like","Value":"orm"}]} */
  @Get()
  public async list(@Filter(Article) filter: IFilterRequest) {
    const rows = await Article.select().filter(filter?.filters, filter?.op);
    return new Ok(rows.map((r) => r.dehydrate()));
  }

  /** POST /articles: a new Article hydrated from the body, saved here. */
  @Post()
  public async create(@AsModel() article: Article) {
    await article.insert();
    return new Ok(article.dehydrate());
  }
}
```

## Related packages

- [`@spinajs/orm`](../orm/README.md): models, query builders and `OrmNotFoundException`; this package extends its types and its `SelectQueryBuilder`.
- [`@spinajs/http`](../http/README.md): controllers, `RouteArgs`, `ArgHydrator` and the error map that every feature here plugs into.
- [`@spinajs/di`](../di/README.md): every route argument, hydrator and response here is a DI registration you can replace.
- `@spinajs/validation`: `@Schema` on DTOs and the filter schema validated by `FilterModelRouteArg`.
- [`@spinajs/http-swagger`](../http-swagger/README.md): documents `@FromModel`, `@Filter` and `@Relation` parameters by reading this package's metadata.
