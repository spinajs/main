# Repository middleware

`RepositoryMiddleware` is an abstract set of CRUD lifecycle hooks. It is **not reachable** from the package: nothing exports it and nothing calls its hooks. To run code around every query, use the ORM's `QueryMiddleware`, shown below.

## How it works

`RepositoryMiddleware` (`src/middleware.ts`) is an abstract `AsyncService`. Every hook has an empty default, so a subclass overrides only what it needs.

1. `src/index.ts` does not re-export `middleware.js`.
2. `package.json` `exports` maps only `"."`, so a deep import such as `@spinajs/orm-http/lib/middleware.js` does not resolve.
3. No code in the repository resolves `RepositoryMiddleware` or calls its hooks.

Reaching it requires adding `export * from './middleware.js';` to `src/index.ts`, and a controller that resolves `Array.ofType(RepositoryMiddleware)` and calls the hooks.

### The hooks

`...Start`: before anything runs. Async; a throw aborts.

| Hook | Arguments |
| --- | --- |
| `onGetMiddlewareStart(resource, req)` | Resource identifier, request |
| `onGetAllMiddlewareStart(req)` | Request |
| `onInsertMiddlewareStart(data, req)` | `JsonApiIncomingObject`, request |
| `onUpdateMiddlewareStart(resource, data, req)` | Resource, `JsonApiIncomingObject`, request |
| `onDeleteMiddlewareStart(resource, req)` | Resource, request |

`...Query`: amend the builder before it runs. Synchronous.

| Hook | Builder |
| --- | --- |
| `onGetMiddlewareQuery(query, model, req)` | `SelectQueryBuilder` |
| `onGetAllMiddlewareQuery(query, model, req)` | `SelectQueryBuilder` |
| `onInsertMiddlewareQuery(query, model, req)` | `InsertQueryBuilder` |
| `onUpdateMiddlewareQuery(resource, query, model, req)` | `UpdateQueryBuilder` |
| `onDeleteMiddlewareQuery(query, model, req)` | `DeleteQueryBuilder` |

`...Result`: reshape the response. Synchronous; returns the payload.

| Hook | Returns |
| --- | --- |
| `onGetMiddlewareResult(jsonData, req)` | The payload |
| `onGetAllMiddlewareResult(jsonData, req)` | The payload |
| `onInsertMiddlewareResult(jsonData, req)` | The payload |
| `onUpdateMiddlewareResult(jsonData, req)` | The payload |
| `onDeleteMiddlewareResult(req)` | Nothing |

### `JsonApiIncomingObject`

The JSON:API request body the `...Start` hooks receive. It is exported and annotated with `@Schema('http://json-schema.org/draft-07/schema#')`. The package also ships `src/schemas/json-api.json`.

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

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| CRUD hooks | none: `RepositoryMiddleware` is not exported or registered | none | none | Not usable from outside the package. |
| Query hooks (ORM) | `QueryMiddleware` (list), singleton per class | none registered by this package | your subclasses | `@Injectable(QueryMiddleware)` on a subclass; every builder on every connection calls it. |
| Model lifecycle hooks (ORM) | `ModelMiddleware` (list) | none registered by this package | your subclasses | `@Injectable(ModelMiddleware)` on a subclass; see [Query builder](../orm/05-query-builder.md). |

### QueryMiddleware: scope every query to a tenant

`QueryMiddleware` is invoked by every builder, whatever created it: `@FromModel()`, `@Relation()`, `.filter()` or your own code. That makes it the place for rules that must hold on every route.

- `afterQueryCreation(query)` runs from the builder constructor, before the caller adds anything. Add constraints here.
- `beforeQueryExecution(query)` runs once, right before execution, with the query fully built. Inspect or rewrite values here; a value set at construction would be overwritten by the caller's `values()`.
- A throw from either hook aborts the query.

```ts sample
import { Injectable } from '@spinajs/di';
import { QueryMiddleware, QueryBuilder, QueryContext, InsertQueryBuilder } from '@spinajs/orm';

@Injectable(QueryMiddleware)
export class TenantScope extends QueryMiddleware {
  public afterQueryCreation(query: QueryBuilder): void {
    if (query.QueryContext === QueryContext.Select || query.QueryContext === QueryContext.Update || query.QueryContext === QueryContext.Delete) {
      (query as any).where('TenantId', 7);
    }
  }

  public beforeQueryExecution(query: QueryBuilder): void {
    if (query instanceof InsertQueryBuilder) {
      query.forceColumn('TenantId', 7);
    }
  }
}
```

## Important behaviour

- `RepositoryMiddleware` is dead code today. Do not design around it.
- `QueryMiddleware` also runs for the lookups this package makes, so a tenant scope there turns another tenant's row into a `404` from `@FromModel()` and `@Relation()`.

## Best practices

- Put cross-cutting row rules (tenant, soft delete, ownership) in `QueryMiddleware`, not in each `@FromModel({ query })`.

## Related

- [`QueryMiddleware` hooks](../orm/05-query-builder.md#querymiddleware-hooks): the full contract and ordering.
- [Route arguments](02-route-args.md): `@FromModel()` lookups pass through `QueryMiddleware`.
- [Custom route arguments and hydrators](08-custom-route-args-and-hydrators.md): per-route-argument rules when `QueryMiddleware` is too broad.
