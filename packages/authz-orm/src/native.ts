import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import { RawQuery, SelectQueryBuilder, extractModelDescriptor } from '@spinajs/orm';
import type { IWhereBuilder, ModelBase } from '@spinajs/orm';

import { columnsOf } from './columns.js';
import { Identifier, NativeCorrelation, NativeSql, NativeWhereBuilder, OuterColumn, SqlFragment, assertTopLevelAnd, correlatedSubOf, markCorrelated, nativeRootOf } from './compile/native.js';
import { entryOf } from './registry.js';
import { keepBooleans, shield } from './shield.js';

// `@spinajs/authz-orm/native`: what an OrmNativeCompiler needs to test other tables (README, "Native compilers").
// A contract between L4 and L4b outside the API snapshot: change it only together with L4b.

export type { SqlFragment };

let seq = 0;

const rootOf = (builder: unknown, what: string): NativeWhereBuilder => {
  const root = nativeRootOf(builder);
  if (root !== undefined) return root;
  throw new AuthzConfigError(`authz-orm: ${what} takes the builder an OrmNativeCompiler is handed, a correlatedQuery sub-query or a where group nested in either`);
};

const subOf = (builder: unknown, what: string): SelectQueryBuilder => {
  const sub = correlatedSubOf(builder);
  if (sub !== undefined && nativeRootOf(sub) !== undefined) return sub;
  throw new AuthzConfigError(`authz-orm: ${what} takes a sub-query made by correlatedQuery, or a where group nested in one`);
};

const assertColumn = (model: unknown, column: string): void => {
  if (model !== undefined && !columnsOf(model as never).has(column)) throw new AuthzConfigError(`authz-orm: ${column} is not a column of ${(model as { name?: string }).name}`);
};

/** The sub-query's own where, ANDed after its correlations, also in its clones. */
function guardSub(sub: SelectQueryBuilder): SelectQueryBuilder {
  markCorrelated(sub);
  shield(sub, assertTopLevelAnd);
  const clone = sub.clone;
  Object.defineProperty(sub, 'clone', {
    configurable: true,
    writable: true,
    value: function (this: SelectQueryBuilder, ...args: unknown[]) {
      const copy = (clone as (...a: unknown[]) => SelectQueryBuilder).apply(this, args);
      keepBooleans(this, copy);
      return guardSub(copy);
    },
  });
  return sub;
}

/**
 * `SELECT 1 FROM <from>` under an alias of its own, for `whereExist(...)` or `whereNotExists(...)` on
 * `builder` (the native builder, a where group in it, or another correlatedQuery sub-query: subs nest),
 * correlated with the filtered row by `correlate`. `from` is a table name or a model class (whose
 * columns `where` then checks). Its where joins the correlations with AND, so an `orWhere` in it
 * cannot reach past them. authz does not scope it, as it does not scope the sub-queries of an
 * `@OrmScope` policy: read the principal from the `principal` argument.
 */
export function correlatedQuery(builder: IWhereBuilder<unknown>, from: string | Class<ModelBase>): SelectQueryBuilder {
  const root = rootOf(builder, 'correlatedQuery');
  const { driver } = root.site;
  const model = typeof from === 'string' ? undefined : from;
  const table = model === undefined ? from : extractModelDescriptor(model as never)?.TableName;
  if (typeof table !== 'string' || table === '') throw new AuthzConfigError(`authz-orm: correlatedQuery needs a table name or a model with a table, got ${String((from as { name?: string })?.name ?? from)}`);
  const sub = driver.Container.resolve<SelectQueryBuilder>(SelectQueryBuilder as never, [driver, model, undefined, false]);
  sub.setTable(table, `$authz_n${++seq}$`);
  sub.select(RawQuery.create('1'));
  sub.correlateWith(root);
  return guardSub(sub);
}

/**
 * `<sub>.<column> = <filtered row>.<outerColumn>` in `holder`: a correlatedQuery sub-query, or a where
 * group in one (`onPath`: an OR of groups, each with its own correlation). `outerColumn` must be a
 * column of the model the native op filters. Both names are read when the query compiles, so an alias
 * given later (`populate()`, `setAlias()`), clones and subs nested in subs always name the filtered
 * row. In a group the correlation is ANDed with the group's other conditions; a sub with no
 * correlation at its top level refuses an `orWhere` there.
 */
export function correlate<B extends IWhereBuilder<unknown>>(holder: B, column: string, outerColumn: string): B {
  const sub = subOf(holder, 'correlate');
  const root = rootOf(sub, 'correlate');
  assertColumn(root.site.model, outerColumn);
  assertColumn(sub.Model, column);
  NativeCorrelation.add(holder, column, outerColumn);
  return holder;
}

/** The filtered row's `column` in an `sql` fragment, qualified when the query compiles. */
export function outerColumn(builder: IWhereBuilder<unknown>, column: string): OuterColumn {
  assertColumn(rootOf(builder, 'outerColumn').site.model, column);
  return new OuterColumn(column);
}

/** A column of a correlatedQuery sub-query (its own alias) in an `sql` fragment. */
export function subColumn(sub: IWhereBuilder<unknown>, column: string): Identifier {
  const s = subOf(sub, 'subColumn');
  assertColumn(s.Model, column);
  return new Identifier([s.TableAlias, column]);
}

/** A table, alias or column name in an `sql` fragment, quoted by the dialect. */
export function identifier(...names: string[]): Identifier {
  if (names.length === 0 || names.some((n) => typeof n !== 'string' || n === '')) throw new AuthzConfigError('authz-orm: identifier takes non-empty names');
  return new Identifier(names);
}

/**
 * SQL text: `outerColumn`, `subColumn` and `identifier` render as names, another `sql` fragment
 * inline, and every other value as a bound parameter. Kleene-correct NULL handling is the
 * compiler's job (a `COALESCE` default, a `CASE` with an `ELSE`).
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  return new SqlFragment(strings, values);
}

/** Adds the fragment, parenthesised, as an AND condition of the native builder, a correlatedQuery sub-query or a where group in either. */
export function whereSql<B extends IWhereBuilder<unknown>>(holder: B, fragment: SqlFragment): B {
  rootOf(holder, 'whereSql');
  if (!(fragment instanceof SqlFragment)) throw new AuthzConfigError('authz-orm: whereSql takes a fragment made by sql`…`');
  const statement = new NativeSql(holder, fragment);
  (holder as unknown as { pushStatement(s: unknown): unknown }).pushStatement(statement);
  return holder;
}

/** The `@ScopeColumn`s of a registered model (DB column and scope type), nearest ancestor first, in declaration order. */
export function scopeColumnsOf(model: Class<ModelBase>): readonly { readonly column: string; readonly scopeType: ResourceType }[] {
  const entry = entryOf(model);
  if (entry === undefined) throw new AuthzConfigError(`authz-orm: ${model.name} is not an @AccessResource model`);
  return entry.scopeColumns.map((s) => ({ column: s.column, scopeType: s.scopeType }));
}
