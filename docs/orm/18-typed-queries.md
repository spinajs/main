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

## Important behaviour

- Loose mode changes nothing at runtime and rejects nothing that compiled before.
- Strict mode is types only: the same SQL runs either way.
- A non-literal string column (`where(name, value)` with `name: string`) is an error in strict mode. Type the variable as a union of the columns it can hold, or use `col(name)`.
