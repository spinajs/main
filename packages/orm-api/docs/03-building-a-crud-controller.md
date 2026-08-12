# Building a CRUD controller

Since this package ships no controller (see the [README](README.md)), here is how to assemble one
from the parts it does provide.

Everything below imports from `../../src/...`-style relative paths in the samples, because the
package's `exports` map makes these symbols unreachable by specifier — see
[02-configuration.md](02-configuration.md#why-the-blocks-above-are-not-compile-verified). The
blocks on this page are therefore illustrative rather than compile-verified.

## The generic shape

A generic CRUD controller serves every registered model through one set of routes:

```
GET    /collection/:model                    list
GET    /collection/:model/:id                one
GET    /collection/:model/:id/:relation      a relation's members
POST   /collection/:model                    create
PATCH  /collection/:model/:id                update
DELETE /collection/:model/:id                delete
```

Three pieces make `:model` work:

- **`FindModelType`** — a policy that rejects an unknown model name before the route runs.
- **`ModelType()`** — a route argument that resolves the URL segment to the model **class**.
- **`Crud`** — a base controller with a helper for the relation routes.

## `FindModelType`

A `@Singleton` `BasePolicy`, always enabled, that validates `req.params.model`.

```ts
@Singleton()
export class FindModelType extends BasePolicy {
  isEnabled(): boolean { return true; }

  execute(req: sRequest): Promise<void> {
    if (!req.params) throw new InvalidOperation('Invalid query parameters');
    if (!req.params.model) throw new InvalidOperation(`Invalid query parameters, 'model' is required`);

    const model = Array.isArray(req.params.model) ? req.params.model[0] : req.params.model;
    const mClass = this.Orm.Models.find((x) => x.name.toLowerCase() === model.trim().toLowerCase());
    if (!mClass) throw new InvalidOperation(`Resource type ${req.params.model} was not found`);

    return Promise.resolve();
  }
}
```

Matching is **case-insensitive and trimmed** against the model **class** name — not the table
name. So `Article` is reachable as `/collection/article`.

## `ModelType()`

Resolves the segment to the model constructor and injects it.

```ts
export function ModelType() {
  return Route(Parameter('ModelTypeRouteArgs'));
}
```

It performs the same lookup as the policy, but **without** a guard: `.find(...)!.type` throws a
`TypeError` on an unknown name. Always pair it with `@Policy(FindModelType)`, which turns that
into a clean error first.

## `Crud`

An abstract `BaseController` with one helper:

```ts
protected prepareQuery(
  model: IModelStatic,
  relation: string,
  id: any,
  callback: (this: SelectQueryBuilder<...>, relation: IOrmRelation) => void,
)
```

It builds `model.query().where(<single key column>, id).populate(relation, callback)` and returns
`{ relation, relationModel, query }` — the relation descriptor, the target model's descriptor, and
the builder.

The key column comes from `_assertSingleColumnKey`, so a composite-key model produces a
`BadRequest` rather than a half-filtered query.

## A worked controller

```ts
import { Autoinject, DI } from '@spinajs/di';
import { BaseController, BasePath, Get, Post, Patch, Del, Ok, Param, Body, Query, Policy } from '@spinajs/http';
import { ModelBase, IModelStatic, SortOrder } from '@spinajs/orm';
import { Crud, CollectionApiTransformer, _assertSingleColumnKey } from '../../src/interfaces.js';
import { ModelType } from '../../src/route-args/ModelType.js';
import { FindModelType } from '../../src/policies/FindModelType.js';
import { QueryArgs } from '../../src/dto/QueryArgs.js';
import { QueryIncludes } from '../../src/dto/QueryIncludes.js';

@BasePath('collection')
@Policy(FindModelType)
export class Collection extends Crud {
  @Autoinject(CollectionApiTransformer)
  protected Transformer: CollectionApiTransformer;

  /** GET /collection/:model */
  @Get(':model')
  public async list(@ModelType() model: IModelStatic, @Query() args: QueryArgs, @Query() includes: QueryIncludes) {
    const perPage = args?.perPage && args.perPage > 0 ? args.perPage : 25;
    const page = args?.page ?? 0;

    const query = model.query().select('*');

    if (includes) {
      query.populate(includes as {});
    }

    // Clone BEFORE paging: a builder executes at most once, and count() clears columns.
    const totalCount = await (query.clone() as any).selectCount();

    query.take(perPage).skip(page * perPage);

    if (args?.order) {
      query.order(args.order, args.orderDirection ?? SortOrder.ASC);
    }

    const data = (await query) as ModelBase[];

    return new Ok(this.Transformer.transform(data, { model: model as any, totalCount, currentPage: page, perPage }));
  }

  /** GET /collection/:model/:id */
  @Get(':model/:id')
  public async one(@ModelType() model: IModelStatic, @Param() id: string, @Query() includes: QueryIncludes) {
    const descriptor = model.getModelDescriptor();
    const query = model.query().select('*').where(_assertSingleColumnKey(descriptor), id);

    if (includes) {
      query.populate(includes as {});
    }

    const entity = await query.firstOrFail();

    return new Ok(this.Transformer.transform(entity as ModelBase, { model: model as any }));
  }

  /** GET /collection/:model/:id/:relation */
  @Get(':model/:id/:relation')
  public async relation(@ModelType() model: IModelStatic, @Param() id: string, @Param() relation: string) {
    const { query, relation: descriptor } = this.prepareQuery(model, relation, id, function () {});

    const owner = (await query.firstOrFail()) as any;
    const members = owner[descriptor.Name];

    return new Ok(this.Transformer.transform([...members], { model: descriptor.TargetModel as any }));
  }

  /** POST /collection/:model */
  @Post(':model')
  public async create(@ModelType() model: IModelStatic, @Body() body: any) {
    const entity = new (model as any)() as ModelBase;
    entity.hydrate(body);
    await entity.insert();

    return new Ok(this.Transformer.transform(entity, { model: model as any }));
  }

  /** PATCH /collection/:model/:id */
  @Patch(':model/:id')
  public async update(@ModelType() model: IModelStatic, @Param() id: string, @Body() body: any) {
    const descriptor = model.getModelDescriptor();
    const entity = (await model.query().select('*').where(_assertSingleColumnKey(descriptor), id).firstOrFail()) as ModelBase;

    entity.hydrate(body);
    await entity.update();

    return new Ok(this.Transformer.transform(entity, { model: model as any }));
  }

  /** DELETE /collection/:model/:id */
  @Del(':model/:id')
  public async remove(@ModelType() model: IModelStatic, @Param() id: string) {
    const descriptor = model.getModelDescriptor();
    const entity = (await model.query().select('*').where(_assertSingleColumnKey(descriptor), id).firstOrFail()) as ModelBase;

    // Honours @SoftDelete automatically.
    await entity.destroy();

    return new Ok();
  }
}
```

## Things to get right

**Authorisation.** A generic controller exposes every registered model, including internal ones.
Put a policy in front of it, or maintain an allow-list of model names. `@spinajs/rbac-http`'s
`RbacPolicy` is the intended companion — the package's own test fixtures stub it out.

**Clone before counting.** A builder executes at most once, so awaiting it for the count and
again for the page returns the memoized first result. `count()` also clears the column list.
Clone first.

**Mass assignment.** `entity.hydrate(body)` writes every matching column, including ones the
caller should not control. Filter the body, or use `@Ignore()` and `@Hidden()` on the model.

**Composite keys.** Route them through `_assertSingleColumnKey` so they fail with a `400` rather
than a wrong query.

**Includes are attacker-controlled.** `QueryIncludes` turns `?includes=a.b.c` into a nested
populate. A deep chain is a lot of queries; bound the depth if the endpoint is public.

## Saving a graph instead

For create and update, `save()` persists the whole reachable graph in one transaction, and its
`Populated` rule means an unpopulated relation is left alone. See
[the unit-of-work docs](../../orm/docs/08-unit-of-work.md).

```ts
const entity = new (model as any)() as ModelBase;
entity.hydrate(body);
const result = await entity.save();   // { Inserted, Updated, Deleted, ... }
```
