# Route arguments

## `@FromModel(options?)` — load from the database

Reads a value from the request, queries the model, and injects the row. A miss throws
`OrmNotFoundException`, which `OrmNotFound` renders as `404`.

```ts sample
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { FromModel } from '@spinajs/orm-http';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Title: string;

  public Slug: string;
}

@BasePath('articles')
export class ArticleController extends BaseController {
  /**
   * GET /articles/:article
   *
   * The parameter NAME is the route parameter read by default — `:article` here.
   */
  @Get(':article')
  public byId(@FromModel() article: Article) {
    return new Ok(article.dehydrate());
  }
}
```

### `FromModelOptions`

| Option | Default | Meaning |
| --- | --- | --- |
| `paramField` | the parameter's name | Which request field holds the value. |
| `paramType` | `FromParams` | Where to read it: `FromParams`, `FromQuery`, `FromBody`, `FromHeader`. |
| `queryField` | the model's primary key | Which **column** to filter on. |
| `include` | — | Relations always populated, regardless of the request. |
| `noInclude` | `false` | Ignore `include` / `_include` from the request. |
| `query` | — | Replace the whole default query. |

Header names are lowercased before lookup.

```ts sample
import { BaseController, BasePath, Get, Ok, ParameterType } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { FromModel } from '@spinajs/orm-http';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Slug: string;

  public Title: string;
}

@BasePath('articles')
export class ArticleController extends BaseController {
  /** GET /articles/by-slug/:slug — look the row up by a natural key. */
  @Get('by-slug/:slug')
  public bySlug(@FromModel<typeof Article>({ paramField: 'slug', queryField: 'Slug' }) article: Article) {
    return new Ok(article.dehydrate());
  }

  /** GET /articles/current?id=123 */
  @Get('current')
  public fromQuery(@FromModel<typeof Article>({ paramField: 'id', paramType: ParameterType.FromQuery }) article: Article) {
    return new Ok(article.dehydrate());
  }

  /** Always populate a relation, and ignore whatever `include` the caller asked for. */
  @Get('fixed/:article')
  public fixedIncludes(@FromModel<typeof Article>({ include: ['Author'], noInclude: true }) article: Article) {
    return new Ok(article.dehydrateWithRelations());
  }
}
```

### The default query

With no `query` callback, `fromDbModelDefaultQueryFunction` builds:

1. `SELECT *` from the model's table, aliased `$<table>$`.
2. `WHERE <queryField> = <value>`.
3. **Parent scoping.** For every `belongsTo` relation, if a route parameter shares its name
   (case-insensitively, optionally `_`-prefixed), the relation's foreign key is constrained to
   that parameter. A matching parameter with no value throws
   `no key for relation X was provided`.
4. `populate(options.include)` when given.
5. Unless `noInclude`, `populate(...)` of the request's `include` or `_include` query argument.
6. `firstOrThrow(new OrmNotFoundException('Resource not found'))`.

Step 3 is what makes nested resources work without writing the join:

```ts sample
import { BaseController, BasePath, Get, Ok, Param } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary, BelongsTo, SingleRelation } from '@spinajs/orm';
import { FromModel } from '@spinajs/orm-http';

@Connection('default')
@Model('authors')
export class Author extends ModelBase<Author> {
  @Primary()
  public Id: number;

  public Name: string;
}

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public author_id: number;

  public Title: string;

  @BelongsTo(Author, 'author_id', 'Id')
  public Author: SingleRelation<Author>;
}

@BasePath('authors')
export class NestedController extends BaseController {
  /**
   * GET /authors/:author/articles/:article
   *
   * `:author` matches the `Author` relation by name, so the query is automatically
   * constrained to `author_id = :author` — an article belonging to a different
   * author 404s instead of leaking.
   */
  @Get(':author/articles/:article')
  public one(@Param() _author: number, @FromModel() article: Article) {
    return new Ok(article.dehydrate());
  }
}
```

### Composite primary keys

A route parameter carries one value. Without `queryField`, a model whose key has more than one
column throws a `BadRequest`:

```
model X has a composite primary key (A, B); pass queryField to select a single lookup column
```

### A custom query

`query` replaces the default entirely. `this` is the model's select builder; the arguments are
the route's arguments and the extracted value.

```ts sample
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary, SelectQueryBuilder } from '@spinajs/orm';
import { FromModel } from '@spinajs/orm-http';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Slug: string;

  public Published: boolean;
}

@BasePath('articles')
export class CustomQueryController extends BaseController {
  @Get('published/:slug')
  public published(
    @FromModel<typeof Article>({
      paramField: 'slug',
      query: function (this: SelectQueryBuilder<typeof Article>, _routeParams: any, value: any) {
        return (this as unknown as SelectQueryBuilder<Article>).select('*').where('Slug', value).andWhere('Published', true) as SelectQueryBuilder;
      },
    })
    article: Article,
  ) {
    return new Ok(article.dehydrate());
  }
}
```

The callback's result is awaited through `firstOrThrow(new OrmNotFoundException('Resource not
found'))`, so it should return a builder, not a promise.

## `@AsModel(field?, type?)` — build without loading

Constructs a model from the request body and hydrates it. It **does not** query the database and
**does not** save. Effectively a typed `@Body()` that produces a model instance.

```ts sample
import { BaseController, BasePath, Post, Ok, Patch } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { AsModel, FromModel } from '@spinajs/orm-http';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Title: string;

  public Body: string;
}

@BasePath('articles')
export class WriteController extends BaseController {
  @Post()
  public async create(@AsModel() article: Article) {
    await article.insert();
    return new Ok(article.dehydrate());
  }

  /** Load the existing row, then patch it from the body. */
  @Patch(':article')
  public async update(@FromModel() article: Article, @AsModel('patch') patch: Article) {
    article.hydrate(patch.dehydrate({ ignoreNullable: true }) as Partial<Article>);
    await article.update();
    return new Ok(article.dehydrate());
  }
}
```

Which part of the body is used:

- `req.body[param.Name]` when that key exists;
- otherwise the **whole body**, but only when the route has exactly one `AsDbModel` parameter;
- otherwise `null`.

An empty body throws `BadRequest('Request body empty, cannot hydrate model for parameter ...')`.

## `DbModelHydrator`

Registered as the `custom:arg_hydrator` for every model by `OrmHttpBootstrapper`. It constructs
the model and hydrates it from the incoming value, which is what makes a plain `@Body()` typed as
a model work:

```ts sample
import { BaseController, BasePath, Post, Ok, Body } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Title: string;
}

@BasePath('articles')
export class BodyController extends BaseController {
  /** `article` arrives as a hydrated Article, not a plain object. */
  @Post()
  public async create(@Body() article: Article) {
    await article.insert();
    return new Ok({ Id: article.Id });
  }
}
```

A `null` input throws `OrmException('primary key cannot be null')`.

## Choosing between them

| Need | Use |
| --- | --- |
| An existing row, 404 when absent | `@FromModel()` |
| A new unsaved instance from the body | `@AsModel()` or `@Body()` |
| A row plus a patch | Both — `@FromModel()` for the row, `@AsModel('patch')` for the changes |
| A row by natural key | `@FromModel({ queryField: 'Slug' })` |
| A row scoped to its parent | `@FromModel()` with the parent's relation name as a route parameter |
