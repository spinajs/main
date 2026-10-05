import { AuthzConfigError } from '@spinajs/authz';
import type { ResourceType } from '@spinajs/authz';
import type { Class } from '@spinajs/di';
import { RawQuery, SelectQueryBuilder, extractModelDescriptor } from '@spinajs/orm';
import type { IQueryStatement, IQueryStatementResult, IWhereBuilder, ModelBase } from '@spinajs/orm';

import { columnOf, columnsOf, dialectOf, idMode } from './columns.js';
import type { IdMode } from './columns.js';
import { Identifier, NativeCorrelation, NativeSql, NativeWhereBuilder, OuterColumn, SqlFragment, assertCorrelationsHold, correlatedSubOf, markCorrelated, nativeRootOf } from './compile/native.js';
import { classesOf, entryOf, registeredClasses } from './registry.js';
import { pkOf } from './rows.js';
import { keepBooleans, shield } from './shield.js';

// `@spinajs/authz-orm/native`: what an OrmNativeCompiler needs to test other tables (README, "Native compilers").
// A contract between L4 and L4b outside the API snapshot: change it only together with L4b.

export type { IdMode, SqlFragment };

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
  shield(sub, assertCorrelationsHold);
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

/** Whether `builder` is the builder an OrmNativeCompiler is handed, a where group in it or a correlatedQuery sub-query of it. */
export function isNativeBuilder(builder: unknown): boolean {
  return nativeRootOf(builder) !== undefined;
}

/** `NativeSql` that refuses to build when the filtered row goes by one of the fragment's own aliases. */
class AliasedSql extends NativeSql {
  constructor(private readonly at: object, private readonly own: SqlFragment, private readonly aliases: readonly string[]) {
    super(at, own);
  }

  build(): IQueryStatementResult {
    const root = nativeRootOf(this.at);
    const outer = root?.TableAlias || root?.Table;
    const hit = outer ? this.aliases.find((a) => a.toLowerCase() === outer.toLowerCase()) : undefined;
    if (hit !== undefined) throw new AuthzConfigError(`authz-orm: the filtered row goes by "${outer}", an alias a native sql fragment gives its own table; give the query another alias`);
    return super.build();
  }

  clone<T>(parent?: T): IQueryStatement {
    const copy = new AliasedSql((parent ?? this.at) as object, this.own, this.aliases);
    copy.Boolean = this.Boolean;
    return copy;
  }
}

/**
 * As `whereSql`, for a fragment whose nested SELECTs name their tables by `aliases`: when the query
 * compiles, a filtered row that goes by one of them (in any letter case, as SQLite reads aliases) is
 * refused, as the nested SELECT would shadow it and `outerColumn` would read the wrong table.
 */
export function whereSqlWithAliases<B extends IWhereBuilder<unknown>>(holder: B, fragment: SqlFragment, aliases: readonly string[]): B {
  rootOf(holder, 'whereSqlWithAliases');
  if (!(fragment instanceof SqlFragment)) throw new AuthzConfigError('authz-orm: whereSqlWithAliases takes a fragment made by sql`…`');
  if (!Array.isArray(aliases) || aliases.some((a) => typeof a !== 'string' || a === '')) throw new AuthzConfigError('authz-orm: whereSqlWithAliases takes a list of non-empty aliases');
  (holder as unknown as { pushStatement(s: unknown): unknown }).pushStatement(new AliasedSql(holder, fragment, Object.freeze([...aliases])));
  return holder;
}

/** A column and how the adapter reads its value as an id (`IdMode`; 'none' for a column the orm does not know). */
export interface NativeIdColumn {
  readonly column: string;
  readonly idMode: IdMode;
}

/** A registered model's table and primary key, as `findRow` reads it. */
export interface NativeKey {
  readonly table: string;
  readonly id: NativeIdColumn;
}

/** How the adapter reads a registered model's rows: their refs, ancestors and scope attributes. */
export interface NativeScopePath extends NativeKey {
  readonly type: ResourceType;
  /** The `@ScopeColumn`s, nearest ancestor first; `ancestors` lists those whose value is an id of their mode. */
  readonly scopes: readonly (NativeIdColumn & { readonly scopeType: ResourceType })[];
  /** The `@AccessResource` attributes: the only top-level keys `scopeAttributes` can give. */
  readonly attributes: readonly string[];
  /**
   * The models of the type registered before this one, in that order: `findRow` tries them first, so a row
   * whose id one of them holds gets that model's row (and its ancestors). null for one on another connection,
   * or one whose table or key cannot be read: SQL on this model's connection cannot test it.
   */
  readonly before: readonly (NativeKey | null)[];
}

const driverName = (descriptor: { Driver?: unknown } | null | undefined): unknown => (descriptor?.Driver as { Options?: { Driver?: unknown } } | null | undefined)?.Options?.Driver;

function idColumnOf(model: unknown, column: string): NativeIdColumn {
  const descriptor = extractModelDescriptor(model as never);
  // On a driver authz-orm does not compile for, the adapter reads no id either (`dialectOf` throws there).
  const known = driverName(descriptor) === 'orm-driver-sqlite' || driverName(descriptor) === 'orm-driver-postgres';
  const info = known ? columnOf(model, column) : undefined;
  return { column, idMode: info === undefined ? 'none' : idMode(info, dialectOf(descriptor)) };
}

function keyOf(model: Class<ModelBase>): NativeKey {
  const descriptor = extractModelDescriptor(model as never);
  if (!descriptor?.TableName) throw new AuthzConfigError(`authz-orm: ${model.name} has no table`);
  return { table: descriptor.TableName, id: idColumnOf(model, pkOf(model)) };
}

/**
 * The scope path of a model as the adapter reads its rows; null when it is no `@AccessResource` model.
 * Read it after the orm loaded the table info. Every id mode is 'none' for a model on a driver other than
 * SQLite or Postgres. For an unregistered subclass of a registered model: the registered class's key mode,
 * scope columns and attributes (what `findRow` and `ancestors` read), and key mode 'none' when the
 * subclass reads another table, connection or key (`findRow` finds none of its rows).
 */
export function scopePathOf(model: Class<ModelBase>): NativeScopePath | null {
  const entry = entryOf(model);
  if (entry === undefined) return null;
  // findRow loads the registered class, never an unregistered subclass: its rows have the registered class's
  // key and scope columns, and only the rows in that class's table are found at all.
  const registered = entry.registered as Class<ModelBase>;
  const base = registered === model ? entry : entryOf(registered)!;
  const own = keyOf(model);
  const driver = extractModelDescriptor(model as never)?.Driver;
  const found = registered === model || sameRows(model, registered);
  const classes = classesOf(entry.type);
  const before = classes.slice(0, Math.max(0, classes.indexOf(entry.registered))).map((cls): NativeKey | null => {
    if (extractModelDescriptor(cls as never)?.Driver !== driver) return null;
    try {
      return keyOf(cls as Class<ModelBase>);
    } catch {
      return null;
    }
  });
  return {
    type: entry.type,
    table: own.table,
    id: found ? idColumnOf(registered, own.id.column) : { column: own.id.column, idMode: 'none' },
    scopes: base.scopeColumns.map((s) => ({ ...idColumnOf(registered, s.column), scopeType: s.scopeType })),
    attributes: [...base.attributes],
    before,
  };
}

/** Whether `sub` reads the rows of `registered`: the same table on the same connection, under the same key. */
function sameRows(sub: Class<ModelBase>, registered: Class<ModelBase>): boolean {
  const s = extractModelDescriptor(sub as never);
  const r = extractModelDescriptor(registered as never);
  if (!s || !r || s.Driver !== r.Driver || s.TableName !== r.TableName) return false;
  try {
    return pkOf(sub) === pkOf(registered);
  } catch {
    return false;
  }
}

/** The registered `@AccessResource` model classes, of `type` when given, in registration order (the order `findRow` tries them in). */
export function accessResourceModels(type?: ResourceType): readonly Class<ModelBase>[] {
  return (type === undefined ? registeredClasses() : classesOf(type)) as Class<ModelBase>[];
}

/** The resource type a model class is registered as (its nearest registered ancestor's); undefined when none. */
export function accessResourceTypeOf(model: Class<ModelBase>): ResourceType | undefined {
  return entryOf(model)?.type;
}
