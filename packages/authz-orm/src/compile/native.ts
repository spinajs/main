import { AuthzConfigError } from '@spinajs/authz';
import { IdentifierQuoter, JoinStatement, LazyQueryStatement, QueryStatement, WhereBoolean, WhereBuilder, WhereQueryStatement } from '@spinajs/orm';
import type { IQueryStatement, IQueryStatementResult, IWhereBuilder, OrmDriver, SelectQueryBuilder } from '@spinajs/orm';

import type { ModelClass } from '../registry.js';
import { AuthzStatement, shieldGroup } from '../shield.js';

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

/**
 * A correlatedQuery sub-query compiles `correlations AND (the rest)`. With no correlation at its top
 * level (they sit in where groups, or in SQL fragments), an OR there would reach around them.
 */
export function assertTopLevelAnd(sub: object): void {
  const statements = rawStatements(sub);
  if (statements.some((s) => s instanceof NativeCorrelation)) return;
  if (statements.slice(1).some((s) => s.Boolean === WhereBoolean.OR)) throw new AuthzConfigError('authz-orm: a correlatedQuery sub-query with no correlate() at its top level has an orWhere there, which reaches around the correlations in its where groups; put the OR inside a where group');
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

/** SQL text with late-bound column references (`sql` tag of `@spinajs/authz-orm/native`). */
export class SqlFragment {
  readonly parts: readonly Part[];

  constructor(strings: readonly string[], values: readonly unknown[]) {
    const parts: Part[] = [];
    strings.forEach((s, i) => {
      parts.push(s);
      if (i >= values.length) return;
      const v = values[i];
      if (v instanceof SqlFragment) parts.push(...v.parts);
      else if (v instanceof OuterColumn || v instanceof Identifier) parts.push(v);
      else parts.push(new Bound(v));
    });
    this.parts = parts;
  }
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
        bindings.push(p.value);
        return '?';
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
