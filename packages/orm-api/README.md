# `@spinajs/orm-api`

Building blocks for CRUD controllers over [`@spinajs/orm`](../orm) models: a route argument that
resolves a model *type* from a URL segment, query-argument DTOs for filtering / including /
paging, a pluggable collection transformer, and a policy that validates the requested model.

## Read this first

The name suggests a ready-made generic CRUD API. It is **not** that today.

| Component | State |
| --- | --- |
| `JsonApi` controller (`src/controllers/JsonApi.ts`) | **Entirely commented out.** This package registers no routes. |
| `Crud` base controller | Ships and works. |
| `ModelType()` + `FindModelType` | Ship and work. |
| `QueryArgs`, `QueryFilter`, `QueryIncludes` | Ship and work. |
| `PlainJsonCollectionTransformer` | Ships; is the registered default. |
| `FromModel` / `AsModel` | Ship, but are an older, less capable copy of [`@spinajs/orm-http`](../orm-http)'s. |
| `RepositoryMiddleware` | Defined but not exported, and nothing invokes it. |
| `src/index.ts` | Re-exports only the four route-argument symbols; everything else is unreachable by specifier. |
| Bundled config `system.dirs.controllers` | Points at a directory in `@spinajs/orm-http` that does not exist. |
| Bundled config transformer | Names `JsonApiCollectionTransformer`, which is registered nowhere. |
| Test suite | Does not run — fails in `before all` with `No __file_provider_instance__ registered`, and asserts against `collection/*` routes no controller defines. |

**Use this package for its pieces and write the controller yourself.** If you only need route
arguments and filtering, prefer [`@spinajs/orm-http`](../orm-http) — it is the maintained one.

## Usage

```ts
import { BaseController, BasePath, Get, Ok, Policy, Query } from '@spinajs/http';
import { IModelStatic, ModelBase } from '@spinajs/orm';
import { Autoinject } from '@spinajs/di';
// Reachable only by relative path — see the docs.
import { Crud, CollectionApiTransformer, _assertSingleColumnKey } from '../../src/interfaces.js';
import { ModelType } from '../../src/route-args/ModelType.js';
import { FindModelType } from '../../src/policies/FindModelType.js';
import { QueryArgs } from '../../src/dto/QueryArgs.js';

@BasePath('collection')
@Policy(FindModelType)
export class Collection extends Crud {
  @Autoinject(CollectionApiTransformer)
  protected Transformer: CollectionApiTransformer;

  /** GET /collection/:model */
  @Get(':model')
  public async list(@ModelType() model: IModelStatic, @Query() args: QueryArgs) {
    const perPage = args?.perPage && args.perPage > 0 ? Math.min(args.perPage, 100) : 25;
    const page = args?.page && args.page > 0 ? args.page : 0;

    const query = model.query().select('*');
    const totalCount = await (query.clone() as any).selectCount();
    const data = await query.take(perPage).skip(page * perPage);

    return new Ok(this.Transformer.transform(data as ModelBase[], { model: model as any, totalCount, currentPage: page, perPage }));
  }
}
```

`FindModelType` validates the `:model` segment; `ModelType()` resolves it to the model class,
without a guard of its own — so always pair the two.

## Documentation

Full documentation lives in **[docs/](docs/)**.

| | Page |
| --- | --- |
| 01 | [Overview](docs/01-overview.md) |
| 02 | [Configuration](docs/02-configuration.md) |
| 03 | [Building a CRUD controller](docs/03-building-a-crud-controller.md) |
| 04 | [Query arguments](docs/04-query-args.md) |
| 05 | [Transformers and policies](docs/05-transformers-and-policies.md) |

## Security note

A generic `/:model` controller exposes **every registered model**, including internal ones.
`FindModelType` answers "is this a real model" and authorises nothing. Put an authorisation
policy in front of it, or keep an allow-list of exposed model names.

## Development

```bash
npm run build
npm run docs:check   # from the repo root
```
