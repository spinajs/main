# Overview

## What it adds

| Feature | Entry point |
| --- | --- |
| Load a model from a route / query / body / header parameter | `@FromModel()` |
| Build an unsaved model from the request body | `@AsModel()` |
| Declarative, schema-validated filtering | `@Filterable()` + `@Filter()` |
| DTO fields that resolve to database entities | `@Relation()` |
| Pagination and ordering DTOs | `PaginationDTO`, `OrderDTO` |
| A `404` response for `OrmNotFoundException` | `OrmNotFound` |
| CRUD lifecycle hooks | `RepositoryMiddleware` |

## Bootstrapping

`OrmHttpBootstrapper` is registered as a `Bootstrapper` and runs on `di.resolved.Orm`, so it
fires the first time the ORM resolves. It does two things to **every** discovered model:

1. Sets `DbModelHydrator` as the model's `custom:arg_hydrator`, so a model used as a plain
   `@Body()` parameter is hydrated rather than left as a raw object.
2. Binds this package's `MODEL_STATIC_MIXINS` — `filter()`, `filterColumns()` and
   `filterSchema()` — onto the model class.

Importing the package is enough; DI finds the bootstrapper.

```ts sample
import { DI, Bootstrapper } from '@spinajs/di';
import { Orm } from '@spinajs/orm';
import '@spinajs/orm-http';

export async function bootstrap() {
  const bootstrappers = await DI.resolve(Array.ofType(Bootstrapper));
  for (const b of bootstrappers) {
    await b.bootstrap();
  }

  // OrmHttpBootstrapper's `di.resolved.Orm` hook fires here.
  return await DI.resolve(Orm);
}
```

Because the mixins are attached at ORM-resolve time, they are **not** available while a
controller class is being constructed. `FilterModelRouteArg` works around this by building the
filter schema at request time rather than at decoration time.

## Module augmentation

`extension.ts` augments `@spinajs/orm`'s own types, so the additions are visible wherever the
core types are:

```ts
declare module '@spinajs/orm' {
  export interface IModelDescriptor {
    FilterableColumns?: Map<string, IColumnFilter<unknown>>;
  }

  export interface ISelectQueryBuilder {
    filter(filter: IFilter[], logicalOperator?: FilterableLogicalOperators, filters?: IColumnFilter<unknown>[]): this;
  }

  namespace ModelBase {
    export function filterSchema(): any;
    export function filterColumns(): IColumnFilter<unknown>[];
    export function filter<T extends ModelBase<unknown>>(filterRequest: IFilterRequest): Promise<Array<T>>;
  }
}
```

`SelectQueryBuilder.prototype.filter` is installed by direct prototype assignment in
`builders.ts`, at module load — not through DI.

## Statics added to every model

| Static | Returns |
| --- | --- |
| `filterColumns()` | `[{ column, operators, query }]` for every `@Filterable` column. `[]` when the model has none. |
| `filterSchema()` | A JSON schema validating an `IFilterRequest` against those columns. `{}` when the model has none. |
| `filter(request)` | A `SelectQueryBuilder` with the filter applied. |

## Package exports

| Export | Kind | Purpose |
| --- | --- | --- |
| `FromModel`, `AsModel` | decorators | Route arguments. |
| `FromDbModel`, `AsDbModel` | `RouteArgs` | Their implementations. |
| `DbModelHydrator` | `ArgHydrator` | Hydrates a model from a request value. |
| `Filterable`, `Filter` | decorators | Filtering. |
| `FilterModelRouteArg` | `RouteArgs` | Extracts and validates a filter. |
| `Relation`, `RelationResolverHydrator` | decorator + hydrator | DTO relations. |
| `PaginationDTO`, `OrderDTO` | DTOs | Paging and sorting. |
| `RepositoryMiddleware` | abstract | CRUD lifecycle hooks. |
| `OrmNotFound` | `Response` | `404` for `OrmNotFoundException`. |
| `JsonApiIncomingObject` | DTO | JSON:API request body shape. |
| `FromModelOptions`, `IColumnFilter`, `IFilter`, `IFilterRequest`, `ITransformOptions` | types | |
| `FilterableOperators`, `FilterableLogicalOperators` | types / enum | |
| `MODEL_STATIC_MIXINS` | object | The statics listed above. |

## Composite primary keys

Two places refuse to guess, and both say so with a `400`-shaped error rather than silently
filtering on half a key:

- `@FromModel()` — a route parameter carries one value, so pass `queryField` to name a single
  lookup column.
- `@Relation()` — a DTO relation field carries one value, so set `by`.

## Error responses

`OrmNotFound` is registered as a `Response` handling `OrmNotFoundException`, mapping it to
`404 NOT FOUND` and the `notFound.pug` template. Since `@FromModel()` uses `firstOrThrow(new
OrmNotFoundException(...))`, a missing row becomes a `404` with no work on your part.
