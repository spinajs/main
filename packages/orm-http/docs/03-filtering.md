# Filtering

A declarative filtering layer: the model declares which columns are filterable and with which
operators, and the route argument validates an incoming filter against a JSON schema generated
from those declarations. A client cannot filter on a column you did not open up, nor with an
operator you did not allow.

## Declaring filterable columns

```ts sample
import { Connection, Model, ModelBase, Primary, BelongsTo, SingleRelation } from '@spinajs/orm';
import { Filterable } from '@spinajs/orm-http';

@Connection('default')
@Model('authors')
export class Author extends ModelBase<Author> {
  @Primary()
  public Id: number;

  @Filterable(['eq', 'like'])
  public Name: string;
}

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public author_id: number;

  @Filterable(['eq', 'like', 'b-like', 'e-like'])
  public Title: string;

  @Filterable(['eq', 'gt', 'gte', 'lt', 'lte', 'between'])
  public Views: number;

  @Filterable(['isnull', 'notnull'])
  public PublishedAt: string;

  /**
   * Passing a MODEL instead of an operator list imports that model's filterable
   * columns under this property's name — `Author.Name` becomes filterable here.
   */
  @Filterable(Author)
  @BelongsTo(Author, 'author_id', 'Id')
  public Author: SingleRelation<Author>;
}
```

`@Filterable` also touches the column descriptor: it creates a `Virtual` column entry when the
property has none, and sets `Aggregate` from the third argument.

```ts
Filterable(
  operatorsOrClass: FilterableOperators[] | Constructor<ModelBase>,
  queryFunc?: (operator: FilterableOperators, value: any) => WhereFunction<unknown>,
  isAggregate?: boolean,
)
```

Passing a model whose own filterable columns are empty contributes nothing — declare
`@Filterable` on the related model's columns first.

## Operators

| Operator | SQL |
| --- | --- |
| `eq` | `= ?` |
| `neq` | `!= ?` |
| `gt` / `gte` / `lt` / `lte` | `> ?` / `>= ?` / `< ?` / `<= ?` |
| `like` | `LIKE '%value%'` |
| `b-like` | `LIKE '%value'` — *begins* the wildcard, i.e. matches at the end |
| `e-like` | `LIKE 'value%'` — matches at the start |
| `regexp` | `REGEXP ?` |
| `between` / `notbetween` | `BETWEEN` / `NOT BETWEEN` |
| `isnull` / `notnull` | `IS NULL` / `IS NOT NULL` |
| `in` / `nin` | `IN (...)` / `NOT IN (...)` |
| `in-set` / `nin-set` | `FIND_IN_SET` membership |
| `exists` / `n-exists` | `EXISTS` / `NOT EXISTS` on a relation |

Value validation per operator:

| Operators | Requirement |
| --- | --- |
| `in`, `nin`, `in-set`, `nin-set` | An array with at least one value. |
| `between`, `notbetween` | An array with at least two values. |
| `like`, `b-like`, `e-like`, `regexp` | A non-empty string (`null`/`undefined` skip the check). |
| `eq`, `neq`, `gt`, `gte`, `lt`, `lte` | A defined value. |
| `isnull`, `notnull`, `exists`, `n-exists` | No value needed. |

## The `@Filter()` route argument

```ts sample
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { Filter, Filterable, IFilterRequest } from '@spinajs/orm-http';

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
  /** Derive the allowed filters from the model. */
  @Get()
  public async list(@Filter(Article) filter: IFilterRequest) {
    const rows = await Article.select().filter(filter.filters, filter.op);
    return new Ok(rows.map((r) => r.dehydrate()));
  }

  /** Or spell the allowed columns out inline. */
  @Get('custom')
  public async custom(
    @Filter([
      { column: 'Title', operators: ['eq', 'like'] },
      { column: 'Views', operators: ['gt'] },
    ])
    filter: IFilterRequest,
  ) {
    const rows = await Article.select().filter(filter.filters, filter.op);
    return new Ok(rows.map((r) => r.dehydrate()));
  }
}
```

The value is read from `req.query[paramName]` first, then `req.body[paramName]`. A string is
`JSON.parse`d; malformed JSON becomes an `InvalidArgument` (a client error), not an unhandled
500.

The schema is built at **request** time, not decoration time — the `filterSchema()` static is
installed by `OrmHttpBootstrapper` when the ORM resolves, which is after controllers are
constructed.

## Request shape

```json
{
  "op": "and",
  "filters": [
    { "Column": "Title", "Operator": "like", "Value": "typescript" },
    { "Column": "Views", "Operator": "gt", "Value": 100 }
  ]
}
```

As a query string:

```
GET /articles?filter=%7B%22op%22%3A%22and%22%2C%22filters%22%3A%5B%7B%22Column%22%3A%22Title%22%2C%22Operator%22%3A%22like%22%2C%22Value%22%3A%22ts%22%7D%5D%7D
```

`op` is `and` or `or` (`FilterableLogicalOperators`); anything other than `or` is treated as
`and`. Note the field names are **capitalised** — `Column`, `Operator`, `Value`.

## The generated schema

`Model.filterSchema()` produces:

```json
{
  "type": "object",
  "properties": {
    "op": { "type": "string", "enum": ["and", "or"] },
    "filters": {
      "type": "array",
      "items": {
        "type": "object",
        "anyOf": [
          {
            "type": "object",
            "required": ["Column", "Operator"],
            "properties": {
              "Column": { "const": "Title" },
              "Value": { "type": ["string", "integer", "array", "boolean"] },
              "Operator": { "type": "string", "enum": ["eq", "like"] }
            }
          }
        ]
      }
    }
  }
}
```

`Value` is deliberately **not** required — the valueless operators (`isnull`, `notnull`,
`exists`, `n-exists`) carry none. A model with no `@Filterable` columns returns `{}`.

## Applying a filter

`SelectQueryBuilder.filter(filters, logicalOperator?, filterColumns?)` is installed on the
prototype at module load.

Every filter is wrapped in a single `andWhere(function () { ... })` group, so it composes with
conditions you added yourself rather than fighting them.

Before applying anything it checks: at most **100** filters; each entry is an object with a
`Column` and an `Operator`; the operator is known; the column is in the filterable list; and the
operator is allowed for that column. Any failure throws.

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { Filterable, IFilterRequest } from '@spinajs/orm-http';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Published: boolean;

  @Filterable(['eq', 'like'])
  public Title: string;
}

export async function combined(filter: IFilterRequest) {
  // The client's filter is one AND-group; our own condition sits alongside it.
  return await Article.select().where('Published', true).filter(filter.filters, filter.op).orderByDescending('Id').take(50);
}
```

## Filtering a relation

`filter()` is available on any select builder, including the one a `populate` callback receives.

```ts sample
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { Connection, Model, ModelBase, Primary, HasMany, Relation } from '@spinajs/orm';
import { Filter, Filterable, IFilterRequest } from '@spinajs/orm-http';

@Connection('default')
@Model('comments')
export class Comment extends ModelBase<Comment> {
  @Primary()
  public Id: number;

  public article_id: number;

  @Filterable(['eq', 'like'])
  public Body: string;
}

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  @HasMany(Comment, { foreignKey: 'article_id', primaryKey: 'Id' })
  public Comments: Relation<Comment, Article>;
}

@BasePath('articles')
export class RelationFilterController extends BaseController {
  @Get('with-comments')
  public async list(@Filter(Comment) filter: IFilterRequest) {
    const rows = await Article.select().populate('Comments', function () {
      this.filter(filter.filters, filter.op);
    });

    return new Ok(rows.map((r) => r.dehydrateWithRelations()));
  }
}
```

## A custom query per column

`@Filterable`'s second argument replaces the generated predicate entirely — for computed
columns, or a column whose filter should span several database columns.

```ts sample
import { Connection, Model, ModelBase, Primary, WhereFunction } from '@spinajs/orm';
import { Filterable, FilterableOperators } from '@spinajs/orm-http';

@Connection('default')
@Model('people')
export class Person extends ModelBase<Person> {
  @Primary()
  public Id: number;

  public FirstName: string;

  public LastName: string;

  /**
   * A virtual column: filtering `FullName` searches both real name columns.
   * The callback receives the operator and the value, and returns a where function.
   */
  @Filterable(['like'], (_operator: FilterableOperators, value: any): WhereFunction<unknown> => {
    return function () {
      this.where('FirstName', 'like', `%${value}%`).orWhere('LastName', 'like', `%${value}%`);
    };
  })
  public FullName: string;
}
```

When a column declares a custom query, validation of the value is skipped — the callback owns it.

## Inspecting what is filterable

```ts sample
import { Connection, Model, ModelBase, Primary } from '@spinajs/orm';
import { Filterable } from '@spinajs/orm-http';

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  @Filterable(['eq', 'like'])
  public Title: string;
}

export function describe() {
  return {
    // [{ column: 'Title', operators: ['eq', 'like'], query: undefined }]
    columns: (Article as any).filterColumns(),
    schema: (Article as any).filterSchema(),
  };
}
```

Both are useful for generating client-side filter UIs, and `filterSchema()` is what
`http-swagger` documents the endpoint with.
