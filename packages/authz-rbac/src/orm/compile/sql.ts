import { AuthzConfigError } from '@spinajs/authz';
import { DatetimeValueConverter, IdentifierQuoter, QueryStatement } from '@spinajs/orm';
import type { IQueryStatement, IQueryStatementResult, IWhereBuilder, OrmDriver, SelectQueryBuilder } from '@spinajs/orm';

// The part kinds map 1:1 onto `@spinajs/authz-orm/native` (`outerColumn`, `identifier`, bound
// values, nested `sql` fragments), so the blocks move to its `whereSql` without a rewrite.

/** The filtered row's column (authz-orm: `outerColumn`), named by `renderSql`'s `outer` callback. */
export class RbacOuterColumn {
  constructor(readonly column: string) {}
}

/** Table, alias or column names, quoted by the dialect (authz-orm: `identifier`). */
export class RbacIdentifier {
  constructor(readonly names: readonly string[]) {}
}

/** What a fragment binds. */
export type RbacSqlValue = string | number | bigint | Date;

/** A value bound as a parameter. */
export class RbacBound {
  constructor(readonly value: RbacSqlValue) {}
}

export type RbacSqlPart = string | RbacOuterColumn | RbacIdentifier | RbacBound;

/** What `rsql` takes between its text parts: an array binds one parameter per element. */
export type RbacSqlArg = RbacSqlValue | readonly RbacSqlValue[] | RbacSql | RbacOuterColumn | RbacIdentifier;

const refuse = (why: string): AuthzConfigError => new AuthzConfigError(`authz-rbac sql: ${why}`);

const isSafe = (v: bigint): boolean => v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER);

const describeValue = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? `an object (${(v as object).constructor?.name ?? 'no prototype'})` : typeof v);

/**
 * Only values that bind the same on every dialect. null would turn a comparison NULL (write `IS NULL`
 * instead); booleans bind as 1/0 on some dialects and as booleans on others.
 */
function assertBindable(v: unknown): asserts v is RbacSqlValue {
  if (typeof v === 'string') return;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw refuse(`cannot bind ${v}`);
    return;
  }
  if (typeof v === 'bigint') {
    if (!isSafe(v)) throw refuse(`cannot bind ${v}n, outside the safe integers`);
    return;
  }
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw refuse('cannot bind an invalid Date');
    return;
  }
  throw refuse(`cannot bind ${describeValue(v)}; pass a string, finite number, safe bigint or Date`);
}

// Stricter than authz-orm's check, so whatever passes here passes there: the text never holds a
// quoted literal (values are bound), a placeholder, a named parameter or a comment.
const FORBIDDEN = new Set(['?', "'", '"', '`', ';', '$', '[', ']', '#', '\\', ':', '@']);

function assertText(parts: readonly RbacSqlPart[]): void {
  let depth = 0;
  let prev = '';
  for (const part of parts) {
    if (typeof part !== 'string') {
      prev = '';
      continue;
    }
    for (const c of part) {
      if (FORBIDDEN.has(c)) throw refuse(`has a '${c}' in its text; bind values and name columns with ident() or outer()`);
      if ((prev === '-' && c === '-') || (prev === '/' && c === '*')) throw refuse(`has a '${prev}${c}' comment`);
      if (c === '(') depth++;
      else if (c === ')' && --depth < 0) throw refuse("closes a bracket it did not open: ')' before its '('");
      prev = c;
    }
  }
  if (depth > 0) throw refuse(`leaves ${depth} bracket(s) open`);
}

/** SQL text with bound values, quoted identifiers and the filtered row's columns, built by `rsql`. */
export class RbacSql {
  readonly parts: readonly RbacSqlPart[];

  constructor(parts: readonly RbacSqlPart[]) {
    for (const p of parts) if (p instanceof RbacBound) assertBindable(p.value);
    assertText(parts);
    this.parts = Object.freeze([...parts]);
  }
}

export function rsql(strings: TemplateStringsArray, ...values: readonly RbacSqlArg[]): RbacSql {
  const parts: RbacSqlPart[] = [];
  strings.forEach((s, i) => {
    parts.push(s);
    if (i >= values.length) return;
    const v: unknown = values[i];
    // A loop, not a spread: a large fragment would overflow the argument stack.
    if (v instanceof RbacSql) for (const part of v.parts) parts.push(part);
    else if (v instanceof RbacOuterColumn || v instanceof RbacIdentifier) parts.push(v);
    else if (Array.isArray(v)) {
      if (v.length === 0) throw refuse('cannot bind an empty array; fold the empty list in the compiler (IN of nothing is FALSE)');
      v.forEach((x: unknown, j) => {
        if (j > 0) parts.push(', ');
        assertBindable(x);
        parts.push(new RbacBound(x));
      });
    } else {
      assertBindable(v);
      parts.push(new RbacBound(v));
    }
  });
  return new RbacSql(parts);
}

export function outer(column: string): RbacOuterColumn {
  if (typeof column !== 'string' || column === '') throw refuse('outer() takes a non-empty column name');
  return new RbacOuterColumn(column);
}

export function ident(...names: string[]): RbacIdentifier {
  if (names.length === 0 || names.some((n) => typeof n !== 'string' || n === '')) throw refuse('ident() takes non-empty names');
  return new RbacIdentifier(names);
}

export const TRUE_SQL: RbacSql = rsql`1 = 1`;
export const FALSE_SQL: RbacSql = rsql`1 = 0`;

export function joinSql(parts: readonly RbacSql[], separator: string): RbacSql {
  const out: RbacSqlPart[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(separator);
    for (const part of p.parts) out.push(part);
  });
  return new RbacSql(out);
}

function joinParenthesised(operands: readonly RbacSql[], separator: string): RbacSql {
  const joined = joinSql(
    operands.map((o) => rsql`(${o})`),
    separator,
  );
  return rsql`(${joined})`;
}

/** Empty: TRUE. Each operand and the whole are parenthesised, so the result composes by hand. */
export const andSql = (...operands: readonly RbacSql[]): RbacSql => (operands.length === 0 ? TRUE_SQL : joinParenthesised(operands, ' AND '));

/** Empty: FALSE. Each operand and the whole are parenthesised, so the result composes by hand. */
export const orSql = (...operands: readonly RbacSql[]): RbacSql => (operands.length === 0 ? FALSE_SQL : joinParenthesised(operands, ' OR '));

export const notSql = (operand: RbacSql): RbacSql => rsql`NOT (${operand})`;

/** `expr IN (…)`, one binding per value; refuses the empty list, which the caller folds to FALSE_SQL. */
export function inList(expr: RbacSql, values: readonly RbacSqlValue[]): RbacSql {
  if (values.length === 0) throw refuse('inList() takes a non-empty list; fold the empty list to FALSE_SQL');
  return rsql`${expr} IN (${values})`;
}

/** An integer written into the text: path structure, not a value, so postgres types a CASE of them as integer. */
export function intSql(n: number): RbacSql {
  if (!Number.isSafeInteger(n)) throw refuse(`intSql() takes a safe integer, got ${n}`);
  return new RbacSql([String(n)]);
}

/**
 * `expr` as text, to compare a row id with a varchar `scope_id` (postgres will not compare integer with
 * varchar). No length: postgres and MySQL cut a cast value to it silently, and a cut id would equal
 * another one. As L2's `RbacOrmCompiler.textOf`.
 */
export function textOf(expr: RbacSql, quoter: IdentifierQuoter): RbacSql {
  const quoted = quoter.quote('x');
  // MySQL's CAST takes CHAR, not VARCHAR or TEXT; SQLite (also backtick-quoted) reads CHAR as text.
  if (quoted === '`x`') return rsql`CAST(${expr} AS CHAR)`;
  // MSSQL reads a bare VARCHAR as varchar(30).
  if (quoted === '[x]') return rsql`CAST(${expr} AS NVARCHAR(4000))`;
  return rsql`CAST(${expr} AS TEXT)`;
}

export interface RbacRenderOptions {
  readonly driver: OrmDriver;
  /** The filtered row's column, quoted and qualified. */
  readonly outer: (column: string) => string;
  /** The alias or table the filtered row goes by: an identifier that is or starts with it, in any letter case, is refused, as that alias would shadow the row. */
  readonly outerName?: string;
}

export interface RbacRenderedSql {
  readonly text: string;
  readonly bindings: readonly unknown[];
}

/**
 * node-sqlite3 binds a Date as a number, which compares wrong against the TEXT the ORM stores, so a
 * Date binds as the connection's datetime converter writes it.
 */
function bindingOf(value: RbacSqlValue, driver: OrmDriver): unknown {
  // A Date can be made invalid after the fragment checked it.
  assertBindable(value);
  if (value instanceof Date) {
    const out: unknown = driver.Container.resolve<DatetimeValueConverter>(DatetimeValueConverter).toDB(value, undefined as never, undefined as never);
    if (out === null || out === undefined) throw refuse('the datetime converter wrote no value for a Date');
    return out;
  }
  if (typeof value === 'bigint') return Number(value);
  return value;
}

// SQLite, MSSQL and MySQL (lower_case_table_names) read aliases case-insensitively; refusing more is safe.
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The fragment as `?`-placeholder text and its bindings, in order. With `outerName`, an identifier
 * that is or starts with that name is refused: as an alias it would shadow the filtered row. A
 * nested SELECT in a fragment therefore takes fixed `authz_`-prefixed aliases.
 */
export function renderSql(fragment: RbacSql, options: RbacRenderOptions): RbacRenderedSql {
  const quoter = options.driver.Container.resolve<IdentifierQuoter>(IdentifierQuoter);
  const bindings: unknown[] = [];
  const text = fragment.parts
    .map((p) => {
      if (typeof p === 'string') return p;
      if (p instanceof RbacOuterColumn) return options.outer(p.column);
      if (p instanceof RbacIdentifier) {
        if (options.outerName !== undefined && sameName(p.names[0], options.outerName)) throw refuse(`the name "${p.names[0]}" is the filtered row's "${options.outerName}"; give the other table another alias`);
        return p.names.map((n) => quoter.quote(n)).join('.');
      }
      bindings.push(bindingOf(p.value, options.driver));
      return '?';
    })
    .join('');
  return { text, bindings };
}

interface BuilderLinks {
  readonly Driver?: OrmDriver;
  readonly Table?: string;
  readonly TableAlias?: string;
  readonly Parent?: BuilderLinks;
  readonly CorrelationSource?: unknown;
}

const MAX_HOPS = 64;

function queryOf(builder: unknown): BuilderLinks {
  for (let b = builder as BuilderLinks | undefined, hops = 0; b && hops < MAX_HOPS; b = b.Parent, hops++) {
    if (b.Driver) return b;
  }
  throw refuse('the where builder is not attached to a query');
}

const nameOf = (query: BuilderLinks): string | undefined => query.TableAlias || query.Table || undefined;

// Sub-queries made by rbacSubQuery, and their clones. Only their correlation links are followed:
// the orm correlates its relation queries too, and there the relation query is the filtered row.
const rbacSubs = new WeakSet<object>();

function markSub(sub: SelectQueryBuilder): SelectQueryBuilder {
  rbacSubs.add(sub);
  const clone = sub.clone;
  // The orm clones a query with its sub-queries (and re-correlates them); the copy must stay marked.
  Object.defineProperty(sub, 'clone', {
    configurable: true,
    writable: true,
    value: function (this: SelectQueryBuilder, ...args: unknown[]) {
      return markSub((clone as (...a: unknown[]) => SelectQueryBuilder).apply(this, args));
    },
  });
  return sub;
}

/**
 * `SELECT * FROM <table> <alias>` correlated with `builder` (a query, a where group in one, or another
 * rbacSubQuery sub), for `whereExist(...)` / `whereNotExists(...)` on it. In it `whereRbacSql`'s
 * `outer()` still names the row `builder` filters. Stands in for authz-orm's `correlatedQuery`.
 */
export function rbacSubQuery(builder: IWhereBuilder<unknown>, table: string, alias: string): SelectQueryBuilder {
  if (!table || !alias) throw refuse('rbacSubQuery() takes a table and an alias');
  const sub = queryOf(builder).Driver!.select().from(table, alias).correlateWith(builder);
  return markSub(sub as SelectQueryBuilder);
}

/** The queries from `builder`'s own out to the filtered one: through rbacSubQuery subs only, ending at the first other query. */
function queryChain(builder: unknown): BuilderLinks[] {
  const chain = [queryOf(builder)];
  while (rbacSubs.has(chain[chain.length - 1])) {
    if (chain.length >= MAX_HOPS) throw refuse('the sub-queries nest too deep');
    const source = chain[chain.length - 1].CorrelationSource;
    if (source == null) throw refuse('an rbacSubQuery sub-query lost its correlation');
    chain.push(queryOf(source));
  }
  return chain;
}

/** `(fragment)` in a where builder; the filtered row's name is read when the query builds. */
class RbacSqlStatement extends QueryStatement {
  constructor(private readonly holder: unknown, private readonly fragment: RbacSql) {
    super();
  }

  build(): IQueryStatementResult {
    const chain = queryChain(this.holder);
    const filtered = chain[chain.length - 1];
    const driver = chain[0].Driver!;
    const outerName = nameOf(filtered);
    if (!outerName) throw refuse('the filtered query has no table');
    for (const sub of chain.slice(0, -1)) {
      const name = nameOf(sub);
      if (name !== undefined && sameName(name, outerName)) throw refuse(`the sub-query alias "${name}" shadows the filtered row "${outerName}"; give the sub-query another alias`);
    }
    const quoter = driver.Container.resolve<IdentifierQuoter>(IdentifierQuoter);
    const row = filtered.TableAlias ? quoter.quote(outerName) : quoter.quoteQualified(outerName);
    const { text, bindings } = renderSql(this.fragment, { driver, outer: (column) => `${row}.${quoter.quote(column)}`, outerName });
    return { Statements: [`(${text})`], Bindings: [...bindings] };
  }

  clone<T>(parent?: T): IQueryStatement {
    const copy = new RbacSqlStatement(parent ?? this.holder, this.fragment);
    copy.Boolean = this.Boolean;
    return copy;
  }
}

/**
 * Adds `(fragment)` as an AND condition of `w`: the filtered query, an rbacSubQuery sub of it (at any
 * depth), or a where group in either. `outer()` names the filtered row under the alias it has when the
 * SQL is built. Any other query, even one correlated with a parent (an orm relation query), is the
 * filtered row itself. Stands in for authz-orm's `whereSql` until that merges.
 */
export function whereRbacSql<B extends IWhereBuilder<unknown>>(w: B, fragment: RbacSql): B {
  queryOf(w);
  (w as unknown as { pushStatement(s: IQueryStatement): unknown }).pushStatement(new RbacSqlStatement(w, fragment));
  return w;
}
