# Overview

## Exports

Everything reachable from `@spinajs/orm-api`'s entry point:

| Export | Kind | Purpose |
| --- | --- | --- |
| `AsDbModel`, `FromDbModel` | `RouteArgs` | Build / load a model from a request. |
| `AsModel(field?)`, `FromModel(options?)` | decorators | Their decorator forms. |
| `DbModelHydrator` | `ArgHydrator` | Hydrates a model from a request value. |
| `OrmHttpBootstrapper` | `Bootstrapper` | Sets `DbModelHydrator` as every model's arg hydrator. |

`src/index.ts` re-exports nothing else. The remaining pieces live in their own modules and are
reachable only when your bundler or `ts-node` setup resolves package-internal paths — the
`package.json` `exports` map exposes `"."` only.

| Module | Contents |
| --- | --- |
| `interfaces.ts` | `Crud`, `CollectionApiTransformer`, `JsonApiIncomingObject`, `ITransformOptions`, `FromModelOptions`, `IQueryFilterEntry`, `_assertSingleColumnKey` |
| `PlainJsonCollectionTransformer.ts` | The default transformer. |
| `route-args/ModelType.ts` | `ModelType()` and `ModelTypeRouteArgs`. |
| `policies/FindModelType.ts` | `FindModelType`. |
| `dto/*.ts` | `QueryArgs`, `QueryFilter`, `QueryIncludes`. |
| `hydrators/*.ts` | `GetFilterHydrator`, `QueryIncludesHydrator`. |
| `schemas/*.ts` | The JSON schemas behind those DTOs. |
| `middleware.ts` | `RepositoryMiddleware` — unexported, uninvoked. |
| `config/orm-api.ts` | The bundled configuration. |

In practice, applications in this repository import these by relative path from their own source
tree, which is how the package's own tests do it.

## Bootstrapping

`OrmHttpBootstrapper` runs on `di.resolved.Orm` and sets `DbModelHydrator` as the
`custom:arg_hydrator` for every discovered model, so a model used as a plain `@Body()` parameter
arrives hydrated.

Unlike `@spinajs/orm-http`'s bootstrapper, this one does **not** install any static mixins — no
`filter()`, `filterColumns()` or `filterSchema()`. Filtering here goes through `QueryFilter`
instead.

```ts sample
import { DI, Bootstrapper } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import '@spinajs/orm-api';

export async function bootstrap() {
  const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
  for (const b of bootstrappers) {
    await b.bootstrap();
  }

  return await DI.resolve(Orm);
}
```

Importing both this package and `@spinajs/orm-http` registers two bootstrappers that both set
`custom:arg_hydrator` to their own `DbModelHydrator`. The implementations are equivalent, so the
result is the same either way — but it is a reason to pick one package rather than both.

## `orm-api` versus `orm-http`

The two packages overlap substantially. `orm-http` is the newer and more capable of the pair.

| Capability | `orm-api` | `orm-http` |
| --- | --- | --- |
| `@FromModel` | Yes | Yes, plus `queryField`, `paramField`, `include`, `OrmNotFoundException` |
| Composite-key guard | `_assertSingleColumnKey` throws `BadRequest` | `queryField` escape hatch, and a clearer message |
| Missing row | `firstOrFail()` | `firstOrThrow(new OrmNotFoundException(...))` → `404` via `OrmNotFound` |
| `@AsModel` | Body only | Body / query / param / header, plus an empty-body guard |
| Filtering | `QueryFilter` DTO, a flat `{ key: { val, op } }` map | `@Filterable` / `@Filter`, per-column operator whitelists, generated schema |
| DTO relations | — | `@Relation` |
| Model type from URL | `ModelType()` + `FindModelType` | — |
| Collection transformer | `CollectionApiTransformer` | — |
| Static mixins | — | `filter`, `filterColumns`, `filterSchema` |

Use `orm-api` when you want the **generic** shape — one controller serving `/:model/:id` for
every registered model. Use `orm-http` for hand-written, per-model controllers.

## `FromModel` here

The signature differs from `orm-http`'s in ways easy to trip over.

`FromModelOptions` for this package:

| Option | Meaning |
| --- | --- |
| `field` | The request field holding the key. Defaults to the parameter name. (`orm-http` calls this `paramField`.) |
| `paramType` | `FromParams` (default), `FromQuery`, `FromBody`, `FromHeader`. |
| `include` | Relations always populated. |
| `noInclude` | Ignore the request's `include` / `_include`. |
| `query` | Replace the whole query. Receives `callData.Payload` — not `(routeParams, value)` as in `orm-http`. |

There is no `queryField`: the lookup column is always the primary key, and a composite key
throws `BadRequest` from `_assertSingleColumnKey`.

```ts sample
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { FromModel } from '@spinajs/orm-api';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Title: string;
}

@BasePath('articles')
export class ArticleController extends BaseController {
  /** GET /articles/:article */
  @Get(':article')
  public one(@FromModel() article: Article) {
    return new Ok(article.dehydrate());
  }
}
```

The default query also applies the same **parent scoping** as `orm-http`: for each `belongsTo`
relation, a route argument whose name matches the relation (case-insensitively, optionally
`_`-prefixed) constrains the relation's foreign key.

## `_assertSingleColumnKey`

```ts
export function _assertSingleColumnKey(descriptor: IModelDescriptor): string
```

Returns the single key column, or throws `BadRequest`:

```
model X has a composite primary key (A, B); the generic CRUD routes address rows by a single
id and cannot serve it
```

Generic CRUD routes address a row by one `:id` segment, which cannot carry a composite key.
Failing with a `400` beats a query that silently filters on half the key.
