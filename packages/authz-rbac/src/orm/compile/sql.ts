import { AuthzConfigError } from '@spinajs/authz';
import { identifier, isNativeBuilder, outerColumn, sql, whereSqlWithAliases } from '@spinajs/authz-orm/native';
import type { SqlFragment } from '@spinajs/authz-orm/native';
import { DatetimeValueConverter, IdentifierQuoter, QueryStatement } from '@spinajs/orm';
import type { IQueryStatement, IQueryStatementResult, IWhereBuilder, OrmDriver, SelectQueryBuilder } from '@spinajs/orm';

// The part kinds map 1:1 onto `@spinajs/authz-orm/native` (`outerColumn`, `identifier`, bound
// values, nested `sql` fragments): `toNativeSql` converts a fragment part by part.

/** The filtered row's column (authz-orm: `outerColumn`), named by `renderSql`'s `outer` callback. */
export class RbacOuterColumn {
  constructor(readonly column: string) {}
}

/** Table, alias or column names, quoted by the dialect (authz-orm: `identifier`). */
export class RbacIdentifier {
  constructor(readonly names: readonly string[]) {}
}

/** A collation name: quoted as an identifier, but no table or alias, so it shadows no row. */
export class RbacCollationName extends RbacIdentifier {}

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
const FORBIDDEN = new Uint8Array(128);
for (const c of ['?', "'", '"', '`', ';', '$', '[', ']', '#', '\\', ':', '@']) FORBIDDEN[c.charCodeAt(0)] = 1;

const OPEN = 0x28;
const CLOSE = 0x29;
// What a fragment starts or ends with when that is no text: another part, or nothing at all.
const PART = -1;
const NOTHING = -2;

const comment = (prev: number, c: number): boolean => (prev === 0x2d && c === 0x2d) || (prev === 0x2f && c === 0x2a);
const refuseComment = (prev: number, c: number): AuthzConfigError => refuse(`has a '${String.fromCharCode(prev, c)}' comment`);

const NO_COLUMNS: readonly string[] = Object.freeze([]);

/** `columns` and then the new ones of `read`, in order: the same array when nothing is new. */
function addColumns(columns: readonly string[], read: readonly string[]): readonly string[] {
  if (columns.length === 0) return read;
  let out: string[] | undefined;
  for (const c of read) if (!columns.includes(c)) (out ??= [...columns]).push(c);
  return out ?? columns;
}

/**
 * SQL text with bound values, quoted identifiers and the filtered row's columns, built by `rsql`.
 *
 * A fragment keeps the fragments nested in it whole and checks only its own text and values (a nested one was
 * checked when it was built), so a term builds in time linear in its size. The checks still hold for the
 * flattened text: a nested fragment is balanced on its own, and a comment formed across a boundary shows in the
 * first and last text character of the nested fragment.
 */
export class RbacSql {
  /** Its own parts and the fragments nested in it, in order. */
  readonly items: readonly (RbacSqlPart | RbacSql)[];
  /** The SQL is one bracket pair around everything. */
  readonly bracketed: boolean;
  /** The filtered row's columns it reads, in the order of their first `outer()`. */
  readonly outerColumns: readonly string[];
  private flat: readonly RbacSqlPart[] | undefined;
  // The first and last text character's code, PART when another part comes first or last, NOTHING when empty.
  private readonly head: number;
  private readonly tail: number;

  constructor(parts: readonly (RbacSqlPart | RbacSql)[]) {
    for (const p of parts) if (p instanceof RbacBound) assertBindable(p.value);
    let depth = 0;
    let head = NOTHING;
    let tail = NOTHING;
    // For `bracketed`: nothing seen yet; the last character closed the outermost bracket.
    let first = true;
    let closed = false;
    let bracketed = true;
    let columns = NO_COLUMNS;
    for (const p of parts) {
      if (typeof p === 'string') {
        if (p.length === 0) continue;
        // Code units, not code points: every character checked is ASCII, and no surrogate is.
        for (let i = 0; i < p.length; i++) {
          const c = p.charCodeAt(i);
          if (c < 128 && FORBIDDEN[c] === 1) throw refuse(`has a '${p[i]}' in its text; bind values and name columns with ident() or outer()`);
          if (comment(tail, c)) throw refuseComment(tail, c);
          if (first) bracketed = c === OPEN;
          else if (depth === 0 && closed) bracketed = false;
          first = false;
          if (c === OPEN) depth++;
          else if (c === CLOSE && --depth < 0) throw refuse("closes a bracket it did not open: ')' before its '('");
          closed = c === CLOSE && depth === 0;
          tail = c;
        }
        if (head === NOTHING) head = p.charCodeAt(0);
      } else if (p instanceof RbacSql) {
        if (p.head === NOTHING) continue;
        if (comment(tail, p.head)) throw refuseComment(tail, p.head);
        if (head === NOTHING) head = p.head;
        tail = p.tail;
        if (depth === 0) bracketed &&= first && p.bracketed;
        first = false;
        closed = depth === 0 && p.bracketed;
        if (p.outerColumns.length > 0) columns = addColumns(columns, p.outerColumns);
      } else {
        if (head === NOTHING) head = PART;
        tail = PART;
        if (depth === 0) bracketed = false;
        first = false;
        closed = false;
        if (p instanceof RbacOuterColumn) columns = addColumns(columns, [p.column]);
      }
    }
    if (depth > 0) throw refuse(`leaves ${depth} bracket(s) open`);
    this.items = Object.freeze([...parts]);
    this.bracketed = bracketed && !first && closed;
    this.outerColumns = columns;
    this.head = head;
    this.tail = tail;
  }

  /** The parts with the nested fragments spliced in, worked out when first read. */
  get parts(): readonly RbacSqlPart[] {
    if (this.flat) return this.flat;
    const out: RbacSqlPart[] = [];
    // Not recursive: a term nests fragments thousands deep.
    const stack: { items: readonly (RbacSqlPart | RbacSql)[]; i: number }[] = [{ items: this.items, i: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top.i === top.items.length) {
        stack.pop();
        continue;
      }
      const p = top.items[top.i++];
      if (!(p instanceof RbacSql)) out.push(p);
      else if (p.flat) for (const q of p.flat) out.push(q);
      else stack.push({ items: p.items, i: 0 });
    }
    this.flat = Object.freeze(out);
    return this.flat;
  }
}

export function rsql(strings: TemplateStringsArray, ...values: readonly RbacSqlArg[]): RbacSql {
  const parts: (RbacSqlPart | RbacSql)[] = [];
  strings.forEach((s, i) => {
    parts.push(s);
    if (i >= values.length) return;
    const v: unknown = values[i];
    if (v instanceof RbacSql || v instanceof RbacOuterColumn || v instanceof RbacIdentifier) parts.push(v);
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

/** A collation's quoted name, as after `COLLATE` (a fragment's text holds no double quote). */
export function collation(name: string): RbacCollationName {
  if (typeof name !== 'string' || name === '') throw refuse('collation() takes a non-empty name');
  return new RbacCollationName([name]);
}

/** A table name only `aliasedTable` writes, always followed by an alias: it shadows no row, so it is no alias head. */
class RbacTableName extends RbacIdentifier {}

/** `table alias` as a FROM item: unlike `ident`, the table may be the filtered row's own, as the alias keeps it apart. */
export function aliasedTable(table: string, alias: string): RbacSql {
  if (typeof table !== 'string' || table === '') throw refuse('aliasedTable() takes a non-empty table name');
  return rsql`${new RbacTableName([table])} ${ident(alias)}`;
}

/** The fragment with every `outer(c)` read as `alias.<name(c)>`: the same SQL about another row source. */
export function rebindOuter(fragment: RbacSql, alias: string, name: (column: string) => string = (c) => c): RbacSql {
  if (typeof alias !== 'string' || alias === '') throw refuse('rebindOuter() takes a non-empty alias');
  // Only the fragments that read a column are built again; the others are shared. Post-order, without recursion.
  const rebound = new Map<RbacSql, RbacSql>();
  const reads = (p: RbacSqlPart | RbacSql): p is RbacSql => p instanceof RbacSql && p.outerColumns.length > 0;
  const stack: RbacSql[] = [fragment];
  while (stack.length > 0) {
    const f = stack[stack.length - 1];
    let ready = true;
    for (const p of f.items) {
      if (reads(p) && !rebound.has(p)) {
        stack.push(p);
        ready = false;
      }
    }
    if (!ready) continue;
    stack.pop();
    if (!rebound.has(f)) rebound.set(f, new RbacSql(f.items.map((p) => (p instanceof RbacOuterColumn ? ident(alias, name(p.column)) : reads(p) ? rebound.get(p)! : p))));
  }
  // Always a new fragment, as before: kleene.ts tells fragments apart by identity.
  return rebound.get(fragment)!;
}

/** The filtered row's columns a fragment reads. */
export function outerColumnsOf(fragment: RbacSql): string[] {
  return [...fragment.outerColumns];
}

export const TRUE_SQL: RbacSql = rsql`1 = 1`;
export const FALSE_SQL: RbacSql = rsql`1 = 0`;

export function joinSql(parts: readonly RbacSql[], separator: string): RbacSql {
  const out: (string | RbacSql)[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(separator);
    out.push(p);
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
        if (options.outerName !== undefined && !(p instanceof RbacCollationName) && !(p instanceof RbacTableName) && sameName(p.names[0], options.outerName)) throw refuse(`the name "${p.names[0]}" is the filtered row's "${options.outerName}"; give the other table another alias`);
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
 * `outer()` still names the row `builder` filters. Outside authz-orm only: in a native compilation it is
 * refused (write the nested SELECT into the fragment, or use authz-orm's `correlatedQuery`).
 */
export function rbacSubQuery(builder: IWhereBuilder<unknown>, table: string, alias: string): SelectQueryBuilder {
  if (!table || !alias) throw refuse('rbacSubQuery() takes a table and an alias');
  if (isNativeBuilder(builder)) throw refuse("rbacSubQuery() is not for an authz-orm native compilation; write the nested SELECT into the fragment, or use authz-orm's correlatedQuery");
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
    // A correlation given after whereRbacSql ran.
    if (reachesNative(this.holder)) throw refuseNative();
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
 * The fragment as an authz-orm `sql` fragment for `builder` (the builder an OrmNativeCompiler is handed,
 * or a where group in it): bound values stay bound, `outer(c)` becomes `outerColumn(builder, c)` (which
 * refuses a column the model does not have), `ident(...)` `identifier(...)`, and the text stays text.
 */
export function toNativeSql(fragment: RbacSql, builder: IWhereBuilder<unknown>): SqlFragment {
  return nativeOf(fragment, builder).native;
}

/** `toNativeSql`, and the first names of the fragment's identifiers: the tables and aliases its nested SELECTs name. */
function nativeOf(fragment: RbacSql, builder: IWhereBuilder<unknown>): { native: SqlFragment; heads: string[] } {
  const strings: string[] = [''];
  const values: unknown[] = [];
  const heads = new Set<string>();
  for (const p of fragment.parts) {
    if (typeof p === 'string') {
      strings[strings.length - 1] += p;
      continue;
    }
    if (p instanceof RbacOuterColumn) values.push(outerColumn(builder, p.column));
    else if (p instanceof RbacIdentifier) {
      values.push(identifier(...p.names));
      if (!(p instanceof RbacCollationName) && !(p instanceof RbacTableName)) heads.add(p.names[0]);
    } else values.push(p.value);
    strings.push('');
  }
  return { native: sql(Object.assign(strings, { raw: [...strings] }) as unknown as TemplateStringsArray, ...values), heads: [...heads] };
}

/** Whether a native builder is reachable through `b`'s where groups and correlations: its row is not this query's. */
function reachesNative(b: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: unknown[] = [b];
  while (queue.length > 0 && seen.size < MAX_HOPS) {
    const x = queue.shift();
    if (x == null || seen.has(x)) continue;
    seen.add(x);
    if (isNativeBuilder(x)) return true;
    const links = x as BuilderLinks;
    queue.push(links.Parent, links.CorrelationSource);
  }
  return false;
}

const refuseNative = (): AuthzConfigError => refuse('the builder is correlated with an authz-orm native compilation; add the fragment to the native builder (or a where group in it), not to a sub-query of it');

/**
 * Adds `(fragment)` as an AND condition of `w`. In an authz-orm native compilation (`w` is the builder an
 * OrmNativeCompiler is handed, or a where group in it) through authz-orm's `whereSql`, converted by
 * `toNativeSql`; otherwise `w` is the filtered query, an rbacSubQuery sub of it (at any depth), or a where
 * group in either. Either way `outer()` names the filtered row under the alias it has when the SQL is
 * built, and a filtered row that goes by the first name of one of the fragment's identifiers is refused
 * then: the nested SELECT would shadow it. Outside a native compilation any other query, even one
 * correlated with a parent (an orm relation query), is the filtered row itself.
 */
export function whereRbacSql<B extends IWhereBuilder<unknown>>(w: B, fragment: RbacSql): B {
  if (isNativeBuilder(w)) {
    const { native, heads } = nativeOf(fragment, w);
    return whereSqlWithAliases(w, native, heads);
  }
  if (reachesNative(w)) throw refuseNative();
  queryOf(w);
  (w as unknown as { pushStatement(s: IQueryStatement): unknown }).pushStatement(new RbacSqlStatement(w, fragment));
  return w;
}
