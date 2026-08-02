# Transformers and policies

## `CollectionApiTransformer`

The abstraction that shapes what a CRUD route returns, so the response format is a configuration
choice rather than something baked into each controller.

```ts
export abstract class CollectionApiTransformer {
  public abstract transform(data: ModelBase<unknown>[] | ModelBase<unknown>, options?: ITransformOptions): unknown;
}
```

It handles both a collection and a single model, so one implementation covers every route.

### `ITransformOptions`

| Field | Meaning |
| --- | --- |
| `model` | The model class. **Required.** |
| `totalCount` | Rows matching before paging. |
| `currentPage` | Zero-based page index. |
| `perPage` | Page size. |
| `order` | `SortOrder`. |
| `orderBy` | Column name. |

`model` is declared non-optional, but `PlainJsonCollectionTransformer` never reads it. A custom
transformer that needs the model descriptor — to emit a JSON:API `type`, say — does.

### `PlainJsonCollectionTransformer`

The default, registered as `@Injectable(CollectionApiTransformer)`.

```ts
@Injectable(CollectionApiTransformer)
export class PlainJsonCollectionTransformer extends CollectionApiTransformer {
  public transform(data: ModelBase<unknown> | ModelBase<unknown>[], options?: ITransformOptions): unknown {
    if (Array.isArray(data)) {
      return {
        Collection: data.map((x) => x.toJSON()),
        Count: options!.totalCount,
      };
    }

    return data.toJSON();
  }
}
```

A collection becomes `{ Collection, Count }`; a single model becomes its `toJSON()` — the
`dehydrate()` output, so `@Ignore()` and `@Hidden()` properties are already excluded.

Two things to note. `options!.totalCount` is dereferenced without a guard, so calling it for a
collection **without** options throws — always pass at least `{ model, totalCount }`. And
because it uses `toJSON()` rather than `dehydrateWithRelations()`, **populated relations do not
appear in the output**. A transformer that should include them needs to say so:

```ts
@Injectable(CollectionApiTransformer)
export class RelationAwareTransformer extends CollectionApiTransformer {
  public transform(data: ModelBase<unknown> | ModelBase<unknown>[], options?: ITransformOptions): unknown {
    if (Array.isArray(data)) {
      return {
        Data: data.map((x) => x.dehydrateWithRelations()),
        Meta: {
          Total: options?.totalCount ?? data.length,
          Page: options?.currentPage ?? 0,
          PerPage: options?.perPage ?? data.length,
        },
      };
    }

    return { Data: data.dehydrateWithRelations() };
  }
}
```

Remember that `dehydrateWithRelations` does **not** propagate `omit` into nested relations — the
recursive calls pass `omit: []`. Hidden fields on a related model must be declared on that
model with `@Hidden()` or `@Ignore()`.

### A JSON:API transformer

The `JsonApiCollectionTransformer` named in the bundled configuration does not exist in this
repository. The shape it would produce, from the commented-out controller:

```ts
@Injectable(CollectionApiTransformer)
export class JsonApiCollectionTransformer extends CollectionApiTransformer {
  public transform(data: ModelBase<unknown> | ModelBase<unknown>[], _options?: ITransformOptions): unknown {
    const one = (model: ModelBase) => ({
      type: model.constructor.name,
      id: model.PrimaryKeyValue,
      attributes: model.dehydrate(),
      relationships: _.mapValues(_.groupBy(model.getFlattenRelationModels(false), '__relationKey__'), (group) =>
        group.map((related) => ({ type: related.constructor.name, id: related.PrimaryKeyValue })),
      ),
    });

    return {
      data: Array.isArray(data) ? data.map(one) : one(data),
      included: Array.isArray(data) ? _.flatMap(data, (m) => m.getFlattenRelationModels(true).map(one)) : data.getFlattenRelationModels(true).map(one),
    };
  }
}
```

`__relationKey__` is set on related models by the ORM's `OneToManyRelationHydrator` and
`OneToOneRelationHydrator` — it names the relation a model arrived through, which is what makes
the `relationships` grouping possible.

### Selecting one

```ts
const service = configuration.get<string>('api.endpoint.transformer.service', 'PlainJsonCollectionTransformer');
const transformer = await DI.resolve<CollectionApiTransformer>(service);
```

Always pass a default — the bundled config's value (`JsonApiCollectionTransformer`) does not
resolve.

## `FindModelType`

A `@Singleton` `BasePolicy` that validates the `:model` segment before the route body runs.

```ts
@Singleton()
export class FindModelType extends BasePolicy {
  @Autoinject()
  protected Orm: Orm;

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

- `isEnabled()` is unconditionally `true` — it runs wherever it is attached.
- Matching is case-insensitive, trimmed, and against the **class** name, not the table name.
- An array-valued parameter takes its first element.
- Failures are `InvalidOperation`, whose status depends on your exception mapping — it is not a
  `404` by default.

**It authorises nothing.** It only answers "is this a real model". Every registered model,
including internal ones, passes. Pair it with an authorisation policy:

```ts
@BasePath('collection')
@Policy(RbacPolicy)
@Policy(FindModelType)
export class Collection extends Crud { /* ... */ }
```

Or keep an allow-list:

```ts
const PUBLIC_MODELS = new Set(['article', 'author', 'tag']);

@Singleton()
export class PublicModelsOnly extends BasePolicy {
  isEnabled(): boolean { return true; }

  execute(req: sRequest): Promise<void> {
    const name = String(req.params?.model ?? '').trim().toLowerCase();
    if (!PUBLIC_MODELS.has(name)) {
      throw new InvalidOperation(`Resource type ${req.params?.model} was not found`);
    }
    return Promise.resolve();
  }
}
```

Reusing the same "not found" message for a private model is deliberate: it avoids telling a
caller which internal models exist.

## `ModelTypeRouteArgs`

```ts
@Injectable()
export class ModelTypeRouteArgs extends RouteArgs {
  public get SupportedType(): string { return 'ModelTypeRouteArgs'; }

  public async extract(callData: IRouteCall, _args: unknown[], param: IRouteParameter, req: express.Request) {
    const rawParam = req.params[param.Name];
    const modelParam = Array.isArray(rawParam) ? rawParam[0] : rawParam;
    return Promise.resolve({
      CallData: callData,
      Args: this.Orm.Models.find((x) => x.name.toLowerCase() === modelParam.trim().toLowerCase())!.type,
    });
  }
}
```

Injected via the `ModelType()` decorator. It resolves the segment to the model **class**, so the
route receives something it can call statics on.

The `!` is load-bearing and unguarded: an unknown model name throws
`Cannot read properties of undefined (reading 'type')`, and `modelParam.trim()` throws on a
missing parameter. **`FindModelType` is what makes this safe** — attach it, always.

`param.Name` is the route parameter read, so `@ModelType() model: IModelStatic` on a
`':model'` route reads `:model`.

## Putting them together

```ts
@BasePath('collection')
@Policy(FindModelType)
export class Collection extends Crud {
  @Autoinject(CollectionApiTransformer)
  protected Transformer: CollectionApiTransformer;

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

See [03-building-a-crud-controller.md](03-building-a-crud-controller.md) for the full set of
routes.
