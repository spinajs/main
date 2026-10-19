# Custom filter columns

A filter column can carry its own SQL: `IColumnFilter.query` receives the client's operator and value and returns a `WhereFunction`. Use it for computed columns, searches across several columns, subqueries and relation lookups. Column sets can also live outside the model, for models you cannot or do not want to decorate.

## How it works

1. Declare the column with `@Filterable(operators, queryFunc)` on the model, or as `{ column, operators, query }` in an `IColumnFilter[]` list.
2. The schema still limits the column to `operators`. The query function never sees an operator outside that list.
3. `SelectQueryBuilder.filter()` checks the column and operator as for any column.
4. It calls `query(operator, value)` and invokes the returned `WhereFunction` with the current group builder as `this`.
5. The built-in operator and its value check are skipped: the function owns both.

## Decorators

| Decorator | Target | Options | Effect |
| --- | --- | --- | --- |
| `@Filterable(operators, queryFunc, isAggregate?)` | Model property | `queryFunc: (operator: FilterableOperators, value: any) => WhereFunction<unknown>`, or `null` to keep the built-in SQL | The column is filtered by `queryFunc`. A property with no column gets a virtual one. |
| `@Filter(columns)` | Route method parameter | `IColumnFilter[]` | Validates against those columns instead of a model's. |

`IColumnFilter<T>`:

| Field | Type | Meaning |
| --- | --- | --- |
| `column` | `string?` | Column name the client sends as `Column`. |
| `operators` | `FilterableOperators[]` | Operators the schema allows. |
| `query` | `((operator, value) => WhereFunction<T>) \| null` | Custom SQL; absent or `null` uses the built-in operator. |

## Services and extension points

| Service | DI token and lifetime | Default implementation | Alternatives | How to replace or extend |
| --- | --- | --- | --- | --- |
| Per-column SQL | `IColumnFilter.query`, a plain function, no DI | built-in operator map in `builders.ts` | any function returning a `WhereFunction` | Pass it to `@Filterable()` or put it in an `IColumnFilter` list. |
| Column set | `IModelDescriptor.FilterableColumns` (from `@Filterable`), or an `IColumnFilter[]` you pass | the model's `filterColumns()` | inline lists | Pass the list to `@Filter(list)` and `.filter(filters, op, list)`. |

### IColumnFilter.query: search two name columns as one

The function runs per request, so it can read the value, translate the operator and build any condition the query builder supports.

```ts sample
import { Connection, Model, ModelBase, Primary, SqlOperator, WhereFunction } from '@spinajs/orm';
import { Filterable, FilterableOperators } from '@spinajs/orm-http';

@Connection('default')
@Model('people')
export class Person extends ModelBase<Person> {
  @Primary()
  public Id: number;

  public FirstName: string;

  public LastName: string;

  /** Virtual column: no FullName in the table; filtering it searches both name columns. */
  @Filterable(['eq', 'like'], (operator: FilterableOperators, value: any): WhereFunction<unknown> => {
    // `operator` is the client's vocabulary ('eq', 'like'), not SQL: translate it.
    const sqlOperator = operator === 'like' ? SqlOperator.LIKE : SqlOperator.EQ;
    const sqlValue = operator === 'like' ? `%${value}%` : value;

    return function () {
      this.where(function () {
        this.where('FirstName', sqlOperator, sqlValue).orWhere('LastName', sqlOperator, sqlValue);
      });
    };
  })
  public FullName: string;
}
```

## Important behaviour

- The operator passed to `query` is a `FilterableOperators` value (`eq`, `like`, `b-like`...). Passing it straight to `where()` fails for `eq`, `neq`, `b-like`, `e-like` and the others that are not SQL.
- No value check runs for a custom column. Validate `value` yourself and throw `InvalidArgument` for a `400`.
- The function's conditions form one bracketed condition, joined to the other entries at the same level by that level's `op`, like a built-in column.
- Wrap several conditions in one `this.where(function () { ... })` so an `orWhere` inside does not leak into the surrounding group.
- `filterColumns()` returns `query` with each column, so a column set built from it keeps the custom SQL.

## Best practices

- Keep inline column lists in one constant and pass it to both `@Filter(list)` and `.filter(..., list)`.
- Use an inline list when the model lives in a package that must not depend on `@spinajs/orm-http`.
- Prefer an `exists` subquery over a join in `query`: the outer row count stays the same and paging stays correct.

## Patterns and antipatterns

```ts
// Don't: pass the client's operator to where(); 'eq' is not an SQL operator
query: (operator, value) => function () { this.where('Value', operator, value); }

// Do: translate it
query: (operator, value) => function () {
  this.where('Value', operator === 'neq' ? SqlOperator.NOT : SqlOperator.EQ, value);
}
```

## Examples

### Filter articles by tag name through a relation

```ts sample
import { BaseController, BasePath, Get, Ok } from '@spinajs/http';
import { Connection, HasMany, Model, ModelBase, Primary, Relation, SqlOperator } from '@spinajs/orm';
import { InvalidArgument } from '@spinajs/exceptions';
import { Filter, FilterableOperators, IColumnFilter, IFilterRequest } from '@spinajs/orm-http';

@Connection('default')
@Model('article_tags')
export class ArticleTag extends ModelBase<ArticleTag> {
  @Primary()
  public Id: number;

  public article_id: number;

  public Name: string;
}

@Connection('default')
@Model('articles')
export class Article extends ModelBase<Article> {
  @Primary()
  public Id: number;

  public Title: string;

  @HasMany(ArticleTag, { foreignKey: 'article_id', primaryKey: 'Id' })
  public Tags: Relation<ArticleTag, Article>;
}

/** Declared next to the controller: the Article model stays free of orm-http. */
const ARTICLE_FILTER: IColumnFilter<Article>[] = [
  { column: 'Title', operators: ['eq', 'like'] },
  {
    column: 'Tag',
    operators: ['eq', 'neq'],
    query: (operator: FilterableOperators, value: any) => {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InvalidArgument('The Tag filter needs a tag name', 'Tag');
      }

      return function () {
        const tagged = function (this: any) {
          this.where('Name', SqlOperator.EQ, value);
        };

        if (operator === 'neq') {
          this.whereNotExists('Tags', tagged);
        } else {
          this.whereExist('Tags', tagged);
        }
      };
    },
  },
];

@BasePath('articles')
export class TaggedArticleController extends BaseController {
  /** GET /articles?filter={"filters":[{"Column":"Tag","Operator":"eq","Value":"orm"}]} */
  @Get()
  public async list(@Filter(ARTICLE_FILTER) filter: IFilterRequest) {
    const rows = await Article.select().filter(filter?.filters, filter?.op, ARTICLE_FILTER);
    return new Ok(rows.map((r) => r.dehydrate()));
  }
}
```

### OR a custom SQL column with a plain one

```ts sample
import { Connection, Model, ModelBase, Primary, SqlOperator } from '@spinajs/orm';
import { Filterable, FilterableLogicalOperators } from '@spinajs/orm-http';

@Connection('default')
@Model('people')
export class Person extends ModelBase<Person> {
  @Primary()
  public Id: number;

  @Filterable(['eq'])
  public City: string;

  public FirstName: string;

  public LastName: string;

  @Filterable(['like'], (_operator, value) => function () {
    this.where(function () {
      this.where('FirstName', SqlOperator.LIKE, `%${value}%`).orWhere('LastName', SqlOperator.LIKE, `%${value}%`);
    });
  })
  public FullName: string;
}

/** City = city OR ( FirstName LIKE name OR LastName LIKE name ) */
export async function cityOrName(city: string, name: string) {
  return await Person.select().filter(
    [
      { Column: 'City', Operator: 'eq', Value: city },
      { Column: 'FullName', Operator: 'like', Value: name },
    ],
    FilterableLogicalOperators.Or,
  );
}
```

## Related

- [Filtering](03-filtering.md): the declaration, schema and application flow these columns plug into.
- [Query builder](../orm/05-query-builder.md): `where`, `whereExist`, `whereNotExists`, `whereIn` with a subquery.
- [Relations](../orm/06-relations.md): the relations `whereExist()` reads.
