# `@spinajs/orm-api` documentation

Building blocks for CRUD controllers over ORM models: route arguments that resolve a model
*type* from a URL segment, query-argument DTOs for filtering / including / paging, a pluggable
collection transformer, and a policy that validates the requested model.

## Read this first — what the package actually ships

The name suggests a generic, ready-made CRUD API. It is **not** that today.

| Component | State |
| --- | --- |
| `JsonApi` controller (`src/controllers/JsonApi.ts`) | **Entirely commented out.** No routes are registered by this package. |
| `Crud` base controller | Ships, exported, usable. |
| `ModelType()` route argument + `FindModelType` policy | Ship and work. |
| `QueryArgs`, `QueryFilter`, `QueryIncludes` DTOs + schemas | Ship and work. |
| `PlainJsonCollectionTransformer` | Ships and is the default. |
| `FromModel` / `AsModel` route args | Ship, but are an older, less capable copy of the ones in [`@spinajs/orm-http`](../../orm-http/docs/). |
| `RepositoryMiddleware` | Defined but **not exported**, and nothing invokes it. |
| Bundled config `system.dirs.controllers` | Points at `node_modules/@spinajs/orm-http/lib/*/controllers`, a directory that does not exist. |
| Test suite | Does not run — it fails in `before all` with `No __file_provider_instance__ registered`, and its assertions target `collection/*` routes that no controller in this repository defines. |

So: use this package for its **pieces**, and write the controller yourself. If you only need
route arguments and filtering, prefer `@spinajs/orm-http` — it is the maintained one.

## Pages

| | Page | Covers |
| --- | --- | --- |
| 01 | [Overview](01-overview.md) | Exports, bootstrapping, the relationship to orm-http |
| 02 | [Configuration](02-configuration.md) | The bundled config and what to override |
| 03 | [Building a CRUD controller](03-building-a-crud-controller.md) | Using `Crud`, `ModelType()` and `FindModelType` to build the routes yourself |
| 04 | [Query arguments](04-query-args.md) | `QueryArgs`, `QueryFilter`, `QueryIncludes` and their hydrators |
| 05 | [Transformers and policies](05-transformers-and-policies.md) | `CollectionApiTransformer`, `PlainJsonCollectionTransformer`, `FindModelType` |

## Related

- [`@spinajs/orm-http`](../../orm-http/docs/) — the maintained HTTP integration
- [`@spinajs/orm`](../../orm/docs/) — the core
