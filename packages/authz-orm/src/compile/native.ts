import { AuthzConfigError } from '@spinajs/authz';
import { DatetimeValueConverter, ExistsQueryStatement, IdentifierQuoter, JoinStatement, LazyQueryStatement, QueryStatement, WhereBoolean, WhereBuilder, WhereQueryStatement } from '@spinajs/orm';
import type { IQueryStatement, IQueryStatementResult, IWhereBuilder, OrmDriver, SelectQueryBuilder } from '@spinajs/orm';

import type { ModelClass } from '../registry.js';
import { AuthzStatement, shieldGroup } from '../shield.js';
import { dialectFor } from './dialect.js';

/** What an `OrmNativeCompiler` compiles for: its op and the model, connection and table of the rows it filters. */
export interface NativeSite {
  readonly op: `native:${string}`;
  readonly model: ModelClass;
  readonly driver: OrmDriver;
  readonly table: string;
}

/**
 * The where builder an `OrmNativeCompiler` writes into. It reads its query's alias and table when it
 * builds, not when it is created (the middleware compiles before `populate()` or a join gives the
 * query its alias), and so do the groups nested in it with `where(fn)`.
 */
export class NativeWhereBuilder extends WhereBuilder<unknown> {
  constructor(parent: WhereBuilder<unknown>, readonly site: NativeSite) {
    super(parent);
  }

  public get TableAlias(): string {
    return (this._parent as unknown as { TableAlias?: string } | undefined)?.TableAlias as string;
  }

  /** The outer query's table, which a correlated sub-query names when the query has no alias. */
  public get Table(): string {
    return (this._parent as unknown as { Table?: string } | undefined)?.Table || this.site.table;
  }

  public where(...args: unknown[]): this {
    const [column] = args;
    if (typeof column !== 'function') return (super.where as (...a: unknown[]) => this).apply(this, args);
    const nested = new NativeWhereBuilder(this, this.site);
    (column as (this: unknown) => void).call(nested);
    this.pushStatement(this._container.resolve<WhereQueryStatement>(WhereQueryStatement, [nested, this.TableAlias]));
    return this;
  }

  public clone<P extends IWhereBuilder<any>>(parent: P): WhereBuilder<unknown> {
    const builder = new NativeWhereBuilder(parent as unknown as WhereBuilder<unknown>, this.site);
    builder._boolean = this._boolean;
    builder._model = this._model;
    builder._statements = this._statements.map((s) => {
      const cloned = s.clone(builder);
      cloned.Boolean = s.Boolean;
      return cloned;
    });
    return builder;
  }
}

/**
 * The orm's where compiler emits lazy statements (its own correlated `whereExist('<relation>')`)
 * after all the others, so `lazy AND a OR b` would compile as `a OR b AND lazy`, and their
 * correlation is back-quoted, which Postgres rejects: a native fragment must not hold one.
 */
export function assertNoLazy(builder: IWhereBuilder<unknown>, op: string): void {
  const seen = new Set<object>();
  const visit = (b: unknown): void => {
    if (b === null || typeof b !== 'object' || seen.has(b)) return;
    seen.add(b);
    for (const s of statementsOf(b)) {
      if (s instanceof LazyQueryStatement) throw new AuthzConfigError(`authz-orm: the OrmNativeCompiler for ${op} built a lazy statement (a whereExist by relation name, or a Lazy where); build its sub-queries with correlatedQuery and correlate from @spinajs/authz-orm/native`);
      visit((s as { _builder?: unknown })._builder);
    }
  };
  visit(builder);
}

function statementsOf(b: object): IQueryStatement[] {
  const own = (b as { _statements?: unknown })._statements;
  const joins = (b as { _joinStatements?: unknown })._joinStatements;
  const out = Array.isArray(own) ? [...(own as IQueryStatement[])] : [];
  if (Array.isArray(joins)) for (const j of joins as unknown[]) if (j instanceof JoinStatement) out.push(...(((j as unknown as { _options?: { onStatements?: IQueryStatement[] } })._options?.onStatements ?? []) as IQueryStatement[]));
  return out;
}

// Sub-queries made by correlatedQuery, and their clones.
const correlatedSubs = new WeakSet<object>();

export const markCorrelated = (sub: object): void => void correlatedSubs.add(sub);

const isCorrelated = (b: unknown): b is SelectQueryBuilder => typeof b === 'object' && b !== null && correlatedSubs.has(b);

const MAX_HOPS = 64;

/**
 * The native builder whose row `b` tests: `b` itself, or up through where groups and correlatedQuery
 * sub-queries. The orm re-correlates a cloned sub-select with the builder it is cloned into, so after
 * a clone a sub nested in another names the middle one; walking up always reaches the row.
 */
export function nativeRootOf(b: unknown): NativeWhereBuilder | undefined {
  let cur = b;
  for (let hops = 0; hops < MAX_HOPS && cur != null; hops++) {
    if (cur instanceof NativeWhereBuilder) return cur;
    if (isCorrelated(cur)) cur = cur.CorrelationSource;
    else if (cur instanceof WhereBuilder) cur = cur.Parent;
    else return undefined;
  }
  return undefined;
}

/** The correlatedQuery sub-query `b` is, or whose where group (at any depth) it is. */
export function correlatedSubOf(b: unknown): SelectQueryBuilder | undefined {
  let cur = b;
  for (let hops = 0; hops < MAX_HOPS && cur != null; hops++) {
    if (isCorrelated(cur)) return cur;
    if (!(cur instanceof WhereBuilder) || cur instanceof NativeWhereBuilder) return undefined;
    cur = cur.Parent;
  }
  return undefined;
}

const quoterOf = (root: NativeWhereBuilder): ((name: string) => string) => {
  const quoter = root.site.driver.Container.resolve<IdentifierQuoter>(IdentifierQuoter as never);
  return (name) => quoter.quote(name);
};

// Rendering FALSE instead would make a NOT EXISTS around the statement TRUE.
const lost = (what: string): AuthzConfigError => new AuthzConfigError(`authz-orm: ${what} of a native compiler lost the row it tests (an alias or a correlatedQuery sub-query was changed by hand)`);

const rawStatements = (b: object): IQueryStatement[] => (b as { _statements: IQueryStatement[] })._statements;

/** `<sub>.<column> = <filtered row>.<outerColumn>`, both names read when the statement builds, from where it sits then. */
export class NativeCorrelation extends AuthzStatement {
  constructor(readonly target: object, private readonly column: string, private readonly outerColumn: string) {
    super();
  }

  static add(holder: object, column: string, outerColumn: string): void {
    if (holder instanceof WhereBuilder) shieldGroup(holder);
    rawStatements(holder).push(new NativeCorrelation(holder, column, outerColumn));
  }

  build(): IQueryStatementResult {
    const sub = correlatedSubOf(this.target);
    const own = sub?.TableAlias;
    const root = nativeRootOf(sub);
    const outer = root?.TableAlias || root?.Table;
    if (root === undefined || !own || !outer || own === outer) throw lost('a correlation');
    const q = quoterOf(root);
    return { Statements: [`${q(own)}.${q(this.column)} = ${q(outer)}.${q(this.outerColumn)}`], Bindings: [] };
  }

  clone<T>(parent?: T): IQueryStatement {
    const holder = (parent ?? this.target) as object;
    if (holder instanceof WhereBuilder) shieldGroup(holder);
    return this.derived(new NativeCorrelation(holder, this.column, this.outerColumn));
  }
}

const groupOf = (s: IQueryStatement): object | undefined => (s instanceof WhereQueryStatement ? (s as unknown as { _builder?: object })._builder : undefined);

const existsOf = (s: IQueryStatement): object | undefined => (s instanceof ExistsQueryStatement ? (s as unknown as { _builder?: object })._builder : undefined);

// A correlation, or a where group or an EXISTS / NOT EXISTS over a correlatedQuery sub that holds one.
const holds = (s: IQueryStatement): boolean => {
  if (s instanceof NativeCorrelation) return true;
  const group = groupOf(s);
  if (group !== undefined) return holdsCorrelation(group);
  const sub = existsOf(s);
  return sub !== undefined && isCorrelated(sub) && holdsCorrelation(sub);
};

const holdsCorrelation = (b: object): boolean => rawStatements(b).some(holds);

// The SQL joins statements with their own connectors, AND binding tighter: split at each OR.
const orOperands = (statements: readonly IQueryStatement[]): IQueryStatement[][] => {
  const out: IQueryStatement[][] = [];
  statements.forEach((s, i) => {
    if (i === 0 || s.Boolean === WhereBoolean.OR) out.push([s]);
    else out[out.length - 1].push(s);
  });
  return out;
};

/**
 * A correlatedQuery sub-query and each where group compile `correlations AND (the rest)`. With no
 * correlation at the sub's top level, an OR there would reach around the ones in its groups. In any
 * list, an OR operand without a correlation reaches around a sibling that holds one, so either all
 * operands hold one (onPath) or none does (an OR that the correlations around it contain).
 */
export function assertCorrelationsHold(sub: object): void {
  const statements = rawStatements(sub);
  if (!statements.some((s) => s instanceof NativeCorrelation) && statements.slice(1).some((s) => s.Boolean === WhereBoolean.OR)) throw new AuthzConfigError('authz-orm: a correlatedQuery sub-query with no correlate() at its top level has an orWhere there, which reaches around the correlations in its where groups; put the OR inside a where group');
  const visit = (b: object): void => {
    const rest = rawStatements(b).filter((s) => !(s instanceof NativeCorrelation));
    const holding = orOperands(rest).map((operand) => operand.some(holds));
    if (holding.includes(true) && holding.includes(false)) throw new AuthzConfigError('authz-orm: a where group of a correlatedQuery sub-query that holds a correlate() is joined by orWhere with a condition that holds none, which reaches around the correlation; correlate every operand of the OR, or move the OR inside the correlated group');
    for (const s of rest) {
      const group = groupOf(s);
      if (group !== undefined) visit(group);
    }
  };
  visit(sub);
}

/** The filtered row's column, resolved when the fragment builds. */
export class OuterColumn {
  constructor(readonly column: string) {}
}

/** Identifier parts, quoted by the dialect when the fragment builds. */
export class Identifier {
  constructor(readonly names: readonly string[]) {}
}

/** A value bound as a parameter. */
class Bound {
  constructor(readonly value: unknown) {}
}

type Part = string | OuterColumn | Identifier | Bound;

const refuse = (why: string): AuthzConfigError => new AuthzConfigError(`authz-orm: an sql fragment ${why}`);

// SQLite takes these, and any character above ASCII, as part of a parameter name.
const isNameChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c) || c.codePointAt(0)! >= 0x80;

/**
 * The fragment is wrapped in brackets, so its literal text must not close them, end the statement or
 * comment out the rest. Quoted literals are skipped, which needs a scanner that reads them as both
 * dialects do: so no backslash in them (PG E'…' escapes) and no `[…]` (SQLite) or `$…$` (PG) quoting.
 * A `?` would shift the bindings (orm-postgres turns one inside a literal into `$n` too), and so would
 * SQLite's named parameters `:x` and `@x`; PG's `::` cast and `@>` / `<@` stay. It scans the parts
 * with nested fragments spliced in, as a `-` at the end of one and a `-` at the start of the next
 * make a comment too. A doubled quote inside a literal toggles twice, which leaves the state as the
 * escape does.
 */
function assertContained(parts: readonly Part[]): void {
  let depth = 0;
  let quote: string | undefined;
  let prev2 = '';
  let prev = '';
  for (const part of parts) {
    if (typeof part !== 'string') {
      if (quote !== undefined) throw refuse('has a value inside a quoted literal; bind the whole value instead');
      prev2 = prev = '';
      continue;
    }
    for (const c of part) {
      if (quote !== undefined) {
        if (c === '\\') throw refuse('has a backslash in a quoted literal');
        if (c === '?') throw refuse("has a '?' in a quoted literal; bind the value instead");
        if (c === quote) quote = undefined;
      } else if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(') depth++;
      else if (c === ')' && --depth < 0) throw refuse("closes a bracket it did not open: ')' before its '('");
      else if (prev === '-' && c === '-') throw refuse("has a '--' comment");
      else if (prev === '/' && c === '*') throw refuse("has a '/*' comment");
      else if (((prev === ':' && prev2 !== ':') || prev === '@') && isNameChar(c)) throw refuse(`has '${prev}${c}', which SQLite reads as a named parameter`);
      // SQLite's parameter names go on over '::' pairs, so ':::x' and '@::x' are parameters too.
      else if ((prev === '@' && c === ':') || (prev2 === ':' && prev === ':' && c === ':')) throw refuse(`has '${prev === '@' ? '@:' : ':::'}', which SQLite reads as the start of a named parameter`);
      else if (';#[]$?'.includes(c)) throw refuse(`has a '${c}' outside a quoted literal`);
      prev2 = prev;
      prev = c;
    }
  }
  if (quote !== undefined) throw refuse(`leaves a ${quote} quote open`);
  if (depth > 0) throw refuse(`leaves ${depth} bracket(s) open`);
}

const isBindable = (v: unknown): boolean => v === null || ['string', 'number', 'bigint', 'boolean'].includes(typeof v) || v instanceof Date || Buffer.isBuffer(v);

const INT64 = { min: -(2n ** 63n), max: 2n ** 63n - 1n };
const isSafe = (v: bigint): boolean => v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER);

const invalidDate = (): AuthzConfigError => refuse('cannot bind an invalid Date (it would bind as NULL)');

const describeValue = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'an array' : typeof v === 'object' ? `an object (${(v as object).constructor?.name ?? 'no prototype'})` : typeof v);

/** SQL text with late-bound column references (`sql` tag of `@spinajs/authz-orm/native`). */
export class SqlFragment {
  readonly parts: readonly Part[];

  constructor(strings: readonly string[], values: readonly unknown[]) {
    const parts: Part[] = [];
    const bind = (v: unknown, what: string) => {
      if (!isBindable(v)) throw refuse(`cannot bind ${describeValue(v)} ${what}; pass a string, number, bigint, boolean, null, Date or Buffer`);
      if (v instanceof Date && Number.isNaN(v.getTime())) throw invalidDate();
      if (typeof v === 'bigint' && (v < INT64.min || v > INT64.max)) throw refuse(`cannot bind ${v}n, outside the 64-bit integers SQLite holds exactly`);
      parts.push(new Bound(v));
    };
    strings.forEach((s, i) => {
      parts.push(s);
      if (i >= values.length) return;
      const v = values[i];
      if (v instanceof SqlFragment) parts.push(...v.parts);
      else if (v instanceof OuterColumn || v instanceof Identifier) parts.push(v);
      else if (Array.isArray(v)) {
        // One binding per element: `IN (${list})`. Empty, it would render `IN ()`.
        if (v.length === 0) throw refuse('cannot bind an empty array; test the empty list in the compiler (IN of nothing is FALSE)');
        v.forEach((x, j) => {
          if (j > 0) parts.push(', ');
          bind(x, 'as an array element');
        });
      } else bind(v, 'as a value');
    });
    assertContained(parts);
    this.parts = parts;
  }
}

/**
 * node-sqlite3 binds a Date as a REAL (epoch ms) and a bigint as NULL, while the orm stores datetimes
 * as TEXT, which SQLite sorts above every number. So a Date goes through the connection's datetime
 * converter (the form the orm writes) and a bigint becomes a number when exact, else its decimal
 * text, which `placeholderOf` casts back to an integer.
 */
function bindingOf(value: unknown, driver: OrmDriver): unknown {
  if (value instanceof Date) {
    // The fragment checked the Date, but a Date can be made invalid after that.
    if (Number.isNaN(value.getTime())) throw invalidDate();
    const text: unknown = driver.Container.resolve<DatetimeValueConverter>(DatetimeValueConverter).toDB(value, undefined as never, undefined as never);
    if (text === null || text === undefined) throw refuse(`cannot bind ${value.toISOString()}, a Date the orm cannot store (it would bind as NULL)`);
    return text;
  }
  if (typeof value === 'bigint') return isSafe(value) ? Number(value) : value.toString();
  return value;
}

// Text compares as text where the other operand has no integer affinity (SQLite) or no type (PG).
function placeholderOf(value: unknown, driver: OrmDriver): string {
  if (typeof value !== 'bigint' || isSafe(value)) return '?';
  return dialectFor(driver).name === 'sqlite' ? 'CAST(? AS INTEGER)' : 'CAST(? AS bigint)';
}

/** A `SqlFragment` in a native builder, a correlatedQuery sub-query or a where group of either, parenthesised. */
export class NativeSql extends QueryStatement {
  constructor(private readonly holder: object, private readonly fragment: SqlFragment) {
    super();
  }

  build(): IQueryStatementResult {
    const root = nativeRootOf(this.holder);
    const outer = root?.TableAlias || root?.Table;
    if (root === undefined || !outer) throw lost('an SQL fragment');
    const q = quoterOf(root);
    const bindings: unknown[] = [];
    const text = this.fragment.parts
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p instanceof OuterColumn) return `${q(outer)}.${q(p.column)}`;
        if (p instanceof Identifier) return p.names.map(q).join('.');
        bindings.push(bindingOf(p.value, root.site.driver));
        return placeholderOf(p.value, root.site.driver);
      })
      .join('');
    return { Statements: [`(${text})`], Bindings: bindings };
  }

  clone<T>(parent?: T): IQueryStatement {
    const copy = new NativeSql((parent ?? this.holder) as object, this.fragment);
    copy.Boolean = this.Boolean;
    return copy;
  }
}
