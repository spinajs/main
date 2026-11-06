# Typed queries

The query builder knows the columns of the model it queries. Loose mode, the default, suggests column names in the editor and accepts any string. Strict mode, which is opt-in per package, rejects unknown columns and values of the wrong type at compile time.

## Turn on strict mode

Add one file to your package's `src/`, for example `src/orm-strict.d.ts`:

```ts
export {};

declare module '@spinajs/orm' {
  interface OrmTypeRegistry {
    strictColumns: true;
  }
}
```

It is a declaration file, so `tsc` never copies it to `lib/`. Your package's consumers keep their own mode. The setting applies to every file of the TypeScript program that contains it: `tsconfig.build.json` (the build), and `tsconfig.json` (the editor and eslint, including your tests).

## What strict mode checks

| Call | Accepted column | Value |
| --- | --- | --- |
| `where`, `orWhere`, `andWhere` | a column of the model, a relation (`where('Owner', 5)` compares its foreign key), `Relation.column`, `col(...)` | the column's TS type, an array of it, `null` or a `RawQuery`; a `DateTime` column also takes a `Date` |
| `whereIn`, `whereNull`, `whereBetween`, `whereColumn`, ... | a column, `table.column`, `col(...)`, a `Wrap` where it was accepted before | unchecked |
| `select`, `columns`, `orderBy`, `order`, `groupBy`, `min`, `max`, `count`, `sum`, `avg`, `increment` | a column, `table.column`, `col(...)` | n/a |

A column is a property the model class declares that is not a function or a relation. Members of `ModelBase` (`PrimaryKeyValue`, `IsDirty`, ...) are not columns. A builder without a model (`driver.select()`, `ISelectQueryBuilder<any>`), and a model that declares no columns, accept any name in both modes.

## `col()`: columns the type cannot see

`col('name')` passes a name through unchecked. Use it for a column the model does not declare (one another package added to the table), a name computed at runtime, or a column of a joined table you do not qualify.

```ts
import { col } from '@spinajs/orm';

await User.query().where(col('EmailVerifiedAt'), null);
```

Prefer declaring the column on the model when the model owns it.

## Result types

### `populate()` (both modes)

`populate('Relation')` with a literal relation name narrows the result: a to-one relation has `Populated: true` and a `Value` typed as the related model, and a to-many relation has `Populated: true`. `populate('a.b')` narrows `a`. The callback's `this` is a query on the related model.

How far `Value` narrows depends on how the model declares the relation. A required property (`Team: SingleRelation<Team>`) says the model guarantees the row, so `Value` is `Team`. An optional property (`Owner?: SingleRelation<User>`), or one typed `SingleRelation<User> | undefined` or `| null`, allows a missing row, and a missing row leaves `Value` undefined (the LEFT JOIN finds nothing), so `Value` is `User | undefined`.

```ts
const user = await User.where('Id', 1).populate('Team').populate('Owner').first();
user.Team.Value.Name; // Team, not Team | null | undefined
user.Owner.Value?.Name; // User | undefined: the row may be missing
```

The narrowing only adds to the type, so code that compiled before still compiles. A relation name held in a `string`, an array, an object or a model class populates as before, without narrowing.

In strict mode every relation name is checked: a literal, each element of an array and each key of the object form must be a relation of the model. For `'Relation.nested'`, only the first segment is checked. A name computed at runtime goes through `rel(name)`:

```ts
import { rel } from '@spinajs/orm';

await User.query().populate(include.map(rel));
```

### Projections and aggregates (strict mode)

In strict mode the row type follows the select list:

| Call | Row |
| --- | --- |
| `select('Id')` | `{ Id }`; further `select(...)` calls add to it |
| `select('Email', 'Mail')` | adds `{ Mail: string }` |
| `columns(['Id', 'Email'])` | `{ Id, Email }`, replacing earlier selects |
| `count()`, `count('Id')` | `{ count: AggregateValue }`, replacing the select list |
| `count('Id', 'total')` | `{ total: AggregateValue }` |
| `min/max('Id', 'top')` | adds `{ top: <column type> \| null }`; a `DateTime` or `Date` column gives `Date \| string \| number \| null` |
| `sum/avg('Id', 's')` | adds `{ s: AggregateValue \| null }` |
| `select('*')`, `select(raw)`, an aggregate without alias, an alias held in a `string` | unchanged |

`AggregateValue` is `number | string`: postgres returns COUNT, and SUM/AVG of exact numbers, as strings, and no converter runs on an alias. Convert it with `Number(...)` where you need a number. For the same reason `min`/`max` of a date column return the driver's raw value, not a luxon `DateTime`. `MIN`, `MAX`, `SUM` and `AVG` over zero rows return `NULL`, so their aliases include `null`; `COUNT` never does.

`where`, `orderBy` and the rest keep accepting every column of the model after a projection. Loose mode never narrows a projection, because loose code reads unselected fields of hydrated models.

## Important behaviour

- Loose mode changes nothing at runtime and rejects nothing that compiled before.
- Strict mode is types only: the same SQL runs either way.
- A non-literal string column (`where(name, value)` with `name: string`) is an error in strict mode. Type the variable as a union of the columns it can hold, or use `col(name)`.
- Strict projection: call a query scope declared with `this: ISelectQueryBuilder<Model[]>` **before** `select`, `columns` or an aggregate, because the projected builder no longer is an `ISelectQueryBuilder<Model[]>`.
- Call query scopes **before** `populate()`. A scope declared with `this: ISelectQueryBuilder<Model[]>` after a populate makes TypeScript compare the narrowed builder with the whole `ISelectQueryBuilder<Model[]>`: about 20,000 type instantiations per model and relation set, against about 1,000 the other way round.
- Strict projection: an exported function that returns a projected builder or row needs an explicit return type. Declaration files keep the narrowing types unevaluated, and a loose consumer would read them as the full model.
