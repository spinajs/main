# Repository middleware and responses

## `RepositoryMiddleware` — currently unreachable

> **Read this before designing around it.** The class exists in
> [`src/middleware.ts`](../src/middleware.ts), but:
>
> - `src/index.ts` does not re-export it (it re-exports `interfaces`, `model`, `decorators`,
>   `extension`, `route-arg`, `builders`, `dto`, `dto-relation` and
>   `response-methods/OrmNotFound` — not `middleware.js`);
> - `package.json` declares `"exports": { "." : ... }` only, so a deep import such as
>   `@spinajs/orm-http/lib/mjs/middleware.js` does not resolve either;
> - nothing in this repository invokes its hooks. `@spinajs/orm-api` carries an identical copy,
>   equally unexported, and the generic CRUD controller the hooks were written for is commented
>   out in that package.
>
> It is dead code today. Reaching it requires adding `export * from './middleware.js';` to
> `src/index.ts` first. For interception that actually fires, use `QueryMiddleware` — see below.

### The intended shape

An abstract `AsyncService` whose methods all have empty defaults, so a subclass overrides only
what it needs. Three families of hook:

**`...Start` — before anything runs.** Async; throw to abort.

| Hook | Arguments |
| --- | --- |
| `onGetMiddlewareStart(resource, req)` | Resource identifier and request. |
| `onGetAllMiddlewareStart(req)` | |
| `onInsertMiddlewareStart(data, req)` | The incoming `JsonApiIncomingObject`. |
| `onUpdateMiddlewareStart(resource, data, req)` | |
| `onDeleteMiddlewareStart(resource, req)` | |

**`...Query` — amend the query.** Synchronous, receiving the builder before it executes.

| Hook | Builder |
| --- | --- |
| `onGetMiddlewareQuery(query, model, req)` | `SelectQueryBuilder` |
| `onGetAllMiddlewareQuery(query, model, req)` | `SelectQueryBuilder` |
| `onInsertMiddlewareQuery(query, model, req)` | `InsertQueryBuilder` |
| `onUpdateMiddlewareQuery(resource, query, model, req)` | `UpdateQueryBuilder` |
| `onDeleteMiddlewareQuery(query, model, req)` | `DeleteQueryBuilder` |

**`...Result` — reshape the response.** Synchronous, returning the payload.

| Hook | Returns |
| --- | --- |
| `onGetMiddlewareResult(jsonData, req)` | The payload. |
| `onGetAllMiddlewareResult(jsonData, req)` | |
| `onInsertMiddlewareResult(jsonData, req)` | |
| `onUpdateMiddlewareResult(jsonData, req)` | |
| `onDeleteMiddlewareResult(req)` | Nothing. |

Were it exported, a subclass would look like this — and a controller would have to resolve
`Array.ofType(RepositoryMiddleware)` and call the hooks itself, since nothing does it for you:

```ts
@Injectable(RepositoryMiddleware)
export class TenantScopeMiddleware extends RepositoryMiddleware {
  public onGetAllMiddlewareQuery(query: SelectQueryBuilder<any>, _model: Constructor<ModelBase>, req: express.Request): void {
    const tenantId = (req as any).Tenant?.Id;
    if (tenantId !== undefined) {
      query.andWhere('TenantId', tenantId);
    }
  }
}
```

## `QueryMiddleware` — the mechanism that works

Registered through DI in the core, and invoked by **every** builder on every connection, whatever
code path created it. This is what to reach for.

```ts sample
import { Injectable } from '@spinajs/di';
import { QueryMiddleware, QueryBuilder, QueryContext, InsertQueryBuilder } from '@spinajs/orm';

@Injectable(QueryMiddleware)
export class TenantScope extends QueryMiddleware {
  /**
   * Runs from the builder's CONSTRUCTOR, for every builder type. The right place to
   * ADD a constraint; the wrong place to read the payload, which does not exist yet.
   */
  public afterQueryCreation(query: QueryBuilder): void {
    if (query.QueryContext === QueryContext.Select || query.QueryContext === QueryContext.Update || query.QueryContext === QueryContext.Delete) {
      (query as any).where('TenantId', 7);
    }
  }

  /**
   * Runs once per builder immediately before execution, with the query fully
   * assembled. The right place to inspect or rewrite what is about to be written.
   */
  public beforeQueryExecution(query: QueryBuilder): void {
    if (query instanceof InsertQueryBuilder) {
      query.forceColumn('TenantId', 7);
    }
  }
}
```

The two hooks differ in what the query is guaranteed to contain, and that difference is
load-bearing rather than stylistic. A value written at construction would be overwritten by the
caller's own `values()` call; a constraint added just before execution is fine either way. Full
discussion in [the core's query-builder docs](../../orm/docs/06-query-builder.md#middleware).

A middleware that throws from either hook aborts the query.

## `ModelMiddleware`

The core also offers a model-lifecycle abstraction with `onInsert`, `onUpdate`, `onDelete` and
`onSelect`. Register subclasses under the `ModelMiddleware` token. See
[11-converters-and-hydration.md](../../orm/docs/11-converters-and-hydration.md).

## `OrmNotFound`

```ts
@HandleException([OrmNotFoundException])
@Injectable(Response)
export class OrmNotFound extends Response {
  protected _errorCode = HTTP_STATUS_CODE.NOT_FOUND;
  protected _template = 'notFound.pug';
}
```

This one *is* exported and registers itself when the package is imported. Any
`OrmNotFoundException` escaping a route becomes a `404` rendered through `notFound.pug`.

`@FromModel()` and `@Relation()` both raise `OrmNotFoundException` on a miss, so a missing row is
a `404` with nothing to write. `firstOrFail()` raises the same exception, so a hand-written query
behaves identically:

```ts sample
import { BaseController, BasePath, Get, Ok, Param } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Slug: string;
}

@BasePath('articles')
export class Controller extends BaseController {
  @Get('by-slug/:slug')
  public async bySlug(@Param() slug: string) {
    // OrmNotFoundException -> 404. No try/catch needed.
    const article = await Article.select().where('Slug', slug).firstOrFail();
    return new Ok(article.dehydrate());
  }
}
```

Use `firstOrThrow(error)` when you want a different status or message; it accepts either an
`Error` or a function receiving the compiled `ICompilerOutput`.

## `JsonApiIncomingObject`

The JSON:API request-body shape, `@Schema`-annotated against draft-07 and exported normally:

```ts
export class JsonApiIncomingObject {
  public data: {
    type: string;
    id: string;
    attributes: any;
    relationships: any;
  };
}
```

The package also ships `src/schemas/json-api.json` for validating such bodies.
